// Hand-rolled IndexedDB wrapper: promise-based helpers plus a migration list,
// so schema changes are additive and ordered instead of one big
// upgradeneeded switch. No dependency — the API surface we need (single-store
// get/put/getAll) is small enough that a wrapper library isn't worth the
// weight.

const DB_NAME = 'svastha'

/** One migration per version bump; `db.version` (below) is derived from the
 * array length, so adding a migration is the only thing a schema change needs. */
export const MIGRATIONS: ((db: IDBDatabase, tx: IDBTransaction) => void)[] = [
  // v1: the initial event log, key custody, sync cursor, provenance blobs, and
  // small local prefs.
  (db) => {
    const events = db.createObjectStore('events', { keyPath: 'event.id' })
    events.createIndex('effective_at', 'event.effective_at')
    events.createIndex('kind', 'event.kind')

    db.createObjectStore('keyvault')
    db.createObjectStore('sync', { keyPath: 'id' })
    db.createObjectStore('provenance', { keyPath: 'sha256' })
    db.createObjectStore('prefs')
  },
  // v2: spousal sharing — accepted shares (one row per person who shared their
  // vault with this device) and the read-only event cache pulled from each.
  (db) => {
    db.createObjectStore('shares', { keyPath: 'ownerEd' })

    // Compound keyPath: an id is only unique within one owner's log, and a
    // device may hold events from several shares, so the key must be the pair.
    const sharedEvents = db.createObjectStore('shared_events', { keyPath: ['ownerEd', 'id'] })
    sharedEvents.createIndex('by-owner', 'ownerEd')
  },
]

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

/** Open (and lazily migrate) the database. Memoized — safe to call anywhere. */
export function openDb(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, MIGRATIONS.length)
    req.onupgradeneeded = (event) => {
      const db = req.result
      const tx = req.transaction!
      const newVersion = event.newVersion ?? MIGRATIONS.length
      for (let v = event.oldVersion; v < newVersion; v++) {
        MIGRATIONS[v](db, tx)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/** Drop the whole database (e.g. restore-over-existing). Clears the memoized
 * handle so a later `openDb()` reopens fresh. */
export async function deleteDb(): Promise<void> {
  const db = await openDb()
  db.close()
  dbPromise = null
  await requestToPromise(indexedDB.deleteDatabase(DB_NAME))
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(name, mode).objectStore(name)
}

export async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const s = await store(storeName, 'readonly')
  return requestToPromise(s.get(key))
}

/** Put a record. For stores without a `keyPath` (keyvault, prefs), pass `key`. */
export async function put(
  storeName: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  const s = await store(storeName, 'readwrite')
  await requestToPromise(s.put(value, key))
}

export async function del(storeName: string, key: IDBValidKey): Promise<void> {
  const s = await store(storeName, 'readwrite')
  await requestToPromise(s.delete(key))
}

export async function getAll<T>(storeName: string): Promise<T[]> {
  const s = await store(storeName, 'readonly')
  return requestToPromise(s.getAll())
}

export async function getAllFromIndex<T>(
  storeName: string,
  indexName: string,
  range?: IDBKeyRange,
): Promise<T[]> {
  const s = await store(storeName, 'readonly')
  return requestToPromise(s.index(indexName).getAll(range))
}

export async function count(storeName: string, range?: IDBKeyRange): Promise<number> {
  const s = await store(storeName, 'readonly')
  return requestToPromise(s.count(range))
}
