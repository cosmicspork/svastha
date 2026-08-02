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
  // v9: the ask screen (RAG chat) and node admin surface (see lib/chat.ts,
  // lib/nodeadmin.ts) — both device-local, never synced; the medical content in
  // a chat turn is sealed on the mailbox and only ever at rest here (same
  // boundary as `events`). `chat` holds one row per conversation turn, keyed by
  // the mailbox envelope message id (the spec's dedupe identity, so a re-pulled
  // answer never doubles), `createdAt` indexed for chronological render.
  // `admin_log` holds one row per owner→node `admin_cmd`, keyed by that
  // command's envelope id so the node's `admin_reply` (which carries
  // `in_reply_to`) folds back onto it; `sentAt` indexed for newest-first.
  (db) => {
    const chat = db.createObjectStore('chat', { keyPath: 'id' })
    chat.createIndex('createdAt', 'createdAt')

    const adminLog = db.createObjectStore('admin_log', { keyPath: 'id' })
    adminLog.createIndex('sentAt', 'sentAt')
  },
  // v10: relay-less file shares (see lib/fileShare.ts) — device-local history of
  // shares exported as a handed-over file, keyed by a synthetic id. Distinct
  // from `doctor_shares` on purpose: a file share holds no bearer token, no key
  // material, and no expiry, is unrevocable by construction, and so must never
  // be swept by the relay-link tombstone purge. Never synced.
  (db) => {
    db.createObjectStore('file_shares', { keyPath: 'id' })
  },
  // v11: device-local bearer credentials (see lib/inference.ts) — sealed under
  // the session's vault key, never in `prefs`, which is plaintext at rest. Keyed
  // by a short name. Never synced: these authenticate *this device* to a service
  // the owner chose, so they are not vault content and must not travel to other
  // devices, where they could not be scoped or revoked independently anyway.
  (db) => {
    db.createObjectStore('secrets')
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

/**
 * Put a batch of records in a **single** `readwrite` transaction — one commit
 * instead of one per record. The puts are issued synchronously: an `await`
 * between requests would let the transaction auto-commit under the remaining
 * ones. Only for stores with a `keyPath` (no out-of-line keys).
 */
export function putAll(storeName: string, values: unknown[]): Promise<void> {
  if (values.length === 0) return Promise.resolve()
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const s = tx.objectStore(storeName)
        for (const value of values) s.put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('putAll aborted'))
      }),
  )
}

/**
 * Read-modify-write one record inside a **single** `readwrite` transaction.
 *
 * `get` then `put` as two calls is two transactions, so another tab (or another
 * in-flight task in this one) can land between them and be overwritten. This
 * keeps both in one transaction, which is what makes a compare-and-update
 * actually compare: `mutate` can read the stored value, decide it is not the one
 * it meant to update, and decline — with no window in which that decision goes
 * stale. See `answerScope.ts`'s `trackScopeDelivery`.
 *
 * `fn` must be **synchronous and side-effect-free**. It runs inside the
 * transaction's request callback; an `await` in there would let the transaction
 * auto-commit and the `put` would throw `TransactionInactiveError`. Deliberately
 * built on raw request callbacks rather than the promise helper above so there is
 * no microtask hop between the read and the write to reason about.
 *
 * Returning `undefined` from `fn` declines the write and leaves the stored value
 * untouched; `written` says which happened, and `value` is the stored value
 * afterwards either way.
 */
export function mutate<T>(
  storeName: string,
  key: IDBValidKey,
  fn: (current: T | undefined) => T | undefined,
): Promise<{ written: boolean; value: T | undefined }> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let outcome: { written: boolean; value: T | undefined } | undefined
        let failure: unknown
        const tx = db.transaction(storeName, 'readwrite')
        const s = tx.objectStore(storeName)
        const read = s.get(key)
        read.onsuccess = () => {
          let next: T | undefined
          try {
            next = fn(read.result as T | undefined)
          } catch (e) {
            // A throwing mutator must not commit a half-decided write.
            failure = e
            tx.abort()
            return
          }
          if (next === undefined) {
            outcome = { written: false, value: read.result as T | undefined }
            return
          }
          const write = s.put(next, key)
          write.onsuccess = () => (outcome = { written: true, value: next })
        }
        tx.oncomplete = () =>
          outcome
            ? resolve(outcome)
            : reject(failure ?? tx.error ?? new Error('mutate completed without a result'))
        tx.onerror = () => reject(failure ?? tx.error)
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('mutate aborted'))
      }),
  )
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
