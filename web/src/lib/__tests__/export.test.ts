// Pure, wasm-free/session-free export.ts: buildPlaintextExport's sorting and
// immutability, provenanceMeta's metadata-only projection, and the filename
// helper. downloadBlob/downloadJson touch DOM APIs (createObjectURL, a click)
// and are exercised by e2e instead.
import { describe, expect, it } from 'vitest'
import { buildPlaintextExport, plaintextExportFilename, provenanceMeta } from '../export'
import type { StoredEvent } from '../events'
import type { CurationRecord } from '../curation'

function event(id: string): StoredEvent {
  return {
    event: {
      id,
      kind: 'observation',
      code: null,
      effective_at: null,
      value: null,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'a'.repeat(64),
    signature: 'deadbeef',
  }
}

function curationRecord(key: string): CurationRecord {
  return { key, value: { tags: ['x'] }, updated_at: 1, author: 'a'.repeat(64) }
}

function provenanceRecord(sha256: string, size: number) {
  return { sha256, name: `${sha256}.xml`, importedAt: '2026-01-01T00:00:00.000Z', bytes: new Uint8Array(size) }
}

describe('buildPlaintextExport', () => {
  it('sorts events by event.id', () => {
    const events = [event('c'), event('a'), event('b')]
    const built = buildPlaintextExport(events, [], [], 1, new Date(0))
    expect(built.events.map((e) => e.event.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts curation by key', () => {
    const curation = [curationRecord('tag:c'), curationRecord('tag:a'), curationRecord('tag:b')]
    const built = buildPlaintextExport([], curation, [], 1, new Date(0))
    expect(built.curation.map((c) => c.key)).toEqual(['tag:a', 'tag:b', 'tag:c'])
  })

  it('sorts provenance by sha256', () => {
    const provenance = provenanceMeta([provenanceRecord('c', 1), provenanceRecord('a', 2), provenanceRecord('b', 3)])
    const built = buildPlaintextExport([], [], provenance, 1, new Date(0))
    expect(built.provenance.map((p) => p.sha256)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input arrays', () => {
    const events = [event('c'), event('a'), event('b')]
    const curation = [curationRecord('tag:c'), curationRecord('tag:a')]
    const provenance = provenanceMeta([provenanceRecord('c', 1), provenanceRecord('a', 2)])
    const eventsCopy = [...events]
    const curationCopy = [...curation]
    const provenanceCopy = [...provenance]

    buildPlaintextExport(events, curation, provenance, 1, new Date(0))

    expect(events).toEqual(eventsCopy)
    expect(curation).toEqual(curationCopy)
    expect(provenance).toEqual(provenanceCopy)
  })

  it('sets header fields from the passed contract version and injected Date', () => {
    const now = new Date('2026-07-11T12:34:56.000Z')
    const built = buildPlaintextExport([], [], [], 7, now)
    expect(built.format).toBe('svastha-plaintext-export')
    expect(built.version).toBe(1)
    expect(built.contract_version).toBe(7)
    expect(built.exported_at).toBe('2026-07-11T12:34:56.000Z')
  })

  it('same logical inputs in different array orders produce identical serialized output', () => {
    const eventsA = [event('a'), event('b'), event('c')]
    const eventsB = [event('c'), event('a'), event('b')]
    const curationA = [curationRecord('tag:a'), curationRecord('tag:b')]
    const curationB = [curationRecord('tag:b'), curationRecord('tag:a')]
    const provenanceA = provenanceMeta([provenanceRecord('a', 1), provenanceRecord('b', 2)])
    const provenanceB = provenanceMeta([provenanceRecord('b', 2), provenanceRecord('a', 1)])

    const now = new Date('2026-07-11T00:00:00.000Z')
    const builtA = buildPlaintextExport(eventsA, curationA, provenanceA, 1, now)
    const builtB = buildPlaintextExport(eventsB, curationB, provenanceB, 1, now)

    expect(JSON.stringify(builtA, null, 2)).toBe(JSON.stringify(builtB, null, 2))
  })
})

describe('provenanceMeta', () => {
  it('computes size from bytes.byteLength and drops bytes', () => {
    const [meta] = provenanceMeta([provenanceRecord('abc', 42)])
    expect(meta).toEqual({ sha256: 'abc', name: 'abc.xml', importedAt: '2026-01-01T00:00:00.000Z', size: 42 })
    expect(Object.keys(meta).sort()).toEqual(['importedAt', 'name', 'sha256', 'size'])
    expect('bytes' in meta).toBe(false)
  })
})

describe('plaintextExportFilename', () => {
  it('formats a fixed date as a zero-padded YYYY-MM-DD filename', () => {
    expect(plaintextExportFilename(new Date(2026, 0, 5))).toBe('svastha-export-plaintext-2026-01-05.json')
  })

  it('zero-pads single-digit months and days', () => {
    expect(plaintextExportFilename(new Date(2026, 8, 9))).toBe('svastha-export-plaintext-2026-09-09.json')
  })
})
