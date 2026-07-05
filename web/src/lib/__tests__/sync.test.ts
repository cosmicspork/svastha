import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb, put, get as dbGet } from '../db'
import {
  idsToPull,
  idsToPush,
  enqueue,
  drain,
  pullAll,
  configure,
  registerCodec,
  syncStatus,
  BACKOFF_SCHEDULE_MS,
  type BlobClient,
  type SealKey,
  type Codec,
} from '../sync'

// deleteDb() (not a raw indexedDB.deleteDatabase call) so the module's
// memoized connection is closed and cleared between tests — same pattern as
// db.test.ts.
beforeEach(deleteDb)

// vitest runs these tests in Node, where setImmediate exists, but
// tsconfig.app.json typechecks against DOM libs only — declare it rather
// than pulling all of @types/node into the app's typecheck.
declare function setImmediate(callback: () => void): void

// A minimal stand-in for a stored, signed event — enough shape for the
// events codec's localLoad/localHas (which never inspect the payload; only
// remoteApply does, and that's wasm-dependent verify_event territory this
// file deliberately doesn't exercise — see e2e/sync.spec.ts for that).
function fakeStoredEvent(id: string) {
  return {
    event: {
      id,
      kind: 'observation' as const,
      code: null,
      effective_at: null,
      value: null,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

function passthroughSealKey(): SealKey {
  return {
    seal: (plaintext) => plaintext,
    open: (sealed) => sealed,
  }
}

function inMemoryBlobClient(): BlobClient & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  return {
    blobs,
    async putBlob(id, blob) {
      blobs.set(id, blob)
    },
    async getBlob(id) {
      return blobs.get(id) ?? null
    },
    async listBlobs() {
      return [...blobs.keys()]
    },
  }
}

describe('idsToPull', () => {
  it('fresh device: pulls everything with a registered codec prefix', () => {
    expect(idsToPull(['ev-aaa', 'ev-bbb'], new Set())).toEqual(['ev-aaa', 'ev-bbb'])
  })

  it('ignores ids with no registered codec prefix', () => {
    // 'vault.key' has no codec at all. 'cur-' (the curation overlay) DOES have
    // one (curation.ts, registered dynamically from this module's `configure`
    // — see its module doc comment), but nothing in this test file has
    // triggered that dynamic import yet, so as of this assertion it's still
    // unregistered here too. See curation.test.ts for 'cur-' coverage once
    // registered.
    expect(idsToPull(['ev-aaa', 'cur-bbb', 'vault.key'], new Set())).toEqual(['ev-aaa'])
  })

  it('pulls doc- (provenance) ids too, now that the codec is registered', () => {
    expect(idsToPull(['ev-aaa', 'doc-bbb'], new Set())).toEqual(['ev-aaa', 'doc-bbb'])
  })

  it('skips ids already marked done', () => {
    expect(idsToPull(['ev-aaa', 'ev-bbb'], new Set(['ev-aaa']))).toEqual(['ev-bbb'])
  })
})

describe('idsToPush', () => {
  it('pushes local events missing from the relay list', () => {
    expect(idsToPush(['aaa', 'bbb'], new Set(['ev-aaa']), new Set())).toEqual(['ev-bbb'])
  })

  it('skips ids already marked done even if missing remotely', () => {
    expect(idsToPush(['aaa', 'bbb'], new Set(), new Set(['ev-bbb']))).toEqual(['ev-aaa'])
  })

  it('pushes nothing once everything is remote or done', () => {
    expect(idsToPush(['aaa'], new Set(['ev-aaa']), new Set())).toEqual([])
  })
})

describe('enqueue + drain', () => {
  it('pushes a pending event blob and marks it done', async () => {
    await put('events', fakeStoredEvent('evt-1'))
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['ev-evt-1'])
    await drain()

    expect(relay.blobs.has('ev-evt-1')).toBe(true)
    expect(storeGet(syncStatus).pendingCount).toBe(0)
  })

  it('marks an id done without pushing when nothing local backs it', async () => {
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['ev-missing'])
    await drain()

    expect(relay.blobs.has('ev-missing')).toBe(false)
    expect(storeGet(syncStatus).pendingCount).toBe(0)
  })

  it('re-enqueuing an already-done id is a no-op', async () => {
    await put('events', fakeStoredEvent('evt-2'))
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['ev-evt-2'])
    await drain()
    relay.blobs.delete('ev-evt-2') // simulate the relay losing it

    await enqueue(['ev-evt-2']) // already 'done' locally — not re-queued
    await drain()

    expect(relay.blobs.has('ev-evt-2')).toBe(false)
  })
})

describe('provenance codec (doc-)', () => {
  it('pushes a stored provenance record as a name+base64-bytes envelope', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    await put('provenance', {
      sha256: 'abc123',
      name: 'DOC0001.XML',
      bytes,
      importedAt: new Date().toISOString(),
    })
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['doc-abc123'])
    await drain()

    const pushed = relay.blobs.get('doc-abc123')
    expect(pushed).toBeDefined()
    const envelope = JSON.parse(new TextDecoder().decode(pushed)) as { name: string; bytes: string }
    expect(envelope.name).toBe('DOC0001.XML')
    expect(Array.from(atob(envelope.bytes), (c) => c.charCodeAt(0))).toEqual([1, 2, 3, 250])
  })

  it('marks a doc- id done without pushing when no local provenance record backs it', async () => {
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['doc-missing'])
    await drain()

    expect(relay.blobs.has('doc-missing')).toBe(false)
    expect(storeGet(syncStatus).pendingCount).toBe(0)
  })
})

describe('mutable codec (Codec.mutable — the shape cur- relies on)', () => {
  // A minimal fake mutable codec, registered once for this file (`registerCodec`
  // has no unregister — matches how curation.ts's real 'cur-' codec is
  // registered permanently for the app's lifetime too). Backed by a plain
  // in-memory Map rather than the real `curation` IDB store, so this exercises
  // sync.ts's own mutable-aware plumbing (idsToPull/enqueue/pullAll) in
  // isolation from curation.ts's LWW logic (covered separately in
  // curation.test.ts).
  const store = new Map<string, string>()
  const mutableCodec: Codec = {
    prefix: 'mut-',
    mutable: true,
    async localHas(id) {
      return store.has(id)
    },
    async localLoad(id) {
      const v = store.get(id)
      return v === undefined ? null : new TextEncoder().encode(v)
    },
    async remoteApply(id, plaintext) {
      store.set(id, new TextDecoder().decode(plaintext))
    },
  }
  registerCodec(mutableCodec)

  it('idsToPull always includes a mutable id, even if already marked done', () => {
    expect(idsToPull(['mut-a'], new Set(['mut-a']))).toEqual(['mut-a'])
  })

  it('enqueue re-queues a mutable id for push even if already marked done', async () => {
    await put('sync', { id: 'mut-a', state: 'done', updated_at: new Date().toISOString() })
    await enqueue(['mut-a'])
    expect(await dbGet<{ state: string }>('sync', 'mut-a')).toMatchObject({ state: 'pending' })
  })

  it('pullAll re-fetches and re-applies a mutable id every time, not just once', async () => {
    store.set('mut-a', 'local-value') // localHas('mut-a') is already true
    const relay: BlobClient = {
      async putBlob() {},
      async getBlob(id) {
        return id === 'mut-a' ? new TextEncoder().encode('remote-value') : null
      },
      async listBlobs() {
        return ['mut-a']
      },
    }
    configure(relay, passthroughSealKey())

    await pullAll()
    expect(store.get('mut-a')).toBe('remote-value') // localHas alone didn't short-circuit the fetch

    // A second pull re-fetches again rather than treating the first as final.
    store.set('mut-a', 'stale-again')
    await pullAll()
    expect(store.get('mut-a')).toBe('remote-value')
  })
})

describe('drain backoff', () => {
  /** Let real setImmediate callbacks (fake-indexeddb's scheduler) run until
   * `cond` holds. Bounded so a bug fails the test instead of hanging it. */
  async function flushUntil(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !cond(); i++) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()))
    }
    expect(cond()).toBe(true)
  }

  it('retries a failing push on the documented schedule, then gives up until the next trigger', async () => {
    await put('events', fakeStoredEvent('evt-3'))

    let attempts = 0
    const relay: BlobClient = {
      async putBlob() {
        attempts++
        throw new Error('offline')
      },
      async getBlob() {
        return null
      },
      async listBlobs() {
        return []
      },
    }
    configure(relay, passthroughSealKey())
    await enqueue(['ev-evt-3'])

    // Fake ONLY setTimeout (the backoff sleep). fake-indexeddb schedules its
    // request callbacks on setImmediate; faking that too would deadlock every
    // awaited IDB call inside drain().
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const drainPromise = drain()
      await flushUntil(() => attempts === 1)

      for (const [i, delay] of BACKOFF_SCHEDULE_MS.entries()) {
        // Just short of the scheduled delay: no retry yet...
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(attempts).toBe(i + 1)
        // ...crossing it: exactly one more attempt.
        await vi.advanceTimersByTimeAsync(1)
        await flushUntil(() => attempts === i + 2)
      }
      expect(attempts).toBe(1 + BACKOFF_SCHEDULE_MS.length)

      await drainPromise // schedule exhausted — drain gave up
      expect(storeGet(syncStatus).pendingCount).toBe(1) // stayed pending
    } finally {
      vi.useRealTimers()
    }
  })
})
