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
  // v3: the curation overlay (see lib/curation.ts) — the store's only mutable
  // records (tags, notes, hides, favorites), keyed on the curation record's
  // own namespaced `key` (e.g. `tag:{event_id}`). `updated_at` is indexed so a
  // future admin/debug view can page through the most recently touched
  // records without a full scan.
  (db) => {
    const curation = db.createObjectStore('curation', { keyPath: 'key' })
    curation.createIndex('updated_at', 'updated_at')
  },
  // v4: doctor shares (see lib/doctorShare.ts) — device-local records of the
  // sealed bundles this device uploaded to the relay for a clinician, keyed by
  // the share's bearer token. Holds the per-share key so an active share's
  // link/QR can be re-shown until expiry; this store never syncs (cross-device
  // manage is deferred by design).
  (db) => {
    db.createObjectStore('doctor_shares', { keyPath: 'token' })
  },
  // v5: the optional offline code dictionary (see lib/dictionary.ts) — one row
  // per terminology system, each holding that system's whole `{code: name}` map
  // as a single blob. Public reference data, never synced and never sensitive;
  // stored as per-system blobs (not row-per-code) so a download is one put, a
  // removal one clear, and unlock hydrates the lot with a single getAll.
  (db) => {
    db.createObjectStore('dictionary', { keyPath: 'system' })
  },
  // v6: captured-document bytes (see lib/attachments.ts) — one row per
  // photographed paper record, keyed by the content hash of its plaintext
  // bytes, exactly as the `provenance` store holds imported source documents.
  // The bytes are at rest as plaintext (origin isolation + OS disk encryption
  // are the boundary, same as `events`/`provenance`); the `att-` sync codec
  // seals them under the vault key only for transport.
  (db) => {
    db.createObjectStore('attachments', { keyPath: 'sha256' })
  },
  // v7: local notifications (see lib/notifications.ts) — device-local, never
  // synced. One row per notification keyed by a caller-supplied stable id (so a
  // re-derived source can't duplicate); `createdAt` is indexed so the store can
  // read newest-first and prune past the cap without a full-scan sort.
  (db) => {
    const notifications = db.createObjectStore('notifications', { keyPath: 'id' })
    notifications.createIndex('createdAt', 'createdAt')
  },
  // v8: the proposal inbox (see lib/proposals.ts) — device-local, never synced.
  // `proposals` holds one row per received proposal *message*, keyed by the
  // envelope message id (the spec's dedupe identity), so a re-pull of the same
  // mailbox item never re-processes it; `from` indexes the proposer for the
  // grouped inbox. `proposers` is the small identity directory the inbox
  // resolves a proposer's label and X25519 reply key from (populated by node
  // enrollment; read here to seal the proposal_result back to the proposer).
  (db) => {
    const proposals = db.createObjectStore('proposals', { keyPath: 'id' })
    proposals.createIndex('from', 'fromEd')
    proposals.createIndex('receivedAt', 'receivedAt')

    db.createObjectStore('proposers', { keyPath: 'ed' })
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

export async function clear(storeName: string): Promise<void> {
  const s = await store(storeName, 'readwrite')
  await requestToPromise(s.clear())
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
