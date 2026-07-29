// Relay sync engine: after every signed event, seal it under the vault key
// and push it to the relay; pull namespaces this device doesn't have yet.
// There is no manifest (see docs/ARCHITECTURE.md, "Sync and backup"): the
// relay only lists blob ids, and the diff below (against the local `sync`
// outbox and the `events` store) is what converges two devices.
//
// This module deliberately does not import session.svelte.ts (or events.ts's
// runtime — only its type), because both ultimately depend on Svelte's
// `$state` rune, which is compiled by Vite's svelte plugin. vitest.config.ts
// runs plain TS unit tests without that plugin (see its comment), so pulling
// a rune module in transitively would crash at import time. Callers pass the
// relay client and vault key in explicitly (`syncInit`), and the one
// unavoidable runtime hook into events.ts (`setOnEventsLogged`) is wired via
// a dynamic import, touched only by real app code, never by a test that
// imports this module to exercise the diff/queue functions below.
import { get, put, getAll } from './db'
import { verify_event } from './svastha'
import type { StoredEvent } from './events'
import type { ConditionalBlob } from './relay'
import { writable } from 'svelte/store'
import { pullShared, teardownSharing } from './shared'
import { pullMailbox, teardownMailbox } from './mailbox'
import { bytesToBase64, base64ToBytes } from './base64'
import { runEventStream } from './events-stream'
import { BATCH_PULL_THRESHOLD, BATCH_PULL_MIN_RATIO, type BlobBodyPage } from './blob-batch'

/** The relay surface this engine needs — narrower than `RelayClient` so
 * tests can supply an in-memory fake without fighting `RelayClient`'s
 * private-field nominal typing. `RelayClient` satisfies this structurally. */
export interface BlobClient {
  putBlob(id: string, blob: Uint8Array): Promise<void>
  getBlob(id: string): Promise<Uint8Array | null>
  listBlobs(): Promise<string[]>
}

/** The vault-key surface this engine needs. `WasmDataKey` satisfies this
 * structurally. */
export interface SealKey {
  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array
}

/** The optional push-channel surface. `RelayClient` satisfies it; a bare
 * `BlobClient` test fake does not, so the SSE stream simply never starts under
 * unit tests (the poll timer alone drives them, as before). */
interface StreamClient {
  openEventStream(signal: AbortSignal): Promise<Response>
}

/** The optional etag-aware fetch surface (see `spec/README.md`, "Curation
 * etags"). `RelayClient` satisfies it; a bare `BlobClient` test fake does not,
 * so a mutable id's pull simply always re-applies under unit tests — the same
 * graceful-degradation pattern as {@link StreamClient} above. Only worth using
 * for a `mutable` codec (today, `cur-`): an immutable id is never re-fetched
 * once applied, so it never reaches this path regardless. */
interface ConditionalGetClient {
  getBlobConditional(id: string, ifNoneMatch: string | null): Promise<ConditionalBlob>
}

function supportsConditionalGet(client: BlobClient): client is BlobClient & ConditionalGetClient {
  return typeof (client as Partial<ConditionalGetClient>).getBlobConditional === 'function'
}

/** The optional batched-listing surface (`?include=body`; see `spec/README.md`,
 * "Batched fetch"), which returns a page's ids AND their ciphertext in one
 * response instead of one signed — preflight-triggering — round trip per id.
 * `RelayClient` satisfies it; a bare `BlobClient` test fake does not, so a pull
 * under unit tests simply stays on the per-id path — the same
 * graceful-degradation pattern as {@link StreamClient} and
 * {@link ConditionalGetClient} above. */
interface BatchListClient {
  listBlobsWithBodies(cursor: string | null, limit?: number): Promise<BlobBodyPage>
}

function supportsBatchList(client: BlobClient): client is BlobClient & BatchListClient {
  return typeof (client as Partial<BatchListClient>).listBlobsWithBodies === 'function'
}

/** A namespace plug-in. `doc-` and `cur-` arrive in later PRs and register
 * here the same way the events codec (below) does. */
export interface Codec {
  prefix: string
  /**
   * `ev-`/`doc-` blob ids are content-addressed: once a device has pushed or
   * pulled one, that id's content can never change, so "already handled" is
   * permanent (`idsToPull`'s `doneIds` filtering, and `pullAll`'s
   * `localHas`-then-skip below, both lean on this). `cur-` blobs are the one
   * namespace where that's false — the SAME id gets `PUT` over with new
   * content on every write (see docs/ARCHITECTURE.md's "Curation overlay").
   * Setting `mutable: true` opts a codec out of both of those
   * once-and-done shortcuts: its ids are always re-pulled (never filtered by
   * `doneIds`), always re-fetched-and-applied (never skipped just because
   * `localHas` is true), and always re-enqueued by a fresh local write (never
   * skipped by `enqueue`'s "already done" check). Defaults to `false`.
   */
  mutable?: boolean
  localHas(id: string): Promise<boolean>
  localLoad(id: string): Promise<Uint8Array | null>
  remoteApply(id: string, plaintext: Uint8Array): Promise<void>
}

const codecs: Codec[] = []

export function registerCodec(codec: Codec): void {
  codecs.push(codec)
}

function codecFor(id: string): Codec | undefined {
  return codecs.find((c) => id.startsWith(c.prefix))
}

function isMutableId(id: string): boolean {
  return codecFor(id)?.mutable === true
}

/** Every vault-key-sealed blob is bound to its own id as AAD: a malicious
 * relay must not be able to swap ciphertext between two blob ids
 * undetected. */
function aad(blobId: string): Uint8Array {
  return new TextEncoder().encode(blobId)
}

function eventBlobId(eventId: string): string {
  return `ev-${eventId}`
}

function eventIdFromBlobId(blobId: string): string {
  return blobId.slice('ev-'.length)
}

const eventsCodec: Codec = {
  prefix: 'ev-',
  async localHas(id) {
    return (await get('events', eventIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const stored = await get<StoredEvent>('events', eventIdFromBlobId(id))
    return stored ? new TextEncoder().encode(JSON.stringify(stored)) : null
  },
  async remoteApply(id, plaintext) {
    const eventId = eventIdFromBlobId(id)
    const json = new TextDecoder().decode(plaintext)
    // A malicious relay must not be able to inject or swap events: the
    // signature must verify, AND the embedded id must equal the blob id it
    // was fetched under (`aad` above binds the sealing; this binds content).
    if (!verify_event(json)) throw new Error(`ev- blob ${id}: signature does not verify`)
    const signed = JSON.parse(json) as StoredEvent
    if (signed.event.id !== eventId) throw new Error(`ev- blob ${id}: embedded id does not match`)
    await put('events', signed)
  },
}
registerCodec(eventsCodec)

// --- provenance codec ('doc-') ---
//
// One entry per imported source document (see `import.ts`): the verbatim
// bytes, kept so parsers can re-derive facts as the mapping improves (see
// docs/ARCHITECTURE.md, "Data model and interop"), plus its display name. The
// wire payload is a small JSON envelope (name + base64 bytes) rather than raw
// bytes with an ad hoc binary header — it reuses the same "JSON blob, sealed
// under the vault key" shape as every other namespace here instead of
// inventing a framing just for this one.

export interface ProvenanceRecord {
  sha256: string
  name: string
  bytes: Uint8Array
  importedAt: string
}

function provenanceIdFromBlobId(blobId: string): string {
  return blobId.slice('doc-'.length)
}

/** Duplicated from import.ts's own `sha256Hex` rather than imported: import.ts
 * imports enqueue/drain from this module, and this module importing back from
 * import.ts would make the two circular. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const provenanceCodec: Codec = {
  prefix: 'doc-',
  async localHas(id) {
    return (await get<ProvenanceRecord>('provenance', provenanceIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const doc = await get<ProvenanceRecord>('provenance', provenanceIdFromBlobId(id))
    if (!doc) return null
    const envelope = JSON.stringify({ name: doc.name, bytes: bytesToBase64(doc.bytes) })
    return new TextEncoder().encode(envelope)
  },
  async remoteApply(id, plaintext) {
    const sha256 = provenanceIdFromBlobId(id)
    const { name, bytes: b64 } = JSON.parse(new TextDecoder().decode(plaintext)) as { name: string; bytes: string }
    const bytes = base64ToBytes(b64)
    // Mirrors the ev- codec's embedded-id check: the AAD binding already
    // stops the relay from swapping ciphertext between blob ids, but this
    // additionally guards against a same-device bug (e.g. a document pushed
    // under the wrong sha256) ever landing silently.
    const actual = await sha256Hex(bytes)
    if (actual !== sha256) throw new Error(`doc- blob ${id}: content hash does not match the blob id`)
    await put('provenance', { sha256, name, bytes, importedAt: new Date().toISOString() })
  },
}
registerCodec(provenanceCodec)

// --- attachments codec ('att-') ---
//
// One entry per captured document page (see `attachments.ts`): the downscaled
// JPEG bytes of a photographed paper record, content-addressed by the SHA-256
// of those plaintext bytes. Modeled exactly on the `doc-` codec above — same
// "JSON envelope (mime + base64 bytes) sealed under the vault key, AAD = blob
// id" shape, same embedded-hash check — because a captured document is the same
// kind of opaque, immutable, content-addressed blob an imported source document
// is. The `attachment` event value carries the sha256, so a synced event points
// at the `att-` blob its bytes live in.

interface AttachmentRow {
  sha256: string
  mime: string
  size: number
  bytes: Uint8Array
  capturedAt: string
}

function attachmentIdFromBlobId(blobId: string): string {
  return blobId.slice('att-'.length)
}

const attachmentsCodec: Codec = {
  prefix: 'att-',
  async localHas(id) {
    return (await get<AttachmentRow>('attachments', attachmentIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const att = await get<AttachmentRow>('attachments', attachmentIdFromBlobId(id))
    if (!att) return null
    const envelope = JSON.stringify({ mime: att.mime, bytes: bytesToBase64(att.bytes) })
    return new TextEncoder().encode(envelope)
  },
  async remoteApply(id, plaintext) {
    const sha256 = attachmentIdFromBlobId(id)
    const { mime, bytes: b64 } = JSON.parse(new TextDecoder().decode(plaintext)) as {
      mime: string
      bytes: string
    }
    const bytes = base64ToBytes(b64)
    // Same embedded-hash guard the doc- codec makes: the AAD binding already
    // stops the relay swapping ciphertext between ids, and this additionally
    // catches a same-device bug (bytes stored under the wrong sha256) rather
    // than letting it land silently.
    const actual = await sha256Hex(bytes)
    if (actual !== sha256) throw new Error(`att- blob ${id}: content hash does not match the blob id`)
    await put('attachments', {
      sha256,
      mime,
      size: bytes.length,
      bytes,
      capturedAt: new Date().toISOString(),
    })
  },
}
registerCodec(attachmentsCodec)

// --- pure diff functions (unit tested without wasm or a browser) ---

/** Blob ids on the relay this device should pull: known to a registered
 * codec, and either not already applied locally or (see `Codec.mutable`'s
 * doc comment) belonging to a namespace that must be re-checked every pull
 * regardless of `doneIds`. */
export function idsToPull(remoteIds: string[], doneIds: ReadonlySet<string>): string[] {
  return remoteIds.filter((id) => codecFor(id) !== undefined && (isMutableId(id) || !doneIds.has(id)))
}

/** Local events missing from the relay's list — these need pushing so a
 * second device converges without a manifest (restore-then-log-on-two-devices
 * agreement). */
export function idsToPush(
  localEventIds: string[],
  remoteIds: ReadonlySet<string>,
  doneIds: ReadonlySet<string>,
): string[] {
  return localEventIds
    .map(eventBlobId)
    .filter((blobId) => !remoteIds.has(blobId) && !doneIds.has(blobId))
}

// --- single-blob open/seal primitives ---
//
// The verify+store and load+seal steps of a pull/push, factored out of
// `pullAll`/`pushOne` so a file import (export.ts) can run each sealed blob
// through the exact same codec path a relay pull uses — same open, same
// embedded-id/signature checks, same LWW merge — without going through the
// outbox (which would mark applied ids `done` and wrongly suppress a later
// push of imported blobs). `aad`/`codecFor`/`codecs` stay private; these are
// the sanctioned entry points.

export type ApplyOutcome = 'new' | 'duplicate' | 'merged' | 'unknown'

/** Open one sealed blob (AAD = its id) and apply it through its codec's
 * verify+store path — the same path `pullAll` uses. Does NOT touch the outbox.
 * An immutable id already applied locally is a `duplicate` (opened bytes are
 * redundant, so it's skipped without opening); a mutable id is always opened
 * and re-merged (`merged`); anything else opened is `new`. Errors (bad open,
 * failed signature, hash mismatch) propagate. */
export async function applySealedBlob(id: string, sealed: Uint8Array, key: SealKey): Promise<ApplyOutcome> {
  const codec = codecFor(id)
  if (!codec) return 'unknown'
  if (!codec.mutable && (await codec.localHas(id))) return 'duplicate'
  const plaintext = key.open(sealed, aad(id))
  await codec.remoteApply(id, plaintext)
  return codec.mutable ? 'merged' : 'new'
}

/** Load one blob's local plaintext through its codec and seal it (AAD = id) —
 * `pushOne` minus the relay PUT. Null when nothing local exists under the id
 * (no codec, or the codec has no local record). */
export async function sealLocalBlob(id: string, key: SealKey): Promise<Uint8Array | null> {
  const codec = codecFor(id)
  const plaintext = codec ? await codec.localLoad(id) : null
  if (!plaintext) return null
  return key.seal(plaintext, aad(id))
}

/** Every blob id representable from this device's local data: an `ev-` per
 * event, a `doc-` per provenance record, an `att-` per captured attachment, a
 * `cur-` per curation key. `vault.key` is deliberately excluded — it is not a
 * codec (it is the wrapped key itself, carried separately by the export
 * container). */
export async function listLocalBlobIds(): Promise<string[]> {
  const events = (await getAll<StoredEvent>('events')).map((e) => eventBlobId(e.event.id))
  const docs = (await getAll<ProvenanceRecord>('provenance')).map((p) => `doc-${p.sha256}`)
  const attachments = (await getAll<AttachmentRow>('attachments')).map((a) => `att-${a.sha256}`)
  // Dynamic import for the same reason `configure` above imports curation.ts
  // dynamically: curation.ts statically imports this module, so a static
  // import back would form a cycle.
  const { curationBlobIdForKey } = await import('./curation')
  const curationRecords = await getAll<{ key: string }>('curation')
  const curation = await Promise.all(curationRecords.map((r) => curationBlobIdForKey(r.key)))
  return [...events, ...docs, ...attachments, ...curation]
}

// --- status surface ---
//
// A plain Svelte store (not a `.svelte.ts` rune module) for the same reason
// as the module doc comment above: `svelte/store`'s `writable` is a regular
// function export, not a compiler macro, so it works under plain vitest.
// Settings.svelte reads it with `$syncStatus`.

export interface SyncStatusValue {
  configured: boolean
  online: boolean
  /** Whether the relay itself was reachable on the last attempt — distinct from
   * `online` (which is only `navigator.onLine`, the browser's view of the local
   * link). `null` before the first attempt. A dead/misconfigured relay is
   * `online: true, reachable: false`, so the UI stops falsely reading "Online".
   * Set true on any successful relay call, false on a network-level fetch
   * failure; an HTTP/app error still counts as "reached" (true). */
  reachable: boolean | null
  pendingCount: number
  lastPullAt: string | null
  lastError: string | null
  // Applied-during-the-current-pull counter, reset at the start of each
  // `pullAll()`. Onboard's restore-with-relay flow reads this for a "N so
  // far" progress line; nothing else needs it, so it's not otherwise wired.
  pulledCount: number
}

// `navigator.onLine` is a browser API; under vitest/Node it's either absent
// or present-but-`undefined` (as opposed to explicitly `false`), so treat
// anything other than an explicit `false` as online.
function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/** A rejected `fetch()` is a `TypeError` ("Load failed" in Safari, "Failed to
 * fetch" in Chromium) — a network-level failure the relay never answered. An
 * HTTP or app error is thrown here as a plain `Error` (e.g. `listBlobs: 500`),
 * so this cleanly separates "couldn't reach the relay" from "the relay said
 * no". */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

/** A human message for the status line — a raw `TypeError: Load failed` means
 * nothing to a user. Mirrors relay.ts's `checkRelayInfo` copy. Non-network
 * errors keep their detail (a status code is actionable). */
function describeError(err: unknown): string {
  if (isNetworkError(err)) return 'Could not reach the relay — check the address and your connection.'
  return String(err)
}

export const syncStatus = writable<SyncStatusValue>({
  configured: false,
  online: isOnline(),
  reachable: null,
  pendingCount: 0,
  lastPullAt: null,
  lastError: null,
  pulledCount: 0,
})

function patchStatus(partial: Partial<SyncStatusValue>): void {
  syncStatus.update((s) => ({ ...s, ...partial }))
}

/** Record a successful round trip: the relay is reachable, and a stale error
 * (if any) is cleared. */
function noteContact(): void {
  patchStatus({ reachable: true, lastError: null })
}

/** Record a failed relay call, mapping it to a friendly message and updating
 * reachability (a network failure means unreachable; an HTTP error still
 * reached the relay). */
function noteFailure(err: unknown): void {
  patchStatus({ lastError: describeError(err), reachable: isNetworkError(err) ? false : true })
}

/** Report a failure raised outside the engine — today, a `connectRelay` that
 * rejected before `syncInit` could run. That rejection is otherwise a floating
 * promise: the engine never starts, so `pullAll` returns at its own guard and
 * every later "Sync now" is a silent no-op with nothing in the UI to explain
 * it. */
export function noteSyncFailure(err: unknown): void {
  noteFailure(err)
}

interface SyncRecord {
  id: string
  state: 'pending' | 'done'
  updated_at: string
  /** The relay's `ETag` from this id's last successful pull, sent back as
   * `If-None-Match` on the next one (mutable ids only — see
   * {@link ConditionalGetClient}). Absent for every non-`cur-` id, and for a
   * `cur-` id until its first successful fetch. */
  etag?: string
}

/** Capped exponential backoff for a failing push: 1s, 5s, 30s, then give up
 * and wait for the next external trigger (an enqueue, the 'online' event, or
 * the next scheduled pull) rather than retrying forever unattended. */
export const BACKOFF_SCHEDULE_MS = [1000, 5000, 30_000]

async function refreshPendingCount(): Promise<void> {
  const all = await getAll<SyncRecord>('sync')
  patchStatus({ pendingCount: all.filter((r) => r.state === 'pending').length })
}

/** Serializes every write to the `sync` store. `markPulled` below has to decide
 * "is this id already queued for a push?" and act on that decision, and the read
 * and the write are separate IDB transactions with an await between them (a
 * store handle does not survive one). Without this, an `enqueue` landing in that
 * gap is silently overwritten. Every writer of the store lives in this module,
 * so one promise chain covers all of them. */
let outboxWrites: Promise<unknown> = Promise.resolve()

function withOutbox<T>(fn: () => Promise<T>): Promise<T> {
  const next = outboxWrites.then(fn, fn)
  outboxWrites = next.catch(() => {})
  return next
}

/** Push-side completion: the relay now holds what we sealed, so the queue entry
 * is spent. Unconditional — the record is `pending` here by construction, since
 * that is how `drain` found it. */
function markDone(id: string): Promise<void> {
  return withOutbox(() => put('sync', { id, state: 'done', updated_at: new Date().toISOString() }))
}

/**
 * Pull-side completion: this device now holds the relay's copy of `id`.
 *
 * Never downgrades a `pending` record. Applying a `cur-` blob whose LOCAL value
 * wins the LWW merge re-enqueues that id (curation.ts) precisely so the relay
 * stops serving the loser; writing `done` over that entry drops the push, and
 * the winning edit then never leaves this device while every other device
 * converges on the losing value. An immutable id is never pending at this point,
 * so the check costs it nothing.
 */
function markPulled(id: string, etag?: string): Promise<void> {
  return withOutbox(async () => {
    const existing = await get<SyncRecord>('sync', id)
    if (existing?.state === 'pending') return
    await put('sync', {
      id,
      state: 'done',
      updated_at: new Date().toISOString(),
      // Carry a cached validator forward when this path has none of its own (the
      // batch walk sees no per-id etags): if it still matches, the next
      // conditional GET is a 304; if it doesn't, it's the full body that
      // dropping it would have cost unconditionally.
      etag: etag ?? existing?.etag,
    })
  })
}

/** Queue blobs for push. Already-`done` ids are left alone — re-enqueuing a
 * blob that is already confirmed on the relay would just re-push identical
 * ciphertext (harmless, but pointless).
 *
 * Deliberately does not kick `drain()` itself: callers that want the queue
 * drained right away (the events hook, `pullAll`'s reconcile step, the
 * 'online' handler) do so explicitly, one line after their `enqueue` call.
 * This keeps `enqueue` awaitable to a clean, fully-settled state — useful
 * for tests, and for anything that wants to know the queue write landed
 * without racing `drain`'s own reentrancy guard. */
export async function enqueue(blobIds: string[]): Promise<void> {
  await withOutbox(async () => {
    const now = new Date().toISOString()
    for (const id of blobIds) {
      const existing = await get<SyncRecord>('sync', id)
      // A mutable id (see `Codec.mutable`) can be 'done' from a stale pull or
      // an earlier push of an older value; a fresh local write always has
      // something new to push regardless, so it bypasses the "already done"
      // skip that's correct for a content-addressed (immutable) blob id.
      if (existing?.state === 'done' && !isMutableId(id)) continue
      await put('sync', { id, state: 'pending', updated_at: now })
    }
  })
  await refreshPendingCount()
}

async function nextPending(): Promise<SyncRecord | undefined> {
  const all = await getAll<SyncRecord>('sync')
  return all.find((r) => r.state === 'pending')
}

let relayClient: BlobClient | null = null
let vaultKey: SealKey | null = null
let draining = false

/** Wire the relay client and vault key the engine pushes/pulls through.
 * Split out from `syncInit` so tests can drive `enqueue`/`drain`/`pullAll`
 * against a mock relay without the browser-only wiring (event listeners,
 * timers, the events-hook dynamic import) `syncInit` also does. */
export function configure(relay: BlobClient, key: SealKey): void {
  relayClient = relay
  vaultKey = key
  // Dynamic import: curation.ts registers its own 'cur-' codec as a
  // top-level side effect (mirrors this file's own ev-/doc- registration
  // above) once this module is loaded. Loading it dynamically rather than
  // with a static import avoids a circular import back to this file (which
  // curation.ts imports for `registerCodec`/`enqueue`/`drain`) — the same
  // shape as `installEventsHook` below, and for the same reason.
  void import('./curation')
}

/** Push every pending outbox entry, one at a time (concurrency 1 is fine at
 * this scale — quick-log rarely produces more than a handful of events per
 * save). Stops and waits for the next trigger once a push has exhausted
 * `BACKOFF_SCHEDULE_MS`, rather than retrying unattended forever. */
export async function drain(): Promise<void> {
  if (draining || !relayClient || !vaultKey) return
  if (!isOnline()) return
  draining = true
  try {
    for (;;) {
      const pending = await nextPending()
      if (!pending) return

      let attempt = 0
      for (;;) {
        try {
          await pushOne(pending.id)
          noteContact()
          break
        } catch (err) {
          noteFailure(err)
          if (attempt >= BACKOFF_SCHEDULE_MS.length) return // wait for the next trigger
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_SCHEDULE_MS[attempt]))
          attempt++
        }
      }
    }
  } finally {
    draining = false
    await refreshPendingCount()
  }
}

async function pushOne(blobId: string): Promise<void> {
  const sealed = await sealLocalBlob(blobId, vaultKey!)
  if (!sealed) {
    // Nothing to push — deleted locally, or an id with no registered codec.
    // Mark it done so it isn't retried forever.
    await markDone(blobId)
    return
  }
  await relayClient!.putBlob(blobId, sealed)
  await markDone(blobId)
}

/**
 * List the relay, pull anything new, and enqueue any local event missing
 * remotely (the reconcile step that makes two devices converge).
 *
 * Single-flight: every trigger funnels here (the SSE poke, `visibilitychange`,
 * the 5-minute timer, Onboard's restore, "Sync now"), and concurrent pulls would
 * just re-fetch each other's ids while `pulledCount` flaps between them.
 *
 * But joining is only honest while the in-flight pull can still *serve* the new
 * trigger. Once it has taken its listing snapshot, a poke naming a blob written
 * since is invisible to it, and a silent join would leave this device stale
 * until the 5-minute timer. Such a trigger books a single re-run instead — one,
 * never a queue, however many pokes arrive.
 */
export function pullAll(): Promise<void> {
  if (pulling) {
    if (!absorbing) rerunRequested = true
    return pulling
  }
  pulling = pullUntilQuiet().finally(() => {
    pulling = null
    rerunRequested = false
  })
  return pulling
}

let pulling: Promise<void> | null = null
let rerunRequested = false
/** Whether the in-flight pull's listing is still ahead of it, so a trigger
 * arriving now is already covered by it. */
let absorbing = false

async function pullUntilQuiet(): Promise<void> {
  for (;;) {
    rerunRequested = false
    await pullOnce()
    if (!rerunRequested) return
  }
}

/** A bound on the walk itself, independent of the cursor check below: an
 * untrusted relay can also hand back a strictly-advancing cursor forever. Far
 * above any real vault's page count (the relay's own `MAX_PAGE_SIZE` puts a
 * million blobs inside this). */
const MAX_BATCH_PAGES = 1000

/**
 * Walk the relay's batched pages, applying each frame as it streams in, and
 * report which ids the caller no longer needs to fetch one at a time. `wanted`
 * is what this pull is after: the walk stops as soon as all of it is handled,
 * rather than reading the rest of a namespace this device already holds.
 *
 * "Handled" is deliberately wider than "applied": an id whose frame failed is
 * handled too, because re-fetching it per-id in the same cycle would just fail
 * the same way. It is left un-`done` instead, which is what gets it retried on
 * the next pull. Anything the walk never reached (a transport error, an old
 * relay, a truncated page, a stop) stays out of the set and falls through to the
 * per-id loop, so a partial walk is always safe.
 */
async function batchPullOwn(
  relay: BlobClient & BatchListClient,
  key: SealKey,
  wanted: ReadonlySet<string>,
): Promise<Set<string>> {
  const handled = new Set<string>()
  const outstanding = new Set(wanted)
  // A frame that failed mid-walk has to still be visible when the walk ends: a
  // later page's `noteContact` would otherwise clear the message and report a
  // clean pull that silently skipped a blob.
  let failed = false
  let cursor: string | null = null
  for (let pages = 0; ; pages++) {
    let page: BlobBodyPage
    try {
      page = await relay.listBlobsWithBodies(cursor)
      if (failed) patchStatus({ reachable: true })
      else noteContact()
    } catch (err) {
      noteFailure(err)
      return handled
    }
    if (page.kind === 'unsupported') {
      // A pre-batching relay answered the plain JSON listing. Its ids are
      // deliberately not parsed — the caller has already listed them, and the
      // per-id path it falls back to is exactly what it would have done anyway.
      return handled
    }

    try {
      for await (const { id, blob } of page.blobs) {
        // `vault.key` (and any future codec-less id) rides the same page, since
        // the relay frames whatever it lists. Nothing local applies it.
        if (!codecFor(id)) continue
        try {
          const outcome = await applySealedBlob(id, blob, key)
          if (outcome === 'unknown') continue
          await markPulled(id)
          handled.add(id)
          // A `duplicate` was never opened and changed nothing locally, so it
          // doesn't tick — matching the per-id loop's `localHas` shortcut.
          if (outcome !== 'duplicate') {
            syncStatus.update((s) => ({ ...s, pulledCount: s.pulledCount + 1 }))
          }
        } catch (err) {
          // One bad frame doesn't end the page: the rest still apply.
          noteFailure(err)
          failed = true
          handled.add(id)
        }
        // Everything this pull was after is accounted for; the rest of the
        // namespace is bytes this device already holds. Leaving the page
        // mid-stream cancels the response body (see blob-batch.ts).
        outstanding.delete(id)
        if (outstanding.size === 0) return handled
      }
    } catch (err) {
      // A truncated page (the parser's `finish()` throwing) or a mid-read
      // network error. Stop the walk — frames already applied stay applied.
      noteFailure(err)
      return handled
    }

    if (page.next === null) return handled
    // The relay is untrusted (docs/ARCHITECTURE.md). An honest one's `next` is
    // the page's own last id under a lexicographic sort (`paginate_ids`), so it
    // strictly advances; anything else — a repeated cursor, an A/B alternation —
    // spins this walk inside the single-flight promise and kills sync until the
    // tab reloads. Abort loudly instead, and let the per-id loop finish the
    // cycle.
    if (cursor !== null && page.next <= cursor) {
      noteFailure(new Error(`relay page cursor did not advance (${page.next} after ${cursor})`))
      return handled
    }
    if (pages >= MAX_BATCH_PAGES) {
      noteFailure(new Error(`relay page walk exceeded ${MAX_BATCH_PAGES} pages`))
      return handled
    }
    cursor = page.next
  }
}

/** Whether a batch walk is worth it for this pull. See
 * {@link BATCH_PULL_THRESHOLD} and {@link BATCH_PULL_MIN_RATIO} for why both a
 * floor and a share are needed. Multiplied rather than divided so an empty
 * relay can't produce a NaN. */
function shouldBatchPull(missing: number, total: number): boolean {
  return missing >= BATCH_PULL_THRESHOLD && missing >= total * BATCH_PULL_MIN_RATIO
}

async function pullOnce(): Promise<void> {
  if (!relayClient || !vaultKey) return

  absorbing = true
  let remoteIds: string[]
  try {
    remoteIds = await relayClient.listBlobs()
    noteContact()
  } catch (err) {
    noteFailure(err)
    return
  } finally {
    // Past this point the pull is working from a fixed list, so a trigger that
    // arrives now needs a run of its own (see `pullAll`).
    absorbing = false
  }

  // Everything past the relay listing is guarded as one region, and the pull is
  // stamped in `finally`. Callers invoke `pullAll` fire-and-forget
  // (`void pullAll()`), so an unguarded throw in here reaches no one: it lands
  // after `noteContact()` set "Online" but before `lastPullAt`, stranding the UI
  // on "Online, pending 0, last pull never" with no error and a "Sync now" that
  // appears to do nothing. Guarding one step at a time only moves that hazard to
  // the next unguarded await — it has bitten at the sharing pull and again at the
  // push reconcile below — so the whole region routes through `noteFailure` and
  // the timestamp is stamped either way. A visibly advancing "Last pull" is what
  // tells the user the button did something, even when the cycle errored.
  try {
    const syncRecords = await getAll<SyncRecord>('sync')
    const doneIds = new Set(syncRecords.filter((r) => r.state === 'done').map((r) => r.id))

    patchStatus({ pulledCount: 0 })
    let toPull = idsToPull(remoteIds, doneIds)
    if (shouldBatchPull(toPull.length, remoteIds.length) && supportsBatchList(relayClient)) {
      const handled = await batchPullOwn(relayClient, vaultKey, new Set(toPull))
      // Subtracting what the walk handled is what keeps the loop below from
      // immediately re-fetching a `cur-` id: being mutable, it is never
      // filtered out by `doneIds`, so without this it would take a conditional
      // GET one round trip after the batch already applied it.
      toPull = toPull.filter((id) => !handled.has(id))
    }
    for (const id of toPull) {
      const codec = codecFor(id)! // idsToPull only returns ids with a registered codec
      try {
        // The localHas-then-skip shortcut only makes sense for an immutable
        // id: "already have it" and "have the latest version of it" are the
        // same fact there. For a mutable id they're not (someone else may have
        // PUT a newer value over the same id), so always fetch and let the
        // codec's own remoteApply (LWW merge, for cur-) decide. This mirrors
        // `applySealedBlob`'s own duplicate check, but is kept here too so a
        // duplicate skips the `getBlob` round trip entirely.
        if (!codec.mutable && (await codec.localHas(id))) {
          // Already have it (e.g. logged before sync was configured) — record
          // done without a redundant round trip.
          await markPulled(id)
          continue
        }
        if (codec.mutable && supportsConditionalGet(relayClient)) {
          // A mutable id (today, only cur-) is always re-fetched above — the one
          // namespace worth an etag, since it's the one a client keeps asking
          // about after already having the answer. Send back whatever etag the
          // last successful fetch left, so an unchanged record costs a 304, not
          // a body (see spec/README.md, "Curation etags").
          const existing = await get<SyncRecord>('sync', id)
          const result: ConditionalBlob = await relayClient.getBlobConditional(id, existing?.etag ?? null)
          if (result.status === 'missing') continue
          if (result.status === 'ok') {
            await applySealedBlob(id, result.blob, vaultKey)
            await markPulled(id, result.etag ?? undefined)
            syncStatus.update((s) => ({ ...s, pulledCount: s.pulledCount + 1 }))
          }
          // 'not-modified': nothing changed since `existing.etag` — already
          // `done` with that etag, so there is nothing to re-apply or re-store.
          continue
        }
        const blob = await relayClient.getBlob(id)
        if (!blob) continue
        await applySealedBlob(id, blob, vaultKey)
        await markPulled(id)
        syncStatus.update((s) => ({ ...s, pulledCount: s.pulledCount + 1 }))
      } catch (err) {
        // Left un-done on failure (bad open, failed verify, network hiccup) —
        // retried on the next pull rather than dropped.
        noteFailure(err)
      }
    }

    const localEventIds = (await getAll<StoredEvent>('events')).map((e) => e.event.id)
    const toPush = idsToPush(localEventIds, new Set(remoteIds), doneIds)
    if (toPush.length) {
      await enqueue(toPush)
      void drain()
    }

    // Sharing rides the same pull cycle: consume the mailbox (invites + proposal
    // inbox) once, then pull whatever accepted shares have new events, after this
    // device's own pull/push reconcile above.
    await pullMailbox()
    await pullShared()
  } catch (err) {
    noteFailure(err)
  } finally {
    patchStatus({ lastPullAt: new Date().toISOString() })
  }
}

const PULL_INTERVAL_MS = 5 * 60 * 1000
let pullTimer: ReturnType<typeof setInterval> | null = null

// The push channel (relay SSE). Aborting stops its reconnect loop for good.
let streamAbort: AbortController | null = null

/**
 * Bring up the relay push stream if the client supports it: a poke never
 * carries content, only *which* pull to run, so a `mailbox` poke triggers the
 * mailbox scan and a `blobs`/`sync` poke a full pull. The stream is a latency
 * shortcut layered over the authoritative poll (`pullTimer`) — lossy and
 * reconnecting on its own, so a missed poke costs nothing.
 */
function startEventStream(relay: BlobClient): void {
  const streamer = relay as Partial<StreamClient>
  if (typeof streamer.openEventStream !== 'function') return
  streamAbort = new AbortController()
  const openStream = streamer.openEventStream.bind(streamer) as StreamClient['openEventStream']
  void runEventStream({
    openStream,
    onPoke: (poke) => {
      if (poke === 'mailbox') void pullMailbox()
      else void pullAll()
    },
    signal: streamAbort.signal,
  })
}

/** Dynamically imported (see the module doc comment) so this file never
 * statically depends on events.ts's runtime. */
async function installEventsHook(): Promise<void> {
  const { setOnEventsLogged } = await import('./events')
  setOnEventsLogged((events) => {
    void enqueue(events.map((e) => eventBlobId(e.event.id))).then(() => drain())
  })
}

async function clearEventsHook(): Promise<void> {
  const { setOnEventsLogged } = await import('./events')
  setOnEventsLogged(() => {})
}

function handleOnline(): void {
  patchStatus({ online: true })
  void drain()
}

function handleOffline(): void {
  patchStatus({ online: false })
}

function handleVisibility(): void {
  if (document.visibilityState === 'visible') void pullAll()
}

/**
 * Start the sync engine for an unlocked, relay-configured session. Idempotent
 * — a second call while already configured is a no-op.
 *
 * Callers MUST have already reconciled the vault key against the relay
 * (`vault.ts`'s `ensureVaultKeyBlob`) before calling this: pushing an event
 * sealed under the wrong vault key is unrecoverable. `vault.ts`'s
 * `connectRelay` is the one place that enforces this ordering — call that,
 * not this function directly, from UI code.
 */
export function syncInit(relay: BlobClient, key: SealKey): void {
  if (relayClient) return
  configure(relay, key)
  patchStatus({
    configured: true,
    online: isOnline(),
    reachable: null,
    lastError: null,
  })

  void installEventsHook()
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }

  void pullAll()
  pullTimer = setInterval(() => void pullAll(), PULL_INTERVAL_MS)
  startEventStream(relay)
}

/** Stop the engine and forget the relay/vault key — called on lock/logout. */
export function syncTeardown(): void {
  relayClient = null
  vaultKey = null
  draining = false
  patchStatus({ configured: false })
  teardownSharing()
  teardownMailbox()
  void clearEventsHook()
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility)
  }
  if (pullTimer) clearInterval(pullTimer)
  pullTimer = null
  streamAbort?.abort()
  streamAbort = null
}
