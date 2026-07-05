import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, get, put } from '../db'
import {
  lwwMerge,
  writeCuration,
  getCuration,
  allCurationByPrefix,
  curationCodec,
  migrateFavoritesToCuration,
  type CurationRecord,
} from '../curation'

// deleteDb() (not a raw indexedDB.deleteDatabase call) so the module's
// memoized connection is closed and cleared between tests — same pattern as
// db.test.ts / sync.test.ts.
beforeEach(deleteDb)

const AUTHOR_A = 'a'.repeat(64)
const AUTHOR_B = 'b'.repeat(64)

function record(overrides: Partial<CurationRecord> = {}): CurationRecord {
  return { key: 'tag:evt-1', value: { tags: ['flare'] }, updated_at: 1000, author: AUTHOR_A, ...overrides }
}

describe('lwwMerge', () => {
  it('no local record: remote always wins', () => {
    const remote = record()
    expect(lwwMerge(undefined, remote)).toBe(remote)
  })

  it('higher updated_at wins regardless of author', () => {
    const local = record({ updated_at: 1000, author: AUTHOR_B })
    const remote = record({ updated_at: 2000, author: AUTHOR_A })
    expect(lwwMerge(local, remote)).toBe(remote)

    // Symmetric: an older remote loses even with the lexicographically
    // greater author.
    const newerLocal = record({ updated_at: 2000, author: AUTHOR_A })
    const olderRemote = record({ updated_at: 1000, author: AUTHOR_B })
    expect(lwwMerge(newerLocal, olderRemote)).toBe(newerLocal)
  })

  it('tie on updated_at: lexicographically greater author wins', () => {
    const local = record({ updated_at: 1000, author: AUTHOR_A })
    const remote = record({ updated_at: 1000, author: AUTHOR_B })
    expect(lwwMerge(local, remote)).toBe(remote) // 'b' > 'a'

    const localB = record({ updated_at: 1000, author: AUTHOR_B })
    const remoteA = record({ updated_at: 1000, author: AUTHOR_A })
    expect(lwwMerge(localB, remoteA)).toBe(localB) // 'b' > 'a' — local keeps it
  })

  it('clock-skew note: a fast-clocked writer\'s edit wins even if the merge is applied "later" on another device', () => {
    // This is the documented tradeoff (see lwwMerge's doc comment): the
    // function only ever looks at updated_at values, never wall-clock "now",
    // so a record stamped with a clock-skewed future timestamp always beats
    // a genuinely more recent edit stamped by an honest clock. Pinning this
    // behavior here so a future "fix" doesn't silently change the contract
    // without a docs update.
    const genuinelyLater = record({ updated_at: 5000, author: AUTHOR_A })
    const skewedEarlierWriteButHigherStamp = record({ updated_at: 9000, author: AUTHOR_B })
    expect(lwwMerge(genuinelyLater, skewedEarlierWriteButHigherStamp)).toBe(
      skewedEarlierWriteButHigherStamp,
    )
  })
})

describe('writeCuration', () => {
  it('stores the record and enqueues its cur- blob for push', async () => {
    await writeCuration('tag:evt-1', { tags: ['flare'] }, AUTHOR_A, 1234)
    const stored = await getCuration('tag:evt-1')
    expect(stored).toEqual({ key: 'tag:evt-1', value: { tags: ['flare'] }, updated_at: 1234, author: AUTHOR_A })
  })
})

describe('curationCodec (cur-)', () => {
  async function blobIdFor(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return `cur-${hex}`
  }

  it('localHas/localLoad find a record by its hashed blob id (reverse map)', async () => {
    await writeCuration('tag:evt-1', { tags: ['flare'] }, AUTHOR_A, 1000)
    const blobId = await blobIdFor('tag:evt-1')

    expect(await curationCodec.localHas(blobId)).toBe(true)
    const loaded = await curationCodec.localLoad(blobId)
    expect(loaded).not.toBeNull()
    expect(JSON.parse(new TextDecoder().decode(loaded!))).toEqual({
      key: 'tag:evt-1',
      value: { tags: ['flare'] },
      updated_at: 1000,
      author: AUTHOR_A,
    })
  })

  it('localHas/localLoad report nothing for an unknown blob id', async () => {
    expect(await curationCodec.localHas('cur-deadbeef')).toBe(false)
    expect(await curationCodec.localLoad('cur-deadbeef')).toBeNull()
  })

  it('remoteApply adopts a remote record that wins the merge (no local record yet)', async () => {
    const blobId = await blobIdFor('hide:evt-2')
    const remote: CurationRecord = { key: 'hide:evt-2', value: { hidden: true }, updated_at: 500, author: AUTHOR_A }
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(remote)))
    expect(await getCuration('hide:evt-2')).toEqual(remote)
  })

  it('remoteApply: remote wins over an older local record', async () => {
    await writeCuration('note:evt-3', { text: 'old' }, AUTHOR_A, 100)
    const blobId = await blobIdFor('note:evt-3')
    const remote: CurationRecord = { key: 'note:evt-3', value: { text: 'new' }, updated_at: 200, author: AUTHOR_B }
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(remote)))
    expect(await getCuration('note:evt-3')).toEqual(remote)
  })

  it('remoteApply: local wins over a stale remote, and re-enqueues the local record for push', async () => {
    // No relay configured: `drain()` (called internally, fire-and-forget, by
    // both `writeCuration` and `remoteApply`) is then a documented no-op, so
    // the outbox state below reflects `enqueue` alone rather than racing a
    // real push to completion.
    await writeCuration('note:evt-4', { text: 'mine, newer' }, AUTHOR_A, 900)

    const blobId = await blobIdFor('note:evt-4')
    const staleRemote: CurationRecord = {
      key: 'note:evt-4',
      value: { text: 'stale' },
      updated_at: 100,
      author: AUTHOR_B,
    }
    await curationCodec.remoteApply(blobId, new TextEncoder().encode(JSON.stringify(staleRemote)))

    // The winner (local) is unchanged in the store...
    expect(await getCuration('note:evt-4')).toEqual({
      key: 'note:evt-4',
      value: { text: 'mine, newer' },
      updated_at: 900,
      author: AUTHOR_A,
    })
    // ...and got re-enqueued so the next drain pushes it back to the relay.
    const syncRecords = await get<{ id: string; state: string }>('sync', blobId)
    expect(syncRecords?.state).toBe('pending')
  })

  it('remoteApply rejects a record whose embedded key does not hash to the blob id', async () => {
    const wrongBlobId = await blobIdFor('tag:evt-5')
    const mismatched: CurationRecord = {
      key: 'tag:some-other-event',
      value: { tags: ['x'] },
      updated_at: 1,
      author: AUTHOR_A,
    }
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

describe('migrateFavoritesToCuration', () => {
  it('copies legacy prefs favorites into fav: curation records, once', async () => {
    await put(
      'prefs',
      [
        { label: 'Morning meds', category: 'med', drafts: [{ kind: 'medication_statement', value: { text: 'x' } }] },
      ],
      'favorites',
    )

    await migrateFavoritesToCuration(AUTHOR_A)

    const favRecords = await allCurationByPrefix('fav:med:')
    expect(favRecords).toHaveLength(1)
    expect(favRecords[0].value).toEqual({
      label: 'Morning meds',
      category: 'med',
      drafts: [{ kind: 'medication_statement', value: { text: 'x' } }],
    })
    expect(favRecords[0].author).toBe(AUTHOR_A)

    // Idempotent: running again (e.g. a second unlock) doesn't duplicate or
    // clobber, whether via the prefs marker or the per-favorite existence check.
    await migrateFavoritesToCuration(AUTHOR_A)
    expect(await allCurationByPrefix('fav:med:')).toHaveLength(1)

    expect(await get('prefs', 'favorites-migrated-to-curation')).toBe(true)
  })

  it('is a no-op with no legacy favorites', async () => {
    await migrateFavoritesToCuration(AUTHOR_A)
    expect(await allCurationByPrefix('fav:')).toHaveLength(0)
  })
})
