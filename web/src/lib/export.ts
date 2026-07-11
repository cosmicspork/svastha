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
import type { ProvenanceRecord } from './sync'

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

export function plaintextExportFilename(now: Date): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  return `svastha-export-plaintext-${date}.json`
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
