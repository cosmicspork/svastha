import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteDb, get, put } from '../db'
import {
  lwwMerge,
  writeCuration,
  getCuration,
  allCurationByPrefix,
  curationCodec,
  migrateFavoritesToCuration,
  migrateCurationToSigned,
  getStatus,
  getName,
  allStatuses,
  allNames,
  type CurationRecord,
  type SignedCurationRecord,
  type CurationSigner,
} from '../curation'

// The codec's verify-or-drop path calls `verify_curation` (wasm). Mock the
// wasm module the way doctorShare.test.ts does, so unit tests stay wasm-free
// and can drive the verify outcome. `verify_event` is mocked too because
// sync.ts (imported transitively) imports it.
vi.mock('../svastha', () => ({
  verify_event: vi.fn(() => true),
  verify_curation: vi.fn(() => true),
}))
import { verify_curation } from '../svastha'
const mockVerify = vi.mocked(verify_curation)

// deleteDb() (not a raw indexedDB.deleteDatabase call) so the module's
// memoized connection is closed and cleared between tests — same pattern as
// db.test.ts / sync.test.ts.
beforeEach(async () => {
  await deleteDb()
  mockVerify.mockClear()
  mockVerify.mockReturnValue(true)
})

const AUTHOR_A = 'a'.repeat(64)
const AUTHOR_B = 'b'.repeat(64)

/** A wasm-free stand-in for `signerFor(identity)`: stamps a fixed author and a
 * placeholder signature, so the pure write/migration cores are testable
 * without loading the trust contract. */
function signAs(author: string): CurationSigner {
  return (key, value, updated_at) => ({ key, value, updated_at, author, signature: `sig-${author}` })
}

function signed(overrides: Partial<SignedCurationRecord> = {}): SignedCurationRecord {
  return {
    key: 'tag:evt-1',
    value: { tags: ['flare'] },
    updated_at: 1000,
    author: AUTHOR_A,
    signature: `sig-${AUTHOR_A}`,
    ...overrides,
  }
}

describe('lwwMerge', () => {
  it('no local record: remote always wins', () => {
    const remote = signed()
    expect(lwwMerge(undefined, remote)).toBe(remote)
  })

  it('higher updated_at wins regardless of author', () => {
    const local = signed({ updated_at: 1000, author: AUTHOR_B })
    const remote = signed({ updated_at: 2000, author: AUTHOR_A })
    expect(lwwMerge(local, remote)).toBe(remote)

    // Symmetric: an older remote loses even with the lexicographically
    // greater author.
    const newerLocal = signed({ updated_at: 2000, author: AUTHOR_A })
    const olderRemote = signed({ updated_at: 1000, author: AUTHOR_B })
    expect(lwwMerge(newerLocal, olderRemote)).toBe(newerLocal)
  })

  it('tie on updated_at: lexicographically greater author wins', () => {
    const local = signed({ updated_at: 1000, author: AUTHOR_A })
    const remote = signed({ updated_at: 1000, author: AUTHOR_B })
    expect(lwwMerge(local, remote)).toBe(remote) // 'b' > 'a'

    const localB = signed({ updated_at: 1000, author: AUTHOR_B })
    const remoteA = signed({ updated_at: 1000, author: AUTHOR_A })
    expect(lwwMerge(localB, remoteA)).toBe(localB) // 'b' > 'a' — local keeps it
  })

  it('merges a grandfathered unsigned record (missing signature) — accepted for the transition', () => {
    // The one thing `core`'s `merge_curation` wasm binding cannot do (it needs a
    // `signature` to parse). The local TS twin tolerates it so a pre-signing
    // record still merges by LWW until its next local write re-signs it.
    const unsignedRemote = { key: 'tag:x', value: { tags: ['a'] }, updated_at: 2000, author: AUTHOR_A }
    const local = signed({ key: 'tag:x', updated_at: 1000 })
    expect(lwwMerge(local, unsignedRemote)).toBe(unsignedRemote)
  })

  it('clock-skew note: a fast-clocked writer\'s edit wins even if the merge is applied "later" on another device', () => {
    const genuinelyLater = signed({ updated_at: 5000, author: AUTHOR_A })
    const skewedEarlierWriteButHigherStamp = signed({ updated_at: 9000, author: AUTHOR_B })
    expect(lwwMerge(genuinelyLater, skewedEarlierWriteButHigherStamp)).toBe(
      skewedEarlierWriteButHigherStamp,
    )
  })
})

// Pin the TS merge against a real `core`-signed record from the shared spec
// vectors: core's own `matches_spec_vectors` test pins core's verify+merge to
// this same file, so chaining the web's `lwwMerge` to it keeps the two
// implementations from drifting (the reason this PR keeps the pure TS function
// instead of calling `merge_curation` per-merge — which also couldn't touch a
// grandfathered unsigned record).
describe('lwwMerge vs. core spec vectors', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const vectorsPath = join(here, '../../../../spec/vectors/curation.json')
  const file = JSON.parse(new TextDecoder().decode(readFileSync(vectorsPath))) as {
    records: { valid: boolean; record: SignedCurationRecord }[]
  }
  const vec = file.records.find((r) => r.valid)!.record

  it('the valid vector is exactly the web client wire shape', () => {
    // Field-for-field agreement with `core`'s flat `SignedCurationRecord`.
    expect(typeof vec.key).toBe('string')
    expect(vec.value).toBeDefined()
    expect(typeof vec.updated_at).toBe('number')
    expect(vec.author).toMatch(/^[0-9a-f]{64}$/)
    expect(vec.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('the TS merge picks the same winner core would over that record', () => {
    const newer = { ...vec, updated_at: vec.updated_at + 1 }
    expect(lwwMerge(vec, newer)).toBe(newer)
    expect(lwwMerge(newer, vec)).toBe(newer) // commutative

    // Tie on updated_at → lexicographically greater author, matching core's
    // raw-byte comparison (fixed-width hex is order-preserving).
    const higher = { ...vec, author: 'f'.repeat(64) }
    const lower = { ...vec, author: '0'.repeat(64) }
    expect(lwwMerge(higher, lower)).toBe(higher)
    expect(lwwMerge(lower, higher)).toBe(higher)
  })
})

describe('writeCuration', () => {
  it('stores the signed record and enqueues its cur- blob for push', async () => {
    await writeCuration('tag:evt-1', { tags: ['flare'] }, signAs(AUTHOR_A), 1234)
    const stored = await getCuration('tag:evt-1')
    expect(stored).toEqual({
      key: 'tag:evt-1',
      value: { tags: ['flare'] },
      updated_at: 1234,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
  })
})

describe('curationCodec (cur-)', () => {
  async function blobIdFor(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return `cur-${hex}`
  }

  it('localHas/localLoad find a record by its hashed blob id (reverse map)', async () => {
    await writeCuration('tag:evt-1', { tags: ['flare'] }, signAs(AUTHOR_A), 1000)
    const blobId = await blobIdFor('tag:evt-1')

    expect(await curationCodec.localHas(blobId)).toBe(true)
    const loaded = await curationCodec.localLoad(blobId)
    expect(loaded).not.toBeNull()
    // The signature travels in the pushed blob (a share recipient / second
    // device verifies it).
    expect(JSON.parse(new TextDecoder().decode(loaded!))).toEqual({
      key: 'tag:evt-1',
      value: { tags: ['flare'] },
      updated_at: 1000,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
  })

  it('localHas/localLoad report nothing for an unknown blob id', async () => {
    expect(await curationCodec.localHas('cur-deadbeef')).toBe(false)
    expect(await curationCodec.localLoad('cur-deadbeef')).toBeNull()
  })

  it('remoteApply adopts a signed remote record that wins the merge (verified)', async () => {
    const blobId = await blobIdFor('hide:evt-2')
    const remote = signed({ key: 'hide:evt-2', value: { hidden: true }, updated_at: 500 })
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(remote)))
    expect(mockVerify).toHaveBeenCalledOnce()
    expect(await getCuration('hide:evt-2')).toEqual(remote)
  })

  it('remoteApply DROPS a signed record whose signature fails verification', async () => {
    mockVerify.mockReturnValue(false)
    const blobId = await blobIdFor('hide:evt-drop')
    const remote = signed({ key: 'hide:evt-drop', value: { hidden: true }, updated_at: 500 })
    // Dropped, not thrown (throwing would just retry the same bad blob).
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(remote)))
    expect(await getCuration('hide:evt-drop')).toBeUndefined()
  })

  it('remoteApply GRANDFATHERS an unsigned remote record (no verify call)', async () => {
    const blobId = await blobIdFor('note:evt-old')
    const unsigned: CurationRecord = {
      key: 'note:evt-old',
      value: { text: 'from a pre-signing device' },
      updated_at: 500,
      author: AUTHOR_A,
    }
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(unsigned)))
    expect(mockVerify).not.toHaveBeenCalled()
    expect(await getCuration('note:evt-old')).toEqual(unsigned)
  })

  it('remoteApply: local wins over a stale remote, and re-enqueues the local record for push', async () => {
    await writeCuration('note:evt-4', { text: 'mine, newer' }, signAs(AUTHOR_A), 900)

    const blobId = await blobIdFor('note:evt-4')
    const staleRemote = signed({
      key: 'note:evt-4',
      value: { text: 'stale' },
      updated_at: 100,
      author: AUTHOR_B,
    })
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(staleRemote)))

    expect(await getCuration('note:evt-4')).toEqual({
      key: 'note:evt-4',
      value: { text: 'mine, newer' },
      updated_at: 900,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
    const syncRecords = await get<{ id: string; state: string }>('sync', blobId)
    expect(syncRecords?.state).toBe('pending')
  })

  it('remoteApply rejects a record whose embedded key does not hash to the blob id', async () => {
    const wrongBlobId = await blobIdFor('tag:evt-5')
    const mismatched = signed({ key: 'tag:some-other-event', value: { tags: ['x'] }, updated_at: 1 })
    await expect(
      curationCodec.remoteApply(wrongBlobId, new TextEncoder().encode(JSON.stringify(mismatched))),
    ).rejects.toThrow(/does not hash to the blob id/)
  })

  it('remoteApply rejects a malformed payload', async () => {
    const blobId = await blobIdFor('tag:evt-6')
    await expect(
      curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify({ not: 'a curation record' }))),
    ).rejects.toThrow(/malformed curation record/)
  })
})

// The read/aggregate helpers, seeded through `writeCuration` with a stub signer
// (the `setStatus`/`setName` write wrappers go through `setCuration`, whose
// `session.svelte` import needs the Svelte runtime — same reason the existing
// tests exercise `writeCuration` directly, not `setCuration`). The write path
// is covered end-to-end by the e2e spec.
describe('status / name read helpers', () => {
  const CONCEPT = 'medication_statement|http://www.nlm.nih.gov/research/umls/rxnorm|197361'
  const sign = signAs(AUTHOR_A)

  it('getStatus defaults to undefined and reads active/inactive', async () => {
    expect(await getStatus(CONCEPT)).toBeUndefined()
    await writeCuration(`status:${CONCEPT}`, { status: 'inactive' }, sign)
    expect(await getStatus(CONCEPT)).toBe('inactive')
  })

  it('getName defaults to empty, reads and trims an override', async () => {
    expect(await getName(CONCEPT)).toBe('')
    await writeCuration(`name:${CONCEPT}`, { display: '  Lisinopril 10mg  ' }, sign)
    expect(await getName(CONCEPT)).toBe('Lisinopril 10mg')
    // A cleared override is an empty display (not a delete) → reads as "no override".
    await writeCuration(`name:${CONCEPT}`, { display: '' }, sign)
    expect(await getName(CONCEPT)).toBe('')
    expect(await getCuration(`name:${CONCEPT}`)).toBeDefined()
  })

  it('allStatuses / allNames key on the bare concept and drop empty overrides', async () => {
    await writeCuration(`status:${CONCEPT}`, { status: 'inactive' }, sign)
    await writeCuration(`name:${CONCEPT}`, { display: 'Custom' }, sign)
    await writeCuration('name:condition|snomed|123', { display: '' }, sign) // cleared → excluded

    expect(await allStatuses()).toEqual(new Map([[CONCEPT, 'inactive']]))
    expect(await allNames()).toEqual(new Map([[CONCEPT, 'Custom']]))
  })
})

describe('migrateCurationToSigned', () => {
  /** Seed a raw unsigned record straight into the store (as a pre-signing
   * device would have left it). */
  async function seedUnsigned(rec: CurationRecord): Promise<void> {
    await put('curation', rec)
  }

  it("re-signs the owner's unsigned records in place, preserving updated_at and author", async () => {
    await seedUnsigned({ key: 'tag:evt-1', value: { tags: ['a'] }, updated_at: 111, author: AUTHOR_A })
    await seedUnsigned({ key: 'hide:evt-2', value: { hidden: true }, updated_at: 222, author: AUTHOR_A })

    await migrateCurationToSigned(signAs(AUTHOR_A), AUTHOR_A)

    // Content identical — only a signature was added.
    expect(await getCuration('tag:evt-1')).toEqual({
      key: 'tag:evt-1',
      value: { tags: ['a'] },
      updated_at: 111,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
    expect(await getCuration('hide:evt-2')).toEqual({
      key: 'hide:evt-2',
      value: { hidden: true },
      updated_at: 222,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
  })

  it('enqueues each re-signed record for re-push over its existing cur- blob', async () => {
    await seedUnsigned({ key: 'tag:evt-1', value: { tags: ['a'] }, updated_at: 111, author: AUTHOR_A })
    await migrateCurationToSigned(signAs(AUTHOR_A), AUTHOR_A)

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tag:evt-1'))
    const hex = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
    const rec = await get<{ state: string }>('sync', `cur-${hex}`)
    expect(rec?.state).toBe('pending')
  })

  it('leaves a foreign-authored unsigned record alone (grandfathered)', async () => {
    await seedUnsigned({ key: 'tag:evt-x', value: { tags: ['a'] }, updated_at: 111, author: AUTHOR_B })
    await migrateCurationToSigned(signAs(AUTHOR_A), AUTHOR_A)
    expect(await getCuration('tag:evt-x')).toEqual({
      key: 'tag:evt-x',
      value: { tags: ['a'] },
      updated_at: 111,
      author: AUTHOR_B,
    })
  })

  it('is idempotent: a second run re-signs nothing and does not clobber', async () => {
    await seedUnsigned({ key: 'tag:evt-1', value: { tags: ['a'] }, updated_at: 111, author: AUTHOR_A })
    await migrateCurationToSigned(signAs(AUTHOR_A), AUTHOR_A)

    // A signer that throws if called — proves the second run short-circuits on
    // the prefs marker (nothing is re-signed).
    const boom: CurationSigner = () => {
      throw new Error('signer must not be called on the second run')
    }
    await migrateCurationToSigned(boom, AUTHOR_A)
    expect(await getCuration('tag:evt-1')).toEqual({
      key: 'tag:evt-1',
      value: { tags: ['a'] },
      updated_at: 111,
      author: AUTHOR_A,
      signature: `sig-${AUTHOR_A}`,
    })
    expect(await get('prefs', 'curation-signed-migrated')).toBe(true)
  })

  it('already-signed records are skipped (per-record signature check)', async () => {
    await put('curation', signed({ key: 'tag:signed', updated_at: 5 }))
    let called = 0
    const counting: CurationSigner = (key, value, updated_at) => {
      called++
      return { key, value, updated_at, author: AUTHOR_A, signature: 're' }
    }
    await migrateCurationToSigned(counting, AUTHOR_A)
    expect(called).toBe(0)
  })
})

describe('migrateFavoritesToCuration', () => {
  it('copies legacy prefs favorites into signed fav: curation records, once', async () => {
    await put(
      'prefs',
      [
        { label: 'Morning meds', category: 'med', drafts: [{ kind: 'medication_statement', value: { text: 'x' } }] },
      ],
      'favorites',
    )

    await migrateFavoritesToCuration(signAs(AUTHOR_A))

    const favRecords = await allCurationByPrefix('fav:med:')
    expect(favRecords).toHaveLength(1)
    expect(favRecords[0].value).toEqual({
      label: 'Morning meds',
      category: 'med',
      drafts: [{ kind: 'medication_statement', value: { text: 'x' } }],
    })
    expect(favRecords[0].author).toBe(AUTHOR_A)
    expect((favRecords[0] as SignedCurationRecord).signature).toBe(`sig-${AUTHOR_A}`)

    await migrateFavoritesToCuration(signAs(AUTHOR_A))
    expect(await allCurationByPrefix('fav:med:')).toHaveLength(1)

    expect(await get('prefs', 'favorites-migrated-to-curation')).toBe(true)
  })

  it('is a no-op with no legacy favorites', async () => {
    await migrateFavoritesToCuration(signAs(AUTHOR_A))
    expect(await allCurationByPrefix('fav:')).toHaveLength(0)
  })
})
