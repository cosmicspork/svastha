import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb, deleteDb, get, put, del, getAll, getAllFromIndex, count } from '../db'

// deleteDb() (not a raw indexedDB.deleteDatabase call) so the module's
// memoized connection is closed and cleared, not left dangling from the
// previous test.
beforeEach(deleteDb)

describe('MIGRATIONS', () => {
  it('creates the expected object stores and indexes', async () => {
    const db = await openDb()
    expect(db.version).toBe(MIGRATIONS.length)
    expect([...db.objectStoreNames].sort()).toEqual(
      ['events', 'keyvault', 'prefs', 'provenance', 'sync'].sort(),
    )

    const tx = db.transaction('events', 'readonly')
    const events = tx.objectStore('events')
    expect([...events.indexNames].sort()).toEqual(['effective_at', 'kind'].sort())
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
