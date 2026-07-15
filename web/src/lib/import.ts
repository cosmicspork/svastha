// Client-side EHR import: turn an Epic IHE_XDM zip package, a standalone
// C-CDA XML, or a FollowMyHealth FHIR R4 Bundle JSON into draft events,
// dedup them against the local event log by content-addressed id (analyze),
// then sign and store the new ones plus a verbatim provenance blob per source
// document (commit). See docs/ARCHITECTURE.md, "Data model and interop".
//
// Mirrors sync.ts's shape: the wasm-backed mapping/id calls go through a
// narrow, injectable `ImportBackend` interface (like `BlobClient`/`SealKey`
// there), so `analyzeFiles`'s file-type detection, XDM path filtering, sha256
// hashing, and totals math are all plain-TS-testable under vitest with a fake
// backend and no wasm. `commitImport` dynamically imports session.svelte.ts
// (see sync.ts's module doc comment on why: that module's top-level `$state`
// rune would crash a plain vitest import if this file depended on it
// statically) — it's the one function here that needs a real unlocked session
// and is exercised by e2e, not unit tests.
import { unzip } from 'fflate'
import { get, put } from './db'
import { enqueue, drain } from './sync'
import type { StoredEvent } from './events'
import type { Code } from './codes'
import type { EventKind, EventValue } from './drafts'

// --- wasm backend (injectable) ---

/** The wasm import surface this module needs — narrower than `svastha.ts`'s
 * full export list so tests can supply a fake, same pattern as sync.ts's
 * `BlobClient`/`SealKey`. Each function throws on malformed input (wasm
 * `Result::Err` surfaces as a thrown `JsError`). */
export interface ImportBackend {
  import_ccda(xml: string): string
  import_fhir(json: string): string
  event_id(contentJson: string): string
}

let backend: ImportBackend | null = null

export function configureImportBackend(b: ImportBackend): void {
  backend = b
}

// --- shapes ---

/** Mirrors `svastha_import::EventDraft` (Rust) field-for-field. */
export interface EventDraft {
  kind: EventKind
  code: Code | null
  effective_at: string | null
  value: EventValue | null
}

/** Mirrors `svastha_import::Skipped`. */
export interface SkippedEntry {
  what: string
  why: string
}

/** Mirrors `svastha_import::ImportResult` — the raw wasm output for one
 * document, before dedup accounting. */
interface RawImportResult {
  events: EventDraft[]
  warnings: string[]
  skipped: SkippedEntry[]
}

/** One source document found in the dropped files, ready to analyze. */
interface SourceDoc {
  /** Display name: the zip entry path for an XDM document, or the file's own
   * name otherwise. Also becomes part of the event provenance label on
   * commit, so it should stay human-identifiable. */
  name: string
  bytes: Uint8Array
  kind: 'ccda' | 'fhir'
}

/** The reviewable plan for one source document. */
export interface DocPlan {
  name: string
  sha256: string
  drafts: EventDraft[]
  /** Parallel to `drafts` — the content-addressed id each draft would get.
   * Computed once here so `commitImport` never recomputes it. */
  draftIds: string[]
  warnings: string[]
  skipped: SkippedEntry[]
  newCount: number
  dupCount: number
  bytes: Uint8Array
  /** The projected `doc-` provenance blob would exceed the relay's body cap,
   * so it can't sync — the document is kept locally and its facts still import,
   * only its verbatim provenance blob stays on this device. Surfaced as a
   * per-document warning in the import summary. */
  tooLargeToSync: boolean
}

// The relay rejects any request body over 16 MiB (crates/relay MAX_BODY). A
// `doc-` provenance blob is the source bytes base64'd inside a small JSON
// envelope (see sync.ts's provenance codec), then AEAD-sealed — base64 inflates
// the raw bytes ~4/3, and the seal adds a fixed nonce+tag.
export const RELAY_MAX_BLOB_BYTES = 16 * 1024 * 1024
// XChaCha20-Poly1305 nonce (24) + tag (16), per crates/core/src/envelope.rs.
const SEAL_OVERHEAD_BYTES = 24 + 16

/** Honest projection of the sealed `doc-` blob's byte size the relay would see
 * for a source document, so an over-cap document is flagged at analyze time
 * instead of failing a push silently later. */
export function projectedDocBlobBytes(name: string, byteLength: number): number {
  const base64Len = Math.ceil(byteLength / 3) * 4
  const envelopeSansBytes = new TextEncoder().encode(JSON.stringify({ name, bytes: '' })).length
  return envelopeSansBytes + base64Len + SEAL_OVERHEAD_BYTES
}

export interface ImportTotals {
  newCount: number
  dupCount: number
  warnings: number
  skipped: number
}

export interface ImportPlan {
  docs: DocPlan[]
  totals: ImportTotals
}

// --- file-type detection and XDM unpacking (pure; no wasm) ---

/** Only `DOC*.XML` files under an `IHE_XDM/{subset}/` directory are
 * documents — an IHE_XDM package also carries `STYLE.XSL`, `INDEX.HTM`, a
 * README, and an `HTML/` asset directory, none of which are clinical content.
 * Not anchored to the zip root: some exporters nest `IHE_XDM/` under a
 * wrapping folder. */
const XDM_DOC_PATTERN = /(^|\/)IHE_XDM\/[^/]+\/DOC[^/]*\.XML$/i

/** Unzip an IHE_XDM package and pull out its C-CDA documents. Exported for
 * the vitest path-filtering test (loads the committed `fixtures/xdm/`
 * fixture from disk — see `fixtures/README.md`). */
export function docsFromZip(bytes: Uint8Array): Promise<SourceDoc[]> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, entries) => {
      if (err) {
        reject(err)
        return
      }
      const docs: SourceDoc[] = []
      for (const [path, data] of Object.entries(entries)) {
        if (XDM_DOC_PATTERN.test(path)) {
          docs.push({ name: path, bytes: data, kind: 'ccda' })
        }
      }
      resolve(docs)
    })
  })
}

/** Classify one dropped file into its source document(s): a `.zip` may
 * contain several C-CDA documents, `.xml`/`.json` are each exactly one. */
export async function docsFromFile(file: File): Promise<SourceDoc[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lower = file.name.toLowerCase()

  if (lower.endsWith('.zip')) return docsFromZip(bytes)
  if (lower.endsWith('.json')) return [{ name: file.name, bytes, kind: 'fhir' }]
  return [{ name: file.name, bytes, kind: 'ccda' }]
}

/** SHA-256 of the verbatim source bytes, hex — the provenance blob's key and
 * the `source_doc` an imported event's provenance points back to. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The cast bridges TS's generic `Uint8Array<ArrayBufferLike>` and DOM's
  // `BufferSource` union (same shape as relay.ts's `fetch` body cast) — a
  // plain Uint8Array is a valid digest input at runtime.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Sum per-doc counts into the plan's grand totals. Exported (rather than
 * folded into `analyzeFiles`) so the aggregation math is independently
 * testable without wasm or IndexedDB. */
export function totalsOf(docs: DocPlan[]): ImportTotals {
  return docs.reduce(
    (acc, d) => ({
      newCount: acc.newCount + d.newCount,
      dupCount: acc.dupCount + d.dupCount,
      warnings: acc.warnings + d.warnings.length,
      skipped: acc.skipped + d.skipped.length,
    }),
    { newCount: 0, dupCount: 0, warnings: 0, skipped: 0 },
  )
}

// --- analyze (needs the wasm backend + the local event log) ---

/** The dummy provenance `event_id` needs to satisfy wasm's `EventContent`
 * shape — the content id excludes provenance entirely, so its value here
 * never affects the computed id (see `crates/core/src/event.rs`). */
const DRY_RUN_PROVENANCE = { source: '', source_doc: null }

/**
 * @param seenInBatch Ids already counted "new" by an earlier document in this
 *   same `analyzeFiles` call, so a fact repeated across documents in one
 *   drop — the exact overlap a 70-document Epic export is full of — counts as
 *   new only once, matching what `commitImport` will actually store (it
 *   signs each id at most once too, since by the time it reaches a later
 *   document, an earlier one in the same commit has already stored it).
 *   Mutated in place: a draft counted new here is added before returning.
 */
async function analyzeDoc(doc: SourceDoc, seenInBatch: Set<string>): Promise<DocPlan> {
  if (!backend) throw new Error('Import backend not configured.')

  const sha256 = await sha256Hex(doc.bytes)
  const text = new TextDecoder().decode(doc.bytes)
  const resultJson = doc.kind === 'ccda' ? backend.import_ccda(text) : backend.import_fhir(text)
  const result = JSON.parse(resultJson) as RawImportResult

  const draftIds: string[] = []
  let newCount = 0
  let dupCount = 0
  for (const draft of result.events) {
    const content = {
      kind: draft.kind,
      code: draft.code,
      effective_at: draft.effective_at,
      value: draft.value,
      provenance: DRY_RUN_PROVENANCE,
    }
    const id = backend.event_id(JSON.stringify(content))
    draftIds.push(id)
    if (seenInBatch.has(id) || (await get('events', id)) !== undefined) {
      dupCount++
    } else {
      newCount++
      seenInBatch.add(id)
    }
  }

  return {
    name: doc.name,
    sha256,
    drafts: result.events,
    draftIds,
    warnings: result.warnings,
    skipped: result.skipped,
    newCount,
    dupCount,
    bytes: doc.bytes,
    tooLargeToSync: projectedDocBlobBytes(doc.name, doc.bytes.length) > RELAY_MAX_BLOB_BYTES,
  }
}

/**
 * Detect, unpack, and map every dropped file, then check each draft against
 * the local event log (and against every other document in this same drop)
 * for dedup. `onProgress` reports documents analyzed so far (a 70-document
 * Epic export needs visible progress) — counted per *document*, not per file,
 * since one zip expands to many.
 */
export async function analyzeFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportPlan> {
  const sourceDocs: SourceDoc[] = []
  for (const file of files) {
    sourceDocs.push(...(await docsFromFile(file)))
  }

  const docs: DocPlan[] = []
  const seenInBatch = new Set<string>()
  for (const doc of sourceDocs) {
    docs.push(await analyzeDoc(doc, seenInBatch))
    onProgress?.(docs.length, sourceDocs.length)
  }

  return { docs, totals: totalsOf(docs) }
}

// --- commit ---

export interface CommitProgress {
  doc: string
  index: number
  total: number
}

/**
 * Sign and store every new (non-dup) draft across the plan's documents, plus
 * one verbatim provenance blob per document. Each event's provenance labels
 * its source document by name and sha256, so a later re-derivation (or just a
 * "where did this come from") can point back to it. Returns the ids of every
 * event actually stored (new; dups are left untouched, not re-signed).
 *
 * Reuses sync.ts's outbox (`enqueue`/`drain`) rather than logEvent's
 * `onEventsLogged` hook: signing happens directly here (not through
 * `logEvent`), so that hook never fires for imported events — the blobs are
 * enqueued explicitly instead, one `doc-` id per document plus one `ev-` id
 * per newly stored event.
 */
export async function commitImport(plan: ImportPlan, onProgress?: (p: CommitProgress) => void): Promise<string[]> {
  // Dynamic import — see this module's doc comment on why session.svelte.ts
  // (a `$state`-rune module) is never a static import here.
  const { session } = await import('./session.svelte')
  const identity = session.identity
  if (!identity) throw new Error('Session is locked — cannot sign events.')

  const storedIds: string[] = []
  for (const [i, doc] of plan.docs.entries()) {
    await put('provenance', {
      sha256: doc.sha256,
      name: doc.name,
      bytes: doc.bytes,
      importedAt: new Date().toISOString(),
    })
    // The provenance blob syncs unless it's over the relay's body cap: then
    // it's kept locally (still queryable on this device) rather than enqueued
    // to fail its push forever. The document's facts (ev- blobs below) sync
    // regardless — only this one verbatim blob is affected.
    if (!doc.tooLargeToSync) await enqueue([`doc-${doc.sha256}`])

    const newBlobIds: string[] = []
    for (let j = 0; j < doc.drafts.length; j++) {
      const id = doc.draftIds[j]
      if ((await get('events', id)) !== undefined) continue // dup — already in the log

      const draft = doc.drafts[j]
      const content = {
        kind: draft.kind,
        code: draft.code,
        effective_at: draft.effective_at,
        value: draft.value,
        provenance: { source: `import:${doc.name}`, source_doc: doc.sha256 },
      }
      const signed = JSON.parse(identity.sign_event(JSON.stringify(content))) as StoredEvent
      await put('events', signed)
      storedIds.push(signed.event.id)
      newBlobIds.push(`ev-${signed.event.id}`)
    }

    if (newBlobIds.length) await enqueue(newBlobIds)
    onProgress?.({ doc: doc.name, index: i + 1, total: plan.docs.length })
  }

  void drain()
  return storedIds
}
