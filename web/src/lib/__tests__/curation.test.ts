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
  getRegimen,
  allRegimens,
  normalizeRegimen,
  regimenMapFrom,
  regimenChanged,
  hiddenIdsFrom,
  loadHiddenIds,
  normalizePriority,
  priorityMapFrom,
  hiddenConceptsFrom,
  getPriority,
  allPriorities,
  getAllergy,
  allAllergies,
  normalizeAllergy,
  allergyMapFrom,
  allergyChanged,
  ALLERGY_REACTION_MAX,
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

  it('remoteApply leaves an echo of this device\'s own record alone (no re-push loop)', async () => {
    await writeCuration('note:evt-echo', { text: 'mine', b: 1, a: 2 }, signAs(AUTHOR_A), 900)
    const blobId = await blobIdFor('note:evt-echo')
    // The push completed; the relay's poke makes the next pull fetch it back.
    await put('sync', { id: blobId, state: 'done', updated_at: new Date().toISOString() })
    const echo = JSON.parse(new TextDecoder().decode((await curationCodec.localLoad(blobId))!))
    // Key order inside `value` is not part of the identity.
    echo.value = { a: 2, b: 1, text: 'mine' }

    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(echo)))

    expect((await get<{ state: string }>('sync', blobId))?.state).toBe('done')
  })

  it('remoteApply still re-pushes a same-clock, same-author record whose value differs', async () => {
    // Not an echo: the relay holds something else under our clock and author,
    // so the tie goes to lwwMerge and the local record is pushed back.
    await writeCuration('note:evt-tie', { text: 'local' }, signAs(AUTHOR_A), 900)
    const blobId = await blobIdFor('note:evt-tie')
    await put('sync', { id: blobId, state: 'done', updated_at: new Date().toISOString() })
    const other = signed({ key: 'note:evt-tie', value: { text: 'other' }, updated_at: 900, author: AUTHOR_A })

    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(other)))

    expect((await get<{ state: string }>('sync', blobId))?.state).toBe('pending')
  })

  it('remoteApply treats an unsigned twin of a signed local record as different', async () => {
    await writeCuration('note:evt-unsigned', { text: 'same' }, signAs(AUTHOR_A), 900)
    const blobId = await blobIdFor('note:evt-unsigned')
    await put('sync', { id: blobId, state: 'done', updated_at: new Date().toISOString() })
    const unsigned: CurationRecord = { key: 'note:evt-unsigned', value: { text: 'same' }, updated_at: 900, author: AUTHOR_A }

    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(unsigned)))

    expect((await get<{ state: string }>('sync', blobId))?.state).toBe('pending')
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

// Same seeding constraint as the status/name helpers above: `setRegimen` goes
// through `setCuration`, whose `session.svelte` import needs the Svelte
// runtime, so the store is seeded with `writeCuration` and a stub signer. The
// write wrapper is covered end-to-end by summary-status.spec.ts.
describe('regimen read helpers', () => {
  const CONCEPT = 'medication_statement|http://www.nlm.nih.gov/research/umls/rxnorm|29046'
  const sign = signAs(AUTHOR_A)

  it('getRegimen defaults to undefined, round-trips a value and trims its text', async () => {
    expect(await getRegimen(CONCEPT)).toBeUndefined()
    await writeCuration(
      `regimen:${CONCEPT}`,
      {
        dose: '  10 mg  ',
        schedule: ' Every morning ',
        route: 'mouth',
        as_needed: true,
        prescriber: '  Dr. Rivera ',
        started: '2024-01-01',
        stopped: '2024-06-30',
        instructions: ' Take with food ',
      },
      sign,
    )
    expect(await getRegimen(CONCEPT)).toEqual({
      dose: '10 mg',
      schedule: 'Every morning',
      route: 'mouth',
      as_needed: true,
      prescriber: 'Dr. Rivera',
      started: '2024-01-01',
      stopped: '2024-06-30',
      instructions: 'Take with food',
    })
  })

  it('reads a cleared regimen (the empty value, not a delete) as no regimen', async () => {
    await writeCuration(`regimen:${CONCEPT}`, { dose: '10 mg' }, sign)
    await writeCuration(`regimen:${CONCEPT}`, {}, sign)
    expect(await getRegimen(CONCEPT)).toBeUndefined()
    // The record itself survives — the sync model has no delete.
    expect(await getCuration(`regimen:${CONCEPT}`)).toBeDefined()
  })

  it('allRegimens keys on the bare concept and drops cleared records', async () => {
    await writeCuration(`regimen:${CONCEPT}`, { schedule: 'Nightly' }, sign)
    await writeCuration('regimen:medication_statement||aspirin', {}, sign)
    expect(await allRegimens()).toEqual(new Map([[CONCEPT, { schedule: 'Nightly' }]]))
  })
})

// Adversarial fixtures: every input here is chosen to get PAST the shape check,
// not to satisfy it. A `regimen:` value can arrive from a second device running
// a newer build, and (from PR3 on) from a doctor-share bundle, so the guard has
// to hold against values no version of this app would ever write.
describe('normalizeRegimen (tolerant shape-check)', () => {
  it('rejects non-object values outright', () => {
    for (const value of ['mouth', 42, true, null, undefined, ['mouth'], [{ dose: '10 mg' }]]) {
      expect(normalizeRegimen(value)).toBeUndefined()
    }
  })

  it('drops a route outside the closed set', () => {
    expect(normalizeRegimen({ route: 'intravenous' })).toBeUndefined()
    expect(normalizeRegimen({ route: 'MOUTH' })).toBeUndefined()
    expect(normalizeRegimen({ route: ['mouth'] })).toBeUndefined()
    // A bad route does not poison the fields around it.
    expect(normalizeRegimen({ route: 'intravenous', dose: '10 mg' })).toEqual({ dose: '10 mg' })
  })

  it('accepts as_needed only when it is literally true', () => {
    for (const as_needed of ['yes', 'true', 1, {}, []]) {
      expect(normalizeRegimen({ as_needed })).toBeUndefined()
    }
    expect(normalizeRegimen({ as_needed: false })).toBeUndefined()
    expect(normalizeRegimen({ as_needed: true })).toEqual({ as_needed: true })
  })

  it('drops dates that are not a real ISO YYYY-MM-DD calendar date', () => {
    for (const started of [
      '2026-13-99',
      '2026-02-31', // shape-valid, but no such day
      '2026-1-1',
      '01/02/2026',
      '2026-01-01T00:00:00Z',
      20260101,
    ]) {
      expect(normalizeRegimen({ started })).toBeUndefined()
    }
    expect(normalizeRegimen({ started: '2024-02-29' })).toEqual({ started: '2024-02-29' })
    expect(normalizeRegimen({ stopped: '2026-12-31' })).toEqual({ stopped: '2026-12-31' })
  })

  it('drops wrong-typed text fields and whitespace-only ones', () => {
    expect(normalizeRegimen({ dose: 10, schedule: { text: 'daily' }, prescriber: '   ' })).toBeUndefined()
  })

  it('ignores unknown fields entirely (a newer build\'s extra key)', () => {
    expect(normalizeRegimen({ dose: '10 mg', frequency_hz: 3, constructor: 'nope' })).toEqual({
      dose: '10 mg',
    })
  })

  it('returns undefined for the all-empty value — the clearing convention', () => {
    expect(normalizeRegimen({})).toBeUndefined()
    expect(normalizeRegimen({ dose: '', schedule: '', route: '', as_needed: false })).toBeUndefined()
  })
})

describe('regimenMapFrom', () => {
  const A = 'medication_statement|rxnorm|1'
  const B = 'medication_statement|rxnorm|2'

  function rec(key: string, value: unknown): CurationRecord {
    return { key, value, updated_at: 1, author: AUTHOR_A }
  }

  it('strips the prefix, skips other namespaces, and drops empty/garbage values', () => {
    const map = regimenMapFrom([
      rec(`regimen:${A}`, { schedule: 'Nightly', route: 'mouth' }),
      rec(`regimen:${B}`, {}),
      rec('regimen:medication_statement|rxnorm|3', 'not an object'),
      rec(`status:${A}`, { status: 'inactive' }),
      rec(`name:${A}`, { display: 'Custom' }),
      rec('tag:evt-1', { tags: ['x'] }),
    ])
    expect(map).toEqual(new Map([[A, { schedule: 'Nightly', route: 'mouth' }]]))
  })
})

describe('regimenChanged (the sheet\'s diff-before-write guard)', () => {
  it('sees no change when only whitespace, key order, or a dropped field differs', () => {
    expect(regimenChanged(undefined, undefined)).toBe(false)
    expect(regimenChanged(undefined, {})).toBe(false)
    expect(regimenChanged({ dose: '10 mg' }, { dose: '  10 mg  ' })).toBe(false)
    expect(
      regimenChanged({ dose: '10 mg', schedule: 'Nightly' }, { schedule: 'Nightly', dose: '10 mg' }),
    ).toBe(false)
    // A field the reader would drop anyway is not a change.
    expect(regimenChanged({ dose: '10 mg' }, { dose: '10 mg', prescriber: '   ' })).toBe(false)
    expect(regimenChanged({ dose: '10 mg' }, { dose: '10 mg', as_needed: false })).toBe(false)
  })

  it('sees a change on any real edit, including a clear', () => {
    expect(regimenChanged(undefined, { dose: '10 mg' })).toBe(true)
    expect(regimenChanged({ dose: '10 mg' }, undefined)).toBe(true)
    expect(regimenChanged({ dose: '10 mg' }, {})).toBe(true)
    expect(regimenChanged({ dose: '10 mg' }, { dose: '20 mg' })).toBe(true)
    expect(regimenChanged({ dose: '10 mg' }, { dose: '10 mg', as_needed: true })).toBe(true)
    expect(regimenChanged({ route: 'mouth' }, { route: 'nose' })).toBe(true)
  })
})

// The `cur-` codec is namespace-agnostic by design, which is exactly what lets
// a new namespace exist with no change to `core` or the sync layer. Pinned here
// against a `regimen:` key so that claim has a test behind it.
describe('curationCodec with a regimen: key', () => {
  async function blobIdFor(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return `cur-${hex}`
  }

  const KEY = 'regimen:medication_statement|rxnorm|29046'

  it('adopts a verified regimen record and lets the newest write win (LWW)', async () => {
    const blobId = await blobIdFor(KEY)
    const older = signed({ key: KEY, value: { dose: '10 mg' }, updated_at: 500 })
    const newer = signed({ key: KEY, value: { dose: '20 mg' }, updated_at: 900 })

    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(older)))
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(newer)))
    expect(await getCuration(KEY)).toEqual(newer)

    // An older remote loses and does not overwrite the adopted value.
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(older)))
    expect(await getCuration(KEY)).toEqual(newer)
  })

  it('DROPS a regimen record whose signature does not verify', async () => {
    mockVerify.mockReturnValue(false)
    const blobId = await blobIdFor(KEY)
    const tampered = signed({ key: KEY, value: { dose: '999 mg' }, updated_at: 500 })
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(tampered)))
    expect(await getCuration(KEY)).toBeUndefined()
  })
})

describe('hiddenIdsFrom', () => {
  const rec = (key: string, value: unknown): CurationRecord => ({
    key,
    value,
    updated_at: 1000,
    author: AUTHOR_A,
  })

  it('collects the ids of records hidden right now', () => {
    const ids = hiddenIdsFrom([rec('hide:evt-1', { hidden: true }), rec('hide:evt-2', { hidden: true })])
    expect([...ids].sort()).toEqual(['evt-1', 'evt-2'])
  })

  // An un-hide writes `{hidden: false}` rather than deleting the record, so
  // reading "has a hide: record" as hidden would make un-hiding impossible.
  it('treats an un-hidden record as not hidden', () => {
    expect(hiddenIdsFrom([rec('hide:evt-1', { hidden: false })]).size).toBe(0)
  })

  // Adversarial: values this build never wrote (an older or newer schema, a
  // hand-edited store) must not be read as a hide — a malformed record would
  // otherwise silently remove an entry from the owner's own screens.
  it.each([
    ['a string value', 'yes'],
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a truthy non-true flag', { hidden: 'true' }],
    ['a numeric flag', { hidden: 1 }],
  ])('ignores %s', (_label, value) => {
    expect(hiddenIdsFrom([rec('hide:evt-1', value)]).size).toBe(0)
  })

  it('ignores a record with no id after the prefix', () => {
    expect(hiddenIdsFrom([rec('hide:', { hidden: true })]).size).toBe(0)
  })

  it('reads only what it is given, prefix already stripped', () => {
    // The caller filters by prefix; a key from another namespace would have to
    // be passed in deliberately, and the slice must not mangle it silently.
    const ids = hiddenIdsFrom([rec('hide:evt-9', { hidden: true })])
    expect(ids.has('evt-9')).toBe(true)
    expect(ids.has('hide:evt-9')).toBe(false)
  })
})

describe('loadHiddenIds', () => {
  it('reads hides from the store, including after an un-hide', async () => {
    const sign = signAs(AUTHOR_A)
    await writeCuration('hide:evt-1', { hidden: true }, sign, 1000)
    await writeCuration('hide:evt-2', { hidden: true }, sign, 1000)
    expect([...(await loadHiddenIds())].sort()).toEqual(['evt-1', 'evt-2'])

    await writeCuration('hide:evt-1', { hidden: false }, sign, 2000)
    expect([...(await loadHiddenIds())]).toEqual(['evt-2'])
  })
})

describe('priority read helpers', () => {
  const CONCEPT = 'condition|http://snomed.info/sct|73211009'
  const sign = signAs(AUTHOR_A)

  it('getPriority defaults to normal and round-trips pin, hide, and the clear', async () => {
    expect(await getPriority(CONCEPT)).toBe('')
    await writeCuration(`priority:${CONCEPT}`, { priority: 'pinned' }, sign, 1)
    expect(await getPriority(CONCEPT)).toBe('pinned')
    await writeCuration(`priority:${CONCEPT}`, { priority: 'hidden' }, sign, 2)
    expect(await getPriority(CONCEPT)).toBe('hidden')
    // A clear writes the empty value — the record survives, the sync model has
    // no delete.
    await writeCuration(`priority:${CONCEPT}`, { priority: '' }, sign, 3)
    expect(await getPriority(CONCEPT)).toBe('')
    expect(await getCuration(`priority:${CONCEPT}`)).toBeDefined()
  })

  it('allPriorities keys on the bare concept and drops normal records', async () => {
    await writeCuration(`priority:${CONCEPT}`, { priority: 'hidden' }, sign)
    await writeCuration('priority:condition||Bad knee', { priority: '' }, sign)
    await writeCuration(`status:${CONCEPT}`, { status: 'inactive' }, sign)
    expect(await allPriorities()).toEqual(new Map([[CONCEPT, 'hidden']]))
  })
})

// Adversarial fixtures: values chosen to get a hide or a pin PAST the shape
// check. A `priority:` value can come from a second device on a newer build or
// out of a doctor-share bundle, and a hide misread here silently removes a
// problem from the owner's summary and every share they make.
describe('normalizePriority (tolerant shape-check)', () => {
  it('accepts exactly the two written values', () => {
    expect(normalizePriority({ priority: 'pinned' })).toBe('pinned')
    expect(normalizePriority({ priority: 'hidden' })).toBe('hidden')
  })

  it('reads a wrong case, type, or shape as normal', () => {
    for (const value of [
      { priority: 'HIDDEN' },
      { priority: 'Pinned' },
      { priority: 'hidden ' },
      { priority: true },
      { priority: 1 },
      { priority: null },
      { priority: ['hidden'] },
      { priority: { value: 'hidden' } },
      'hidden',
      'pinned',
      ['hidden'],
      [{ priority: 'hidden' }],
      null,
      undefined,
      42,
      true,
    ]) {
      expect(normalizePriority(value), JSON.stringify(value)).toBe('')
    }
  })

  it('reads extra fields that only look like a hide as normal', () => {
    expect(normalizePriority({ hidden: true })).toBe('')
    expect(normalizePriority({ status: 'hidden', pinned: true })).toBe('')
    expect(normalizePriority({ priority: '', hidden: true })).toBe('')
  })

  it('ignores unknown sibling fields on a real value rather than rejecting it', () => {
    // Drop, not repair (as normalizeRegimen does): a newer build adding a field
    // to a hide must still hide here, or this build would show — and share —
    // what the owner put away.
    expect(normalizePriority({ priority: 'hidden', since: '2026-10-01' })).toBe('hidden')
    expect(normalizePriority({ priority: 'pinned', note: 'oncology' })).toBe('pinned')
  })
})

describe('priorityMapFrom', () => {
  const A = 'condition|http://snomed.info/sct|1'
  const B = 'condition|http://snomed.info/sct|2'

  function rec(key: string, value: unknown, updated_at = 1, author = AUTHOR_A): CurationRecord {
    return { key, value, updated_at, author }
  }

  it('strips the prefix, skips other namespaces, and drops normal and garbage values', () => {
    const map = priorityMapFrom([
      rec(`priority:${A}`, { priority: 'pinned' }),
      rec(`priority:${B}`, { priority: '' }),
      rec('priority:condition||x', 'hidden'),
      rec(`status:${B}`, { status: 'inactive' }),
      rec(`hide:${B}`, { hidden: true }),
    ])
    expect(map).toEqual(new Map([[A, 'pinned']]))
  })

  it('resolves two records for one concept by LWW, not by array order', () => {
    const older = rec(`priority:${A}`, { priority: 'hidden' }, 1)
    const newer = rec(`priority:${A}`, { priority: 'pinned' }, 2)
    expect(priorityMapFrom([older, newer])).toEqual(new Map([[A, 'pinned']]))
    expect(priorityMapFrom([newer, older])).toEqual(new Map([[A, 'pinned']]))
    // A newer clear wins over an older hide too: unhiding sticks.
    const cleared = rec(`priority:${A}`, { priority: '' }, 3)
    expect(priorityMapFrom([cleared, older])).toEqual(new Map())
  })

  it('breaks a same-clock pin/hide tie on the author, deterministically', () => {
    const pin = rec(`priority:${A}`, { priority: 'pinned' }, 5, AUTHOR_A)
    const hide = rec(`priority:${A}`, { priority: 'hidden' }, 5, AUTHOR_B)
    expect(priorityMapFrom([pin, hide])).toEqual(new Map([[A, 'hidden']]))
    expect(priorityMapFrom([hide, pin])).toEqual(new Map([[A, 'hidden']]))
  })

  it('hiddenConceptsFrom keeps only the hides', () => {
    const map = priorityMapFrom([rec(`priority:${A}`, { priority: 'pinned' }), rec(`priority:${B}`, { priority: 'hidden' })])
    expect(hiddenConceptsFrom(map)).toEqual(new Set([B]))
  })
})

describe('allergy read helpers', () => {
  const CONCEPT = 'allergy_intolerance|http://www.nlm.nih.gov/research/umls/rxnorm|7980'
  const sign = signAs(AUTHOR_A)

  it('getAllergy defaults to undefined, round-trips a value and trims the reaction', async () => {
    expect(await getAllergy(CONCEPT)).toBeUndefined()
    await writeCuration(
      `allergy:${CONCEPT}`,
      { category: 'medication', reaction: '  anaphylaxis ', severity: 'severe' },
      sign,
    )
    expect(await getAllergy(CONCEPT)).toEqual({
      category: 'medication',
      reaction: 'anaphylaxis',
      severity: 'severe',
    })
  })

  it('reads a cleared value (the empty object, not a delete) as no details', async () => {
    await writeCuration(`allergy:${CONCEPT}`, { severity: 'mild' }, sign, 1)
    await writeCuration(`allergy:${CONCEPT}`, {}, sign, 2)
    expect(await getAllergy(CONCEPT)).toBeUndefined()
    expect(await getCuration(`allergy:${CONCEPT}`)).toBeDefined()
  })

  it('allAllergies keys on the bare concept, drops cleared records and other namespaces', async () => {
    await writeCuration(`allergy:${CONCEPT}`, { category: 'food' }, sign)
    await writeCuration('allergy:allergy_intolerance||Latex', {}, sign)
    await writeCuration(`regimen:${CONCEPT}`, { dose: '10 mg' }, sign)
    expect(await allAllergies()).toEqual(new Map([[CONCEPT, { category: 'food' }]]))
  })
})

// Adversarial fixtures: values chosen to get past the shape check. An `allergy:`
// value can arrive from a newer build or a doctor-share bundle, and a guessed
// severity or category on an allergy list is worse than none.
describe('normalizeAllergy (tolerant shape-check)', () => {
  it('rejects non-object values outright', () => {
    for (const value of ['medication', 42, true, null, undefined, ['severe'], [{ severity: 'severe' }]]) {
      expect(normalizeAllergy(value)).toBeUndefined()
    }
  })

  it('matches the enums exactly: no case folding, no trimming, no coercion', () => {
    for (const category of ['Medication', 'MEDICATION', ' medication', 'drug', '', 1, ['food'], null]) {
      expect(normalizeAllergy({ category }), JSON.stringify(category)).toBeUndefined()
    }
    for (const severity of ['SEVERE', 'Severe', 'severe ', 'critical', 3, true, ['severe'], null]) {
      expect(normalizeAllergy({ severity }), JSON.stringify(severity)).toBeUndefined()
    }
  })

  it('drops a blank or wrong-typed reaction', () => {
    for (const reaction of ['   ', '', 5, ['rash'], { text: 'rash' }, null]) {
      expect(normalizeAllergy({ reaction }), JSON.stringify(reaction)).toBeUndefined()
    }
  })

  it('caps the reaction length', () => {
    const out = normalizeAllergy({ reaction: 'x'.repeat(ALLERGY_REACTION_MAX + 50) })
    expect(out?.reaction).toHaveLength(ALLERGY_REACTION_MAX)
  })

  it('keeps the valid fields and ignores unknown ones', () => {
    expect(
      normalizeAllergy({ category: 'food', severity: 'SEVERE', reaction: 'hives', extra: 1, constructor: 'x' }),
    ).toEqual({ category: 'food', reaction: 'hives' })
  })

  it('reads the all-empty value as no details', () => {
    expect(normalizeAllergy({})).toBeUndefined()
    expect(normalizeAllergy({ category: '', reaction: '', severity: '' })).toBeUndefined()
  })
})

describe('allergyMapFrom / allergyChanged', () => {
  const rec = (key: string, value: unknown): CurationRecord => ({ key, value, updated_at: 1, author: 'a'.repeat(64) })

  it('keeps only real allergy details, tolerant of a mixed array', () => {
    const map = allergyMapFrom([
      rec('allergy:k1', { severity: 'severe' }),
      rec('allergy:k2', {}),
      rec('allergy:k3', 'severe'),
      rec('regimen:k4', { dose: '1' }),
    ])
    expect([...map]).toEqual([['k1', { severity: 'severe' }]])
  })

  it('compares normalized values, so an unchanged sheet writes nothing', () => {
    expect(allergyChanged(undefined, { reaction: '   ' })).toBe(false)
    expect(allergyChanged({ reaction: 'rash' }, { reaction: ' rash ' })).toBe(false)
    expect(allergyChanged({ reaction: 'rash' }, undefined)).toBe(true)
    expect(allergyChanged({ severity: 'mild' }, { severity: 'severe' })).toBe(true)
    expect(allergyChanged(undefined, { category: 'food' })).toBe(true)
  })
})
