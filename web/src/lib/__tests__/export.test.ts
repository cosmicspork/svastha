// Pure, wasm-free/session-free export.ts: buildPlaintextExport's sorting and
// immutability, provenanceMeta's metadata-only projection, and the filename
// helper. downloadBlob/downloadJson touch DOM APIs (createObjectURL, a click)
// and are exercised by e2e instead.
import { describe, expect, it } from 'vitest'
import {
  buildPlaintextExport,
  plaintextExportFilename,
  provenanceMeta,
  buildEncryptedExport,
  parseEncryptedExport,
  importEncryptedExport,
  encryptedExportFilename,
  ExportParseError,
  ForeignIdentityError,
  type ParsedEncryptedExport,
  type ImportEncryptedExportDeps,
} from '../export'
import type { StoredEvent } from '../events'
import type { CurationRecord } from '../curation'
import type { ApplyOutcome, SealKey } from '../sync'

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

describe('encryptedExportFilename', () => {
  it('formats a zero-padded YYYY-MM-DD backup filename', () => {
    expect(encryptedExportFilename(new Date(2026, 0, 5))).toBe('svastha-backup-2026-01-05.json')
  })
})

// --- encrypted export/import ---

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** A trivial SealKey stand-in — the import orchestration never calls seal/open
 * itself (that's `apply`'s job, faked separately). */
const fakeKey: SealKey = { seal: (p) => p, open: (s) => s }

describe('buildEncryptedExport', () => {
  it('seals every id, sorts blob keys, and stamps the header', async () => {
    const built = await buildEncryptedExport({
      ids: ['ev-b', 'ev-a'],
      seal: async (id) => utf8(`sealed-${id}`),
      wrappedVaultKey: new Uint8Array([1, 2, 3, 4]),
      contractVersion: 5,
      now: new Date('2026-07-11T00:00:00.000Z'),
    })

    expect(built.format).toBe('svastha-encrypted-export')
    expect(built.version).toBe(1)
    expect(built.contract_version).toBe(5)
    expect(built.exported_at).toBe('2026-07-11T00:00:00.000Z')
    expect(Object.keys(built.blobs)).toEqual(['ev-a', 'ev-b']) // sorted
  })

  it('skips ids whose seal returns null', async () => {
    const built = await buildEncryptedExport({
      ids: ['ev-x', 'ev-y'],
      seal: async (id) => (id === 'ev-y' ? null : utf8('s')),
      wrappedVaultKey: new Uint8Array([0]),
      contractVersion: 1,
      now: new Date(0),
    })
    expect(Object.keys(built.blobs)).toEqual(['ev-x'])
  })

  it('round-trips through parseEncryptedExport', async () => {
    const built = await buildEncryptedExport({
      ids: ['ev-a', 'doc-b'],
      seal: async (id) => utf8(`sealed-${id}`),
      wrappedVaultKey: new Uint8Array([9, 8, 7]),
      contractVersion: 3,
      now: new Date(0),
    })

    const parsed = parseEncryptedExport(JSON.stringify(built))
    expect(parsed.contractVersion).toBe(3)
    expect(parsed.wrappedVaultKey).toEqual(new Uint8Array([9, 8, 7]))
    expect(new TextDecoder().decode(parsed.blobs.get('ev-a')!)).toBe('sealed-ev-a')
    expect(new TextDecoder().decode(parsed.blobs.get('doc-b')!)).toBe('sealed-doc-b')
  })
})

describe('parseEncryptedExport rejections', () => {
  const valid = {
    format: 'svastha-encrypted-export',
    version: 1,
    contract_version: 1,
    exported_at: '2026-01-01T00:00:00.000Z',
    vault_key: btoa('key'),
    blobs: { 'ev-a': btoa('blob') },
  }

  it('rejects non-JSON', () => {
    expect(() => parseEncryptedExport('not json{')).toThrow(ExportParseError)
    expect(() => parseEncryptedExport('not json{')).toThrow(/not valid JSON/)
  })

  it('rejects a plaintext export with a dedicated message', () => {
    const text = JSON.stringify({ format: 'svastha-plaintext-export', version: 1 })
    expect(() => parseEncryptedExport(text)).toThrow(ExportParseError)
    expect(() => parseEncryptedExport(text)).toThrow(/unencrypted export/)
  })

  it('rejects an unrecognized format', () => {
    const text = JSON.stringify({ ...valid, format: 'something-else' })
    expect(() => parseEncryptedExport(text)).toThrow(/not a Svastha encrypted backup/)
  })

  it('rejects an unsupported version', () => {
    const text = JSON.stringify({ ...valid, version: 2 })
    expect(() => parseEncryptedExport(text)).toThrow(/Unsupported backup version/)
  })

  it('rejects a missing vault key', () => {
    const { vault_key, ...rest } = valid
    void vault_key
    expect(() => parseEncryptedExport(JSON.stringify(rest))).toThrow(/missing its wrapped vault key/)
  })

  it('rejects missing blobs', () => {
    const { blobs, ...rest } = valid
    void blobs
    expect(() => parseEncryptedExport(JSON.stringify(rest))).toThrow(/missing its blobs/)
  })

  it('rejects a non-base64 vault key', () => {
    const text = JSON.stringify({ ...valid, vault_key: '!!!!' })
    expect(() => parseEncryptedExport(text)).toThrow(/vault key is not valid base64/)
  })

  it('rejects a blob that is not a string', () => {
    const text = JSON.stringify({ ...valid, blobs: { 'ev-a': 123 } })
    expect(() => parseEncryptedExport(text)).toThrow(/is not a base64 string/)
  })

  it('rejects a blob that is not valid base64', () => {
    const text = JSON.stringify({ ...valid, blobs: { 'ev-a': '!!!!' } })
    expect(() => parseEncryptedExport(text)).toThrow(/is not valid base64/)
  })
})

describe('importEncryptedExport', () => {
  function parsed(blobs: Map<string, Uint8Array>): ParsedEncryptedExport {
    return { contractVersion: 1, wrappedVaultKey: new Uint8Array([1, 2, 3]), blobs }
  }

  it('tallies per outcome, isolates a failed blob, and enqueues by the right rules', async () => {
    const enqueued: string[][] = []
    let drained = 0
    const apply = async (id: string): Promise<ApplyOutcome> => {
      switch (id) {
        case 'ev-new':
          return 'new'
        case 'ev-dup':
          return 'duplicate'
        case 'doc-new':
          return 'new'
        case 'cur-a':
          return 'merged'
        case 'ev-bad':
          throw new Error('signature does not verify')
        default:
          return 'unknown'
      }
    }
    const deps: ImportEncryptedExportDeps = {
      unwrapKey: () => fakeKey,
      sessionKeyBytes: null,
      keyBytes: () => new Uint8Array(),
      apply,
      enqueue: async (ids) => {
        enqueued.push(ids)
      },
      drain: () => {
        drained++
      },
    }

    const blobs = new Map<string, Uint8Array>([
      ['ev-new', utf8('x')],
      ['ev-dup', utf8('x')],
      ['doc-new', utf8('x')],
      ['cur-a', utf8('x')],
      ['ev-bad', utf8('x')],
      ['zzz-unknown', utf8('x')],
    ])

    const summary = await importEncryptedExport(parsed(blobs), deps)

    expect(summary.events).toEqual({ new: 1, duplicate: 1 })
    expect(summary.docs).toEqual({ new: 1, duplicate: 0 })
    expect(summary.curation).toEqual({ merged: 1 })
    expect(summary.unknown).toEqual(['zzz-unknown'])
    expect(summary.failed).toEqual([{ id: 'ev-bad', message: 'signature does not verify' }])
    // 'new' ev-/doc- enqueue; a duplicate does not; cur- always does.
    expect(enqueued).toEqual([['ev-new', 'doc-new', 'cur-a']])
    expect(drained).toBe(1)
  })

  it('does not enqueue or drain when nothing was adopted', async () => {
    const enqueued: string[][] = []
    let drained = 0
    const deps: ImportEncryptedExportDeps = {
      unwrapKey: () => fakeKey,
      sessionKeyBytes: null,
      keyBytes: () => new Uint8Array(),
      apply: async () => 'duplicate',
      enqueue: async (ids) => {
        enqueued.push(ids)
      },
      drain: () => {
        drained++
      },
    }
    await importEncryptedExport(parsed(new Map([['ev-a', utf8('x')]])), deps)
    expect(enqueued).toEqual([])
    expect(drained).toBe(0)
  })

  it('rejects a backup wrapped to a different identity', async () => {
    const deps: ImportEncryptedExportDeps = {
      unwrapKey: () => {
        throw new ForeignIdentityError()
      },
      sessionKeyBytes: null,
      keyBytes: () => new Uint8Array(),
      apply: async () => 'new',
      enqueue: async () => {},
      drain: () => {},
    }
    await expect(importEncryptedExport(parsed(new Map()), deps)).rejects.toThrow(ForeignIdentityError)
  })

  it('flags a stale vault key when the file key differs from the session key (never rejects)', async () => {
    const base: Omit<ImportEncryptedExportDeps, 'sessionKeyBytes' | 'keyBytes'> = {
      unwrapKey: () => fakeKey,
      apply: async () => 'new',
      enqueue: async () => {},
      drain: () => {},
    }

    const stale = await importEncryptedExport(parsed(new Map()), {
      ...base,
      sessionKeyBytes: new Uint8Array([1, 2, 3]),
      keyBytes: () => new Uint8Array([4, 5, 6]),
    })
    expect(stale.staleVaultKey).toBe(true)

    const fresh = await importEncryptedExport(parsed(new Map()), {
      ...base,
      sessionKeyBytes: new Uint8Array([1, 2, 3]),
      keyBytes: () => new Uint8Array([1, 2, 3]),
    })
    expect(fresh.staleVaultKey).toBe(false)
  })
})
