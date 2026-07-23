// Reads for imported source documents: the verbatim bytes kept in the
// `provenance` store (see sync.ts's `doc-` codec) so an entry that came from
// an import can show the original C-CDA/FHIR file it was derived from.
// `ProvenanceRecord` carries no mime — the wire envelope (and the `doc-`
// codec) is frozen, so mime is derived here at render time from the stored
// file name instead of widening that shape.
import { get } from './db'
import type { ProvenanceRecord } from './sync'

export type { ProvenanceRecord }

/** application/xml for C-CDA, application/json for a FHIR bundle, else plain
 * text — matched on the stored file's extension, case-insensitively. */
export function mimeForDocName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.xml')) return 'application/xml'
  if (lower.endsWith('.json')) return 'application/json'
  return 'text/plain'
}

export function getProvenance(sha256: string): Promise<ProvenanceRecord | undefined> {
  return get<ProvenanceRecord>('provenance', sha256)
}

/** Bytes for one imported source document, or null if this device doesn't
 * hold them (e.g. an over-16MiB import whose provenance blob never synced —
 * see import.ts's `tooLargeToSync`). */
export async function provenanceBytes(sha256: string): Promise<Uint8Array | null> {
  const record = await getProvenance(sha256)
  return record?.bytes ?? null
}

/** Soft cap on rendered text: a 16 MiB C-CDA decoded and pasted whole into a
 * `<pre>` would hang an iPhone's main thread, and nobody reads past the first
 * couple hundred KB of an XML/JSON dump anyway. */
export const MAX_RENDERED_TEXT_BYTES = 2 * 1024 * 1024

export interface PrettyText {
  text: string
  truncated: boolean
}

/** UTF-8 decode with a size cap, JSON pretty-printed when the mime says JSON
 * (falling back to the raw decoded text if it doesn't actually parse); XML
 * and anything else render as-is. Truncation happens on the decoded text
 * (not the raw bytes) so it never splits a multi-byte character, and lands on
 * a line boundary when one is available nearby so the cut doesn't fall
 * mid-token. */
export function prettyTextForDoc(bytes: Uint8Array, mime: string): PrettyText {
  const decoded = new TextDecoder().decode(bytes)
  let text = decoded
  if (mime === 'application/json') {
    try {
      text = JSON.stringify(JSON.parse(decoded), null, 2)
    } catch {
      text = decoded
    }
  }

  if (text.length <= MAX_RENDERED_TEXT_BYTES) return { text, truncated: false }

  const cut = text.lastIndexOf('\n', MAX_RENDERED_TEXT_BYTES)
  const boundary = cut > MAX_RENDERED_TEXT_BYTES * 0.9 ? cut : MAX_RENDERED_TEXT_BYTES
  return { text: text.slice(0, boundary), truncated: true }
}
