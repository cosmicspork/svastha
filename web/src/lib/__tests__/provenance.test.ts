import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, put } from '../db'
import {
  mimeForDocName,
  prettyTextForDoc,
  getProvenance,
  provenanceBytes,
  MAX_RENDERED_TEXT_BYTES,
} from '../provenance'
import type { ProvenanceRecord } from '../provenance'

// deleteDb() between tests so the module's memoized connection is closed and
// cleared — same pattern as db.test.ts / attachments.test.ts.
beforeEach(deleteDb)

describe('mimeForDocName', () => {
  it('maps .xml to application/xml', () => {
    expect(mimeForDocName('CCD.xml')).toBe('application/xml')
  })

  it('maps .json to application/json', () => {
    expect(mimeForDocName('bundle-minimal.json')).toBe('application/json')
  })

  it('falls back to text/plain for anything else', () => {
    expect(mimeForDocName('notes.txt')).toBe('text/plain')
    expect(mimeForDocName('no-extension')).toBe('text/plain')
  })

  it('matches extensions case-insensitively', () => {
    expect(mimeForDocName('CCD.XML')).toBe('application/xml')
    expect(mimeForDocName('Bundle.JSON')).toBe('application/json')
  })
})

describe('prettyTextForDoc', () => {
  it('pretty-prints valid JSON', () => {
    const bytes = new TextEncoder().encode('{"a":1,"b":[2,3]}')
    const { text, truncated } = prettyTextForDoc(bytes, 'application/json')
    expect(text).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
    expect(truncated).toBe(false)
  })

  it('falls back to the raw decoded text when JSON parsing fails', () => {
    const raw = '{not valid json'
    const bytes = new TextEncoder().encode(raw)
    const { text, truncated } = prettyTextForDoc(bytes, 'application/json')
    expect(text).toBe(raw)
    expect(truncated).toBe(false)
  })

  it('renders XML as-is, without attempting to reformat it', () => {
    const raw = '<ClinicalDocument><title>CCD</title></ClinicalDocument>'
    const bytes = new TextEncoder().encode(raw)
    const { text, truncated } = prettyTextForDoc(bytes, 'application/xml')
    expect(text).toBe(raw)
    expect(truncated).toBe(false)
  })

  it('flags truncation and caps rendered text around the size threshold when the document is large', () => {
    const line = 'x'.repeat(80) + '\n'
    const raw = line.repeat(Math.ceil((MAX_RENDERED_TEXT_BYTES + 10_000) / line.length))
    const bytes = new TextEncoder().encode(raw)
    const { text, truncated } = prettyTextForDoc(bytes, 'text/plain')
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThan(raw.length)
    expect(text.length).toBeLessThanOrEqual(MAX_RENDERED_TEXT_BYTES)
  })
})

describe('getProvenance / provenanceBytes', () => {
  it('returns the stored record and its bytes on a hit', async () => {
    const record: ProvenanceRecord = {
      sha256: 'a'.repeat(64),
      name: 'CCD.xml',
      bytes: new TextEncoder().encode('<xml/>'),
      importedAt: '2026-07-01T00:00:00Z',
    }
    await put('provenance', record)

    expect(await getProvenance(record.sha256)).toEqual(record)
    expect(await provenanceBytes(record.sha256)).toEqual(record.bytes)
  })

  it('returns undefined/null on a miss (never synced to this device)', async () => {
    expect(await getProvenance('b'.repeat(64))).toBeUndefined()
    expect(await provenanceBytes('b'.repeat(64))).toBeNull()
  })
})
