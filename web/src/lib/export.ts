// Plaintext (unencrypted) JSON export, for programmatic comparison — e.g.
// diffing imported events against the source documents that produced them.
// This is deliberately one-way *out*: there is no plaintext import path back
// in, so the trust boundary (only signed events / vault-key-sealed curation
// ever enter the store) stays exit-only. Provenance is exported as metadata
// only (sha256/name/importedAt/size), never the original bytes — the source
// files are already large and the user already holds them; `provenance:
// { source_doc }` on each event still joins it back to the right source by
// sha256.
//
// Pure module: no static import of session.svelte.ts or the wasm bindings.
// Everything the export needs (events, curation, provenance metadata,
// contract version, "now") is passed in by the caller, so this is directly
// unit-testable under plain vitest.
import type { StoredEvent } from './events'
import type { CurationRecord } from './curation'
import type { ProvenanceRecord, SealKey, ApplyOutcome } from './sync'
import { bytesToBase64, base64ToBytes } from './base64'

export interface ProvenanceMeta {
  sha256: string
  name: string
  importedAt: string
  size: number
}

export interface PlaintextExport {
  format: 'svastha-plaintext-export'
  version: 1
  contract_version: number
  exported_at: string
  events: StoredEvent[]
  curation: CurationRecord[]
  provenance: ProvenanceMeta[]
}

/** Plain code-unit comparison, NOT localeCompare: locale collation can order
 * punctuation (e.g. the `:` in curation keys) differently across machines,
 * and the export must sort identically everywhere so it stays diffable
 * against other tools' byte-ordered output (e.g. the devtool's ndjson). */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Strips provenance records down to metadata (never the bytes) and sorts by
 * sha256 — see `buildPlaintextExport`'s doc comment on why sorted output
 * matters. */
export function provenanceMeta(
  records: Pick<ProvenanceRecord, 'sha256' | 'name' | 'importedAt' | 'bytes'>[],
): ProvenanceMeta[] {
  return records
    .map(({ sha256, name, importedAt, bytes }) => ({ sha256, name, importedAt, size: bytes.byteLength }))
    .sort((a, b) => byCodeUnit(a.sha256, b.sha256))
}

/** Assembles the export document. Inputs are never mutated (each array is
 * sorted via a copy) and every array is sorted by a stable key (event id,
 * curation key, provenance sha256) so that re-exporting the same logical
 * state — regardless of IndexedDB's on-disk iteration order — produces byte-
 * identical `JSON.stringify(_, null, 2)` output; that determinism is what
 * makes the file usable as a diff target. */
export function buildPlaintextExport(
  events: StoredEvent[],
  curation: CurationRecord[],
  provenance: ProvenanceMeta[],
  contractVersion: number,
  now: Date,
): PlaintextExport {
  return {
    format: 'svastha-plaintext-export',
    version: 1,
    contract_version: contractVersion,
    exported_at: now.toISOString(),
    events: [...events].sort((a, b) => byCodeUnit(a.event.id, b.event.id)),
    curation: [...curation].sort((a, b) => byCodeUnit(a.key, b.key)),
    provenance: [...provenance].sort((a, b) => byCodeUnit(a.sha256, b.sha256)),
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Local-date `YYYY-MM-DD` stamp shared by both export filenames. */
function dateStamp(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

export function plaintextExportFilename(now: Date): string {
  return `svastha-export-plaintext-${dateStamp(now)}.json`
}

export function encryptedExportFilename(now: Date): string {
  return `svastha-backup-${dateStamp(now)}.json`
}

/** Triggers a browser download of an in-memory blob via a throwaway `<a
 * download>` — no server round trip, nothing written except what the user's
 * download dialog does. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: 'application/json' }))
}

// --- encrypted export/import ---
//
// The encrypted export is a single JSON container of the *same sealed blobs the
// relay stores* (same `ev-`/`doc-`/`cur-` namespaces, same AAD = blob id
// binding) plus the self-wrapped vault key, so importing it runs the identical
// open/verify/LWW path a relay pull runs and dedupes by content id for free.
// See docs/ARCHITECTURE.md, "Sync and backup (web)".
//
// Like the plaintext half above this module stays pure: every stateful
// capability (sealing a blob, unwrapping the vault key, applying a blob,
// enqueuing) is passed in, so build/parse/import are directly unit-testable
// under plain vitest without wasm, a session, or IndexedDB.

export interface EncryptedExport {
  format: 'svastha-encrypted-export'
  version: 1
  contract_version: number
  exported_at: string
  /** base64 of the vault data key wrapped to the owner's own X25519 key —
   * exactly the bytes the relay's `vault.key` blob holds. */
  vault_key: string
  /** blob id -> base64 of its sealed bytes. */
  blobs: Record<string, string>
}

export interface ParsedEncryptedExport {
  contractVersion: number
  wrappedVaultKey: Uint8Array
  blobs: Map<string, Uint8Array>
}

/** A parse/validation failure with a user-facing message. Typed so the UI (and
 * tests) can tell it apart from a genuine runtime error. */
export class ExportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportParseError'
  }
}

/** The wrapped vault key could not be unwrapped by this identity — the backup
 * was made under a different seed phrase. Typed so the UI can show a specific
 * message rather than a generic decrypt failure. */
export class ForeignIdentityError extends Error {
  constructor() {
    super('This backup belongs to a different identity — only its own seed phrase can open it.')
    this.name = 'ForeignIdentityError'
  }
}

export interface BuildEncryptedExportDeps {
  ids: string[]
  /** Seal one blob under the vault key (AAD = id); null if nothing local backs
   * it (that id is then omitted from the container). */
  seal: (id: string) => Promise<Uint8Array | null>
  wrappedVaultKey: Uint8Array
  contractVersion: number
  now: Date
}

/** Assemble the encrypted export container from injected capabilities. Ids
 * whose `seal` returns null are skipped. Ids are emitted in sorted order so the
 * container's key ordering is stable across machines (the sealed bytes
 * themselves carry a fresh nonce each time, so the file is never byte-identical
 * anyway — this is just tidiness, not a diff target). */
export async function buildEncryptedExport(deps: BuildEncryptedExportDeps): Promise<EncryptedExport> {
  const blobs: Record<string, string> = {}
  for (const id of [...deps.ids].sort(byCodeUnit)) {
    const sealed = await deps.seal(id)
    if (!sealed) continue
    blobs[id] = bytesToBase64(sealed)
  }
  return {
    format: 'svastha-encrypted-export',
    version: 1,
    contract_version: deps.contractVersion,
    exported_at: deps.now.toISOString(),
    vault_key: bytesToBase64(deps.wrappedVaultKey),
    blobs,
  }
}

/** Parse and validate an encrypted-export file. Every rejection is an
 * `ExportParseError` with a clear message; the plaintext-export format gets its
 * own message because it can never be imported (it carries no sealed bytes). */
export function parseEncryptedExport(text: string): ParsedEncryptedExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ExportParseError('This file is not valid JSON.')
  }
  if (!raw || typeof raw !== 'object') {
    throw new ExportParseError('This file is not a Svastha backup.')
  }
  const obj = raw as Record<string, unknown>

  if (obj.format === 'svastha-plaintext-export') {
    throw new ExportParseError(
      'This is an unencrypted export, not a backup — it can never be imported. ' +
        'Use an encrypted backup (Download encrypted backup) to restore.',
    )
  }
  if (obj.format !== 'svastha-encrypted-export') {
    throw new ExportParseError('This file is not a Svastha encrypted backup.')
  }
  if (obj.version !== 1) {
    throw new ExportParseError(`Unsupported backup version: ${JSON.stringify(obj.version)}.`)
  }
  if (typeof obj.vault_key !== 'string') {
    throw new ExportParseError('This backup is missing its wrapped vault key.')
  }
  if (!obj.blobs || typeof obj.blobs !== 'object') {
    throw new ExportParseError('This backup is missing its blobs.')
  }

  let wrappedVaultKey: Uint8Array
  try {
    wrappedVaultKey = base64ToBytes(obj.vault_key)
  } catch {
    throw new ExportParseError('This backup’s vault key is not valid base64.')
  }

  const blobs = new Map<string, Uint8Array>()
  for (const [id, value] of Object.entries(obj.blobs as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new ExportParseError(`Blob ${id} is not a base64 string.`)
    }
    try {
      blobs.set(id, base64ToBytes(value))
    } catch {
      throw new ExportParseError(`Blob ${id} is not valid base64.`)
    }
  }

  const contractVersion = typeof obj.contract_version === 'number' ? obj.contract_version : 0
  return { contractVersion, wrappedVaultKey, blobs }
}

export interface ImportEncryptedExportDeps {
  /** Unwrap the file's vault key with the current identity. MUST throw when the
   * key was wrapped to a different identity (proof of same-seed custody). */
  unwrapKey: (wrapped: Uint8Array) => SealKey
  /** The current session's vault key bytes, for the stale-key report; null if
   * unavailable. */
  sessionKeyBytes: Uint8Array | null
  /** Extract a key's raw bytes (kept injected so this module needs no wasm
   * type). */
  keyBytes: (key: SealKey) => Uint8Array
  /** Apply one sealed blob through its codec's verify+store path
   * (`sync.applySealedBlob`). */
  apply: (id: string, sealed: Uint8Array, key: SealKey) => Promise<ApplyOutcome>
  enqueue: (ids: string[]) => Promise<void>
  drain: () => void | Promise<void>
}

export interface ImportSummary {
  events: { new: number; duplicate: number }
  docs: { new: number; duplicate: number }
  curation: { merged: number }
  unknown: string[]
  failed: { id: string; message: string }[]
  /** True when the file was sealed under a vault key that differs from the
   * current session's — reported, never a rejection (see below). */
  staleVaultKey: boolean
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Apply every blob in a parsed backup through the same codec path a relay pull
 * uses, tally the outcomes, and enqueue the newly-adopted blobs for push.
 *
 * Blobs are opened with the FILE'S OWN unwrapped key, not the current session
 * key: unwrapping already proves same-seed custody, and a backup sealed before
 * this device adopted a relay-won vault key must stay importable — so its own
 * key, not the (possibly newer) session key, is what opens its blobs. A
 * mismatch is reported as `staleVaultKey`, never a rejection.
 *
 * Each blob is verified independently, so a single bad blob is recorded in
 * `failed` and the rest still import (a partial import is safe — everything
 * that lands passed its own signature/hash check).
 */
export async function importEncryptedExport(
  parsed: ParsedEncryptedExport,
  deps: ImportEncryptedExportDeps,
): Promise<ImportSummary> {
  const fileKey = deps.unwrapKey(parsed.wrappedVaultKey) // throws on a foreign identity

  const staleVaultKey =
    deps.sessionKeyBytes !== null && !bytesEqual(deps.keyBytes(fileKey), deps.sessionKeyBytes)

  const summary: ImportSummary = {
    events: { new: 0, duplicate: 0 },
    docs: { new: 0, duplicate: 0 },
    curation: { merged: 0 },
    unknown: [],
    failed: [],
    staleVaultKey,
  }

  const toEnqueue: string[] = []
  for (const [id, sealed] of parsed.blobs) {
    let outcome: ApplyOutcome
    try {
      outcome = await deps.apply(id, sealed, fileKey)
    } catch (err) {
      summary.failed.push({ id, message: err instanceof Error ? err.message : String(err) })
      continue
    }

    if (id.startsWith('ev-')) {
      if (outcome === 'new') {
        summary.events.new++
        toEnqueue.push(id)
      } else if (outcome === 'duplicate') {
        summary.events.duplicate++
      }
    } else if (id.startsWith('doc-')) {
      if (outcome === 'new') {
        summary.docs.new++
        toEnqueue.push(id)
      } else if (outcome === 'duplicate') {
        summary.docs.duplicate++
      }
    } else if (id.startsWith('cur-')) {
      if (outcome === 'merged') summary.curation.merged++
      // Enqueue EVERY cur- id in the file, win or lose: curationCodec's own
      // remoteApply only re-enqueues when the incoming record loses the merge
      // (right for a relay pull, where the winner already sits on the relay).
      // On a file import the relay may hold neither record, so it must converge
      // on the post-merge winner regardless of which side won here.
      toEnqueue.push(id)
    } else {
      summary.unknown.push(id)
    }
  }

  if (toEnqueue.length) {
    await deps.enqueue(toEnqueue)
    void deps.drain() // offline-safe: enqueue persists, drain no-ops until online
  }

  return summary
}
