import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb, deleteDb, get, put, putAll, mutate, del, getAll, getAllFromIndex, count } from '../db'

// deleteDb() (not a raw indexedDB.deleteDatabase call) so the module's
// memoized connection is closed and cleared, not left dangling from the
// previous test.
beforeEach(deleteDb)

describe('MIGRATIONS', () => {
  it('creates the expected object stores and indexes', async () => {
    const db = await openDb()
    expect(db.version).toBe(MIGRATIONS.length)
    expect([...db.objectStoreNames].sort()).toEqual(
      ['admin_log', 'attachments', 'chat', 'curation', 'dictionary', 'doctor_shares', 'events', 'file_shares', 'keyvault', 'notifications', 'prefs', 'proposals', 'proposers', 'provenance', 'secrets', 'shared_events', 'shares', 'sync'].sort(),
    )

    const proposalsTx = db.transaction('proposals', 'readonly')
    expect([...proposalsTx.objectStore('proposals').indexNames].sort()).toEqual(['from', 'receivedAt'].sort())

    const chatTx = db.transaction('chat', 'readonly')
    expect([...chatTx.objectStore('chat').indexNames]).toEqual(['createdAt'])

    const adminTx = db.transaction('admin_log', 'readonly')
    expect([...adminTx.objectStore('admin_log').indexNames]).toEqual(['sentAt'])

    const tx = db.transaction('events', 'readonly')
    const events = tx.objectStore('events')
    expect([...events.indexNames].sort()).toEqual(['effective_at', 'kind'].sort())

    const sharedTx = db.transaction('shared_events', 'readonly')
    expect([...sharedTx.objectStore('shared_events').indexNames]).toEqual(['by-owner'])

    const curationTx = db.transaction('curation', 'readonly')
    expect([...curationTx.objectStore('curation').indexNames]).toEqual(['updated_at'])

    const notifTx = db.transaction('notifications', 'readonly')
    expect([...notifTx.objectStore('notifications').indexNames]).toEqual(['createdAt'])
  })
})

describe('notifications (v7)', () => {
  it('round-trips a notification keyed by id and queries by createdAt', async () => {
    const record = { id: 'app-update:1', kind: 'app-update', title: 'Update', createdAt: '2026-07-22T00:00:00Z' }
    await put('notifications', record)
    expect(await get('notifications', 'app-update:1')).toEqual(record)

    const byCreatedAt = await getAllFromIndex('notifications', 'createdAt', IDBKeyRange.lowerBound('2026-07-01T00:00:00Z'))
    expect(byCreatedAt).toEqual([record])
  })
})

describe('attachments (v5)', () => {
  it('round-trips a captured-document record keyed by sha256', async () => {
    const record = {
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
      capturedAt: '2026-07-15T00:00:00.000Z',
    }
    await put('attachments', record)
    expect(await get('attachments', 'a'.repeat(64))).toEqual(record)
  })
})

describe('curation (v3)', () => {
  it('round-trips a curation record (keyPath store) and queries by updated_at', async () => {
    const record = { key: 'tag:evt-1', value: { tags: ['flare'] }, updated_at: 1_000, author: 'a'.repeat(64) }
    await put('curation', record)
    expect(await get('curation', 'tag:evt-1')).toEqual(record)

    const byUpdatedAt = await getAllFromIndex('curation', 'updated_at', IDBKeyRange.lowerBound(500))
    expect(byUpdatedAt).toEqual([record])
  })
})

describe('shares and shared_events (v2)', () => {
  it('round-trips a share (explicit-keyPath store)', async () => {
    const share = {
      ownerEd: 'a'.repeat(64),
      ownerX: 'b'.repeat(64),
      label: 'Partner',
      wrappedKeyHex: 'ab',
      hue: 'b' as const,
      acceptedAt: '2026-01-01T00:00:00Z',
    }
    await put('shares', share)
    expect(await get('shares', share.ownerEd)).toEqual(share)
  })

  it('round-trips a compound-keyPath shared event and queries it by owner', async () => {
    const ownerEd = 'a'.repeat(64)
    const row = { ownerEd, id: 'evt-1', event: { event: { id: 'evt-1' } } }
    await put('shared_events', row)
    expect(await get('shared_events', [ownerEd, 'evt-1'])).toEqual(row)

    const byOwner = await getAllFromIndex('shared_events', 'by-owner', IDBKeyRange.only(ownerEd))
    expect(byOwner).toEqual([row])
  })
})

describe('CRUD helpers', () => {
  it('round-trips a keyPath store (events)', async () => {
    const event = {
      event: { id: 'evt-1', kind: 'observation', effective_at: '2026-01-01T00:00:00Z' },
    }
    await put('events', event)
    expect(await get('events', 'evt-1')).toEqual(event)
    expect(await getAll('events')).toEqual([event])

    await del('events', 'evt-1')
    expect(await get('events', 'evt-1')).toBeUndefined()
  })

  it('round-trips an explicit-key store (keyvault)', async () => {
    await put('keyvault', { sealed_hex: 'ab' }, 'mnemonic')
    expect(await get('keyvault', 'mnemonic')).toEqual({ sealed_hex: 'ab' })
  })

  it('putAll lands a batch in one call, overwriting like put', async () => {
    await put('events', { event: { id: 'a', kind: 'note', effective_at: '2026-01-01' } })
    await putAll('events', [
      { event: { id: 'a', kind: 'observation', effective_at: '2026-01-01' } },
      { event: { id: 'b', kind: 'observation', effective_at: '2026-01-02' } },
    ])
    const all = await getAll<{ event: { id: string; kind: string } }>('events')
    expect(all.map((e) => [e.event.id, e.event.kind]).sort()).toEqual([
      ['a', 'observation'],
      ['b', 'observation'],
    ])
  })

  it('putAll with an empty batch is a no-op', async () => {
    await putAll('events', [])
    expect(await getAll('events')).toEqual([])
  })

  it('mutate inserts when nothing is stored and updates what is', async () => {
    const first = await mutate<{ n: number }>('prefs', 'counter', (current) => ({
      n: (current?.n ?? 0) + 1,
    }))
    expect(first).toEqual({ written: true, value: { n: 1 } })

    const second = await mutate<{ n: number }>('prefs', 'counter', (current) => ({
      n: (current?.n ?? 0) + 1,
    }))
    expect(second).toEqual({ written: true, value: { n: 2 } })
    expect(await get('prefs', 'counter')).toEqual({ n: 2 })
  })

  // `prefs` takes an out-of-line key; `proposals` derives its key from the
  // record. Handing the latter an explicit key is a DataError that aborts the
  // transaction, so the helper has to tell the two shapes apart.
  it('mutate writes an in-line-key store, keyed off the record', async () => {
    await put('proposals', { id: 'm1', resultSent: false })
    const { written, value } = await mutate<{ id: string; resultSent: boolean }>(
      'proposals',
      'm1',
      (record) => ({ ...record!, resultSent: true }),
    )
    expect(written).toBe(true)
    expect(value).toEqual({ id: 'm1', resultSent: true })
    expect(await get('proposals', 'm1')).toEqual({ id: 'm1', resultSent: true })
  })

  it('mutate declines the write when the mutator returns undefined', async () => {
    await put('prefs', { n: 7 }, 'counter')
    expect(await mutate('prefs', 'counter', () => undefined)).toEqual({
      written: false,
      value: { n: 7 },
    })
    expect(await get('prefs', 'counter')).toEqual({ n: 7 })

    // Declining on a key that holds nothing reports exactly that.
    expect(await mutate('prefs', 'absent', () => undefined)).toEqual({
      written: false,
      value: undefined,
    })
  })

  it('mutate rejects and writes nothing when the mutator throws', async () => {
    await put('prefs', { n: 7 }, 'counter')
    await expect(
      mutate('prefs', 'counter', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await get('prefs', 'counter')).toEqual({ n: 7 })
  })

  // The reason the helper exists, pinned against the shape it replaces: three
  // read-modify-writes issued together. Two transactions per update (get, then
  // put) means all three read 0 and the last writer wins, landing 1 — the lost
  // update. One transaction per update serializes them, landing 3.
  it('mutate loses no update under concurrency, where a get-then-put pair does', async () => {
    await put('prefs', 0, 'viaGetPut')
    const viaGetPut = async () => {
      const n = (await get<number>('prefs', 'viaGetPut')) ?? 0
      await put('prefs', n + 1, 'viaGetPut')
    }
    await Promise.all([viaGetPut(), viaGetPut(), viaGetPut()])
    expect(await get('prefs', 'viaGetPut')).toBe(1)

    await put('prefs', 0, 'viaMutate')
    const viaMutate = () => mutate<number>('prefs', 'viaMutate', (n) => (n ?? 0) + 1)
    await Promise.all([viaMutate(), viaMutate(), viaMutate()])
    expect(await get('prefs', 'viaMutate')).toBe(3)
  })

  it('queries by index and range', async () => {
    await put('events', { event: { id: 'a', kind: 'observation', effective_at: '2026-01-01' } })
    await put('events', { event: { id: 'b', kind: 'observation', effective_at: '2026-01-03' } })
    await put('events', { event: { id: 'c', kind: 'note', effective_at: '2026-01-02' } })

    const observations = await getAllFromIndex<{ event: { id: string } }>(
      'events',
      'kind',
      IDBKeyRange.only('observation'),
    )
    expect(observations.map((e) => e.event.id).sort()).toEqual(['a', 'b'])

    expect(await count('events')).toBe(3)
  })
})
