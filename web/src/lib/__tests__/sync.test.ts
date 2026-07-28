import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb, put, del, get as dbGet, getAll as dbGetAll } from '../db'
import {
  idsToPull,
  idsToPush,
  enqueue,
  drain,
  pullAll,
  configure,
  registerCodec,
  applySealedBlob,
  sealLocalBlob,
  listLocalBlobIds,
  syncStatus,
  BACKOFF_SCHEDULE_MS,
  type BlobClient,
  type SealKey,
  type Codec,
} from '../sync'
import type { ConditionalBlob } from '../relay'
import { BATCH_PULL_THRESHOLD, type BatchBlob, type BlobBodyPage } from '../blob-batch'
import { pullShared } from '../shared'

// Mock the sharing pull so a test can force it to reject; `teardownSharing`
// (also imported by sync.ts) stays real. Default is a no-op, matching how the
// real `pullShared` behaves with no accepted shares in this harness.
vi.mock('../shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared')>()),
  pullShared: vi.fn(),
}))

// `getAll` wrapped (not replaced) so a test can make one store's read reject
// while every other db call stays real.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return { ...actual, getAll: vi.fn(actual.getAll) }
})

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

describe('attachments codec (att-)', () => {
  it('pushes a stored attachment as a mime+base64-bytes envelope', async () => {
    const bytes = new Uint8Array([255, 216, 255, 0, 42]) // JPEG-ish header bytes
    await put('attachments', {
      sha256: 'deadbeef',
      mime: 'image/jpeg',
      size: bytes.length,
      bytes,
      capturedAt: new Date().toISOString(),
    })
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['att-deadbeef'])
    await drain()

    const pushed = relay.blobs.get('att-deadbeef')
    expect(pushed).toBeDefined()
    const envelope = JSON.parse(new TextDecoder().decode(pushed)) as { mime: string; bytes: string }
    expect(envelope.mime).toBe('image/jpeg')
    expect(Array.from(atob(envelope.bytes), (c) => c.charCodeAt(0))).toEqual([255, 216, 255, 0, 42])
  })

  it('marks an att- id done without pushing when no local attachment backs it', async () => {
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())

    await enqueue(['att-missing'])
    await drain()

    expect(relay.blobs.has('att-missing')).toBe(false)
    expect(storeGet(syncStatus).pendingCount).toBe(0)
  })

  it('idsToPull includes att- ids now that the codec is registered', () => {
    expect(idsToPull(['att-aaa', 'ev-bbb'], new Set())).toEqual(['att-aaa', 'ev-bbb'])
  })

  it('round-trips an application/pdf attachment — mime survives encode then decode', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]) // "%PDF-1.7"
    const sha = await sha256Hex(bytes)
    const id = `att-${sha}`
    await put('attachments', {
      sha256: sha,
      mime: 'application/pdf',
      size: bytes.length,
      bytes,
      capturedAt: new Date().toISOString(),
    })

    // Seal the local row, drop it, then apply the sealed blob back: the mime is
    // only carried inside the JSON envelope, so this proves it survives the codec.
    const sealed = await sealLocalBlob(id, passthroughSealKey())
    expect(sealed).not.toBeNull()
    await del('attachments', sha)

    const outcome = await applySealedBlob(id, sealed!, passthroughSealKey())
    expect(outcome).toBe('new')
    expect(await dbGet('attachments', sha)).toMatchObject({
      sha256: sha,
      mime: 'application/pdf',
      size: bytes.length,
    })
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

  it('uses a conditional get when the relay supports it, and a 304 skips re-applying', async () => {
    const store2 = new Map<string, string>()
    let applyCount = 0
    registerCodec({
      prefix: 'mut2-',
      mutable: true,
      async localHas(id) {
        return store2.has(id)
      },
      async localLoad(id) {
        const v = store2.get(id)
        return v === undefined ? null : new TextEncoder().encode(v)
      },
      async remoteApply(id, plaintext) {
        applyCount++
        store2.set(id, new TextDecoder().decode(plaintext))
      },
    })

    const ifNoneMatchSeen: (string | null)[] = []
    let call = 0
    const relay: BlobClient & {
      getBlobConditional(id: string, ifNoneMatch: string | null): Promise<ConditionalBlob>
    } = {
      async putBlob() {},
      async getBlob() {
        throw new Error('the plain getBlob path should not be used once a conditional get is available')
      },
      async listBlobs() {
        return ['mut2-a']
      },
      async getBlobConditional(_id, ifNoneMatch) {
        ifNoneMatchSeen.push(ifNoneMatch)
        call++
        // First pull: nothing cached yet, so the relay answers fresh content.
        // Second pull: the etag from the first response comes back unchanged.
        return call === 1
          ? { status: 'ok', blob: new TextEncoder().encode('v1'), etag: 'etag-1' }
          : { status: 'not-modified' }
      },
    }
    configure(relay, passthroughSealKey())

    await pullAll()
    expect(store2.get('mut2-a')).toBe('v1')
    expect(applyCount).toBe(1)
    expect(ifNoneMatchSeen[0]).toBeNull() // no etag cached on a first-ever fetch

    // The second pull's 304 must not touch remoteApply again — the whole
    // point of the etag is to skip the re-verify/re-merge, not just the body
    // download.
    await pullAll()
    expect(applyCount).toBe(1)
    expect(ifNoneMatchSeen[1]).toBe('etag-1')
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

describe('relay reachability + friendly errors', () => {
  it('a successful pull marks the relay reachable and clears any stale error', async () => {
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())
    await pullAll()
    const s = storeGet(syncStatus)
    expect(s.reachable).toBe(true)
    expect(s.lastError).toBeNull()
  })

  it('a network failure (TypeError) reads as Unreachable with a friendly message', async () => {
    const relay: BlobClient = {
      async putBlob() {},
      async getBlob() {
        return null
      },
      async listBlobs() {
        throw new TypeError('Load failed')
      },
    }
    configure(relay, passthroughSealKey())
    await pullAll()
    const s = storeGet(syncStatus)
    expect(s.reachable).toBe(false)
    expect(s.lastError).toBe('Could not reach the relay — check the address and your connection.')
  })

  it('an HTTP/app error still counts as reached (reachable stays true), keeping its detail', async () => {
    const relay: BlobClient = {
      async putBlob() {},
      async getBlob() {
        return null
      },
      async listBlobs() {
        throw new Error('listBlobs: 500')
      },
    }
    configure(relay, passthroughSealKey())
    await pullAll()
    const s = storeGet(syncStatus)
    expect(s.reachable).toBe(true)
    expect(s.lastError).toContain('500')
  })

  it('a sharing sub-step failure surfaces but does not silently abort the vault pull', async () => {
    // Regression: `pullMailbox`/`pullShared` used to run unguarded after "Online"
    // was set but before `lastPullAt`. A throw there — swallowed by the callers'
    // `void pullAll()` — left the UI stuck on "Online, last pull never".
    vi.mocked(pullShared).mockRejectedValueOnce(new Error('listShared: 500'))
    syncStatus.update((s) => ({ ...s, lastPullAt: null, lastError: null }))
    const relay = inMemoryBlobClient()
    configure(relay, passthroughSealKey())
    await pullAll()
    const s = storeGet(syncStatus)
    // The failure is now visible instead of silent…
    expect(s.lastError).toContain('500')
    // …and the core vault pull still counted as completed: `lastPullAt` is
    // stamped, so the status no longer sticks on "last pull never".
    expect(s.lastPullAt).not.toBeNull()
  })

  it('coalesces concurrent pulls into one in-flight run', async () => {
    // Every trigger (SSE poke, visibilitychange, the 5-minute timer, "Sync now")
    // calls `pullAll`, and a cold vault's pull is one round trip per blob. Without
    // single-flight, a phone that backgrounds/foregrounds stacks full concurrent
    // pulls that re-fetch the same ids and race each other's counters.
    const relay = inMemoryBlobClient()
    await relay.putBlob('ev-a', new Uint8Array([1]))
    let listCalls = 0
    const counting: BlobClient = {
      ...relay,
      async listBlobs() {
        listCalls++
        return relay.listBlobs()
      },
    }
    configure(counting, passthroughSealKey())
    await Promise.all([pullAll(), pullAll(), pullAll()])
    expect(listCalls).toBe(1)
    // …and the guard releases, so a later pull still runs.
    await pullAll()
    expect(listCalls).toBe(2)
  })

  it('a reconcile-step failure surfaces instead of stalling the pull silently', async () => {
    // Same silent-stall shape the sharing guard above fixed, but in the push
    // reconcile between the blob loop and that guard: the local-event read and
    // `enqueue` still ran unguarded, after `noteContact()` set "Online" but
    // before `lastPullAt`. A throw there is swallowed by `void pullAll()`, so
    // the UI sits on "Online, pending 0, last pull never" with no error and a
    // dead "Sync now" — which is exactly what a user reports as "nothing
    // happens".
    const realGetAll = vi.mocked(dbGetAll).getMockImplementation()!
    vi.mocked(dbGetAll).mockImplementation(async (storeName: string) => {
      if (storeName === 'events') throw new Error('events read failed')
      return realGetAll(storeName)
    })
    try {
      syncStatus.update((s) => ({ ...s, lastPullAt: null, lastError: null }))
      const relay = inMemoryBlobClient()
      configure(relay, passthroughSealKey())
      await pullAll()
      const s = storeGet(syncStatus)
      expect(s.lastError).toContain('events read failed')
      expect(s.lastPullAt).not.toBeNull()
    } finally {
      vi.mocked(dbGetAll).mockImplementation(realGetAll)
    }
  })
})

// --- single-blob primitives (the file-import path reuses these) ---

/** A SealKey that records the AAD of every open/seal call, so a test can prove
 * a blob was (or wasn't) opened and that the AAD is the blob id's UTF-8 bytes.
 * Passthrough like `passthroughSealKey`, so a doc-/cur- round trip works. */
function recordingSealKey(): SealKey & { openAads: Uint8Array[]; sealAads: Uint8Array[] } {
  const openAads: Uint8Array[] = []
  const sealAads: Uint8Array[] = []
  return {
    openAads,
    sealAads,
    seal(plaintext, aad) {
      sealAads.push(aad)
      return plaintext
    },
    open(sealed, aad) {
      openAads.push(aad)
      return sealed
    },
  }
}

/** Local sha256 hex — computed inline rather than imported from curation.ts,
 * because importing that module runs its top-level `registerCodec(cur-)` side
 * effect, which would break the 'ignores unregistered prefix' test above. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('applySealedBlob', () => {
  it("returns 'unknown' for an id with no registered codec, without opening", async () => {
    const key = recordingSealKey()
    expect(await applySealedBlob('vault.key', utf8('anything'), key)).toBe('unknown')
    expect(key.openAads).toHaveLength(0)
  })

  it("returns 'duplicate' for an already-stored immutable id WITHOUT opening it", async () => {
    await put('events', fakeStoredEvent('evt-dup'))
    const key = recordingSealKey()

    const outcome = await applySealedBlob('ev-evt-dup', utf8('ignored ciphertext'), key)

    expect(outcome).toBe('duplicate')
    expect(key.openAads).toHaveLength(0) // the localHas shortcut skipped the open
  })

  it("round-trips a doc- blob to 'new' + a stored provenance record, binding AAD to the id", async () => {
    const bytes = new Uint8Array([9, 8, 7, 200])
    const sha = await sha256Hex(bytes)
    const id = `doc-${sha}`
    const envelope = JSON.stringify({ name: 'D.xml', bytes: btoa(String.fromCharCode(...bytes)) })
    const key = recordingSealKey()

    const outcome = await applySealedBlob(id, utf8(envelope), key)

    expect(outcome).toBe('new')
    expect(await dbGet('provenance', sha)).toMatchObject({ sha256: sha, name: 'D.xml' })
    // AAD is the UTF-8 bytes of the blob id.
    expect(key.openAads).toHaveLength(1)
    expect(key.openAads[0]).toEqual(utf8(id))
  })

  it("round-trips an att- blob to 'new' + a stored attachment record, checking the embedded hash", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 255])
    const sha = await sha256Hex(bytes)
    const id = `att-${sha}`
    const envelope = JSON.stringify({ mime: 'image/jpeg', bytes: btoa(String.fromCharCode(...bytes)) })
    const key = recordingSealKey()

    const outcome = await applySealedBlob(id, utf8(envelope), key)

    expect(outcome).toBe('new')
    expect(await dbGet('attachments', sha)).toMatchObject({ sha256: sha, mime: 'image/jpeg', size: 5 })
    expect(key.openAads).toHaveLength(1)
    expect(key.openAads[0]).toEqual(utf8(id))
  })

  it('rejects an att- blob whose bytes do not hash to the blob id', async () => {
    const envelope = JSON.stringify({ mime: 'image/jpeg', bytes: btoa('mismatched') })
    await expect(applySealedBlob('att-notthehash', utf8(envelope), passthroughSealKey())).rejects.toThrow(
      /content hash does not match/,
    )
  })

  it("applies a cur- blob to 'merged', LWW-merging over an older local record", async () => {
    const { curationBlobIdForKey } = await import('../curation')
    const key = 'tag:evt-lww'
    const id = await curationBlobIdForKey(key)
    await put('curation', { key, value: { tags: ['old'] }, updated_at: 100, author: 'aaa' })

    const remote = { key, value: { tags: ['new'] }, updated_at: 200, author: 'aaa' }
    const outcome = await applySealedBlob(id, utf8(JSON.stringify(remote)), passthroughSealKey())

    expect(outcome).toBe('merged')
    expect(await dbGet<{ value: unknown }>('curation', key)).toMatchObject({ value: { tags: ['new'] } })
  })
})

describe('sealLocalBlob', () => {
  it('returns null when nothing local backs the id', async () => {
    expect(await sealLocalBlob('ev-absent', passthroughSealKey())).toBeNull()
    expect(await sealLocalBlob('doc-absent', passthroughSealKey())).toBeNull()
  })

  it('seals a stored provenance blob with AAD = the blob id', async () => {
    await put('provenance', {
      sha256: 'abc',
      name: 'D.xml',
      bytes: new Uint8Array([1, 2, 3]),
      importedAt: new Date().toISOString(),
    })
    const key = recordingSealKey()

    const sealed = await sealLocalBlob('doc-abc', key)

    expect(sealed).not.toBeNull()
    expect(key.sealAads).toHaveLength(1)
    expect(key.sealAads[0]).toEqual(utf8('doc-abc'))
    // Passthrough seal returns the plaintext — the codec's name+base64 envelope.
    const envelope = JSON.parse(new TextDecoder().decode(sealed!)) as { name: string }
    expect(envelope.name).toBe('D.xml')
  })
})

// --- batched pull (?include=body) ---

describe('batched pull', () => {
  // Two fake codecs for this file, registered once (as the mutable codec above
  // is): an immutable one standing in for ev-/doc-/att-, and a mutable one
  // standing in for cur-. Both are backed by plain Maps, so these tests
  // exercise sync.ts's own batch plumbing without wasm.
  const store = new Map<string, string>()
  const mutStore = new Map<string, string>()
  registerCodec({
    prefix: 'bat-',
    async localHas(id) {
      return store.has(id)
    },
    async localLoad(id) {
      const v = store.get(id)
      return v === undefined ? null : utf8(v)
    },
    async remoteApply(id, plaintext) {
      store.set(id, new TextDecoder().decode(plaintext))
    },
  })
  registerCodec({
    prefix: 'batmut-',
    mutable: true,
    async localHas(id) {
      return mutStore.has(id)
    },
    async localLoad(id) {
      const v = mutStore.get(id)
      return v === undefined ? null : utf8(v)
    },
    async remoteApply(id, plaintext) {
      mutStore.set(id, new TextDecoder().decode(plaintext))
    },
  })

  beforeEach(() => {
    store.clear()
    mutStore.clear()
  })

  /** A page fake built straight from decoded frames. The wire framing and its
   * parser have their own coverage (blob-batch.test.ts), so nothing here needs
   * a real `Response`. */
  function fakePage(ids: string[], next: string | null = null): BlobBodyPage {
    async function* frames(): AsyncGenerator<BatchBlob> {
      for (const id of ids) yield { id, blob: utf8(`remote-${id}`) }
    }
    return { kind: 'page', next, blobs: frames() }
  }

  const batchIds = Array.from({ length: BATCH_PULL_THRESHOLD }, (_, i) => `bat-${i}`)

  /** A relay that answers the batched listing, recording every per-id fetch so
   * a test can prove the walk replaced them. */
  function batchRelay(
    ids: string[],
    pages: (cursor: string | null) => Promise<BlobBodyPage>,
  ): BlobClient & {
    listBlobsWithBodies(cursor: string | null): Promise<BlobBodyPage>
    perIdGets: string[]
    cursors: (string | null)[]
  } {
    const perIdGets: string[] = []
    const cursors: (string | null)[] = []
    return {
      perIdGets,
      cursors,
      async putBlob() {},
      async getBlob(id) {
        perIdGets.push(id)
        return utf8(`per-id-${id}`)
      },
      async listBlobs() {
        return ids
      },
      async listBlobsWithBodies(cursor) {
        cursors.push(cursor)
        return pages(cursor)
      },
    }
  }

  it('walks pages instead of fetching each id once enough are missing', async () => {
    const relay = batchRelay(batchIds, async (cursor) =>
      cursor === null ? fakePage(batchIds.slice(0, 5), batchIds[4]) : fakePage(batchIds.slice(5)),
    )
    configure(relay, passthroughSealKey())

    await pullAll()

    expect(relay.cursors).toEqual([null, batchIds[4]])
    expect(relay.perIdGets).toEqual([])
    expect(store.size).toBe(batchIds.length)
    expect(store.get('bat-0')).toBe('remote-bat-0')
    expect(await dbGet('sync', 'bat-0')).toMatchObject({ state: 'done' })
    expect(await dbGet('sync', batchIds.at(-1)!)).toMatchObject({ state: 'done' })
    expect(storeGet(syncStatus).pulledCount).toBe(batchIds.length)
  })

  it('marks a batched duplicate done without ticking pulledCount', async () => {
    store.set('bat-0', 'already-local') // localHas -> 'duplicate', never opened
    const relay = batchRelay(batchIds, async () => fakePage(batchIds))
    configure(relay, passthroughSealKey())

    await pullAll()

    expect(store.get('bat-0')).toBe('already-local')
    expect(await dbGet('sync', 'bat-0')).toMatchObject({ state: 'done' })
    expect(storeGet(syncStatus).pulledCount).toBe(batchIds.length - 1)
  })

  it('stays on the per-id path below the threshold', async () => {
    const few = batchIds.slice(0, BATCH_PULL_THRESHOLD - 1)
    const relay = batchRelay(few, async () => {
      throw new Error('the batch path should not be used below the threshold')
    })
    configure(relay, passthroughSealKey())

    await pullAll()

    expect(relay.cursors).toEqual([])
    expect(relay.perIdGets).toEqual(few)
    expect(store.get('bat-0')).toBe('per-id-bat-0')
  })

  it('falls back to per-id fetches against a relay that does not support batching', async () => {
    const relay = batchRelay(batchIds, async () => ({ kind: 'unsupported' }))
    configure(relay, passthroughSealKey())

    await pullAll()

    expect(relay.cursors).toEqual([null]) // asked once, then gave up on the walk
    expect(relay.perIdGets).toEqual(batchIds)
    expect(store.size).toBe(batchIds.length)
    expect(store.get('bat-0')).toBe('per-id-bat-0')
  })

  it('isolates a frame that fails to open, leaving it un-done for the next pull', async () => {
    const decoder = new TextDecoder()
    const failingKey: SealKey = {
      seal: (plaintext) => plaintext,
      open: (sealed, aad) => {
        if (decoder.decode(aad) === 'bat-3') throw new Error('bad envelope')
        return sealed
      },
    }
    const relay = batchRelay(batchIds, async () => fakePage(batchIds))
    configure(relay, failingKey)

    await pullAll()

    // The bad frame didn't end the page: every later id still applied…
    expect(store.has('bat-3')).toBe(false)
    expect(store.size).toBe(batchIds.length - 1)
    expect(store.get(batchIds.at(-1)!)).toBe(`remote-${batchIds.at(-1)}`)
    // …and it is neither marked done (so the next pull retries it) nor
    // re-fetched per-id in this cycle.
    expect(await dbGet('sync', 'bat-3')).toBeUndefined()
    expect(relay.perIdGets).toEqual([])
    expect(storeGet(syncStatus).lastError).toContain('bad envelope')
  })

  it('applies a batched mutable id and marks it done without an etag or a follow-up conditional get', async () => {
    mutStore.set('batmut-a', 'stale-local')
    const ids = [...batchIds, 'batmut-a']
    const conditionalGets: string[] = []
    const relay = {
      ...batchRelay(ids, async () => fakePage(ids)),
      async getBlobConditional(id: string): Promise<ConditionalBlob> {
        conditionalGets.push(id)
        return { status: 'missing' }
      },
    }
    configure(relay, passthroughSealKey())

    await pullAll()

    expect(mutStore.get('batmut-a')).toBe('remote-batmut-a') // 'merged'
    // A mutable id is never filtered by `doneIds`, so only the handled-set
    // subtraction keeps the per-id loop from re-fetching it right afterwards.
    expect(conditionalGets).toEqual([])
    const record = await dbGet<{ state: string; etag?: string }>('sync', 'batmut-a')
    expect(record).toMatchObject({ state: 'done' })
    expect(record?.etag).toBeUndefined()
  })
})

describe('listLocalBlobIds', () => {
  it('lists an ev- per event, a doc- per provenance record, an att- per attachment, and a cur- per curation key', async () => {
    await put('events', fakeStoredEvent('evt-a'))
    await put('provenance', {
      sha256: 'sha-a',
      name: 'D.xml',
      bytes: new Uint8Array([1]),
      importedAt: new Date().toISOString(),
    })
    await put('attachments', {
      sha256: 'sha-att',
      mime: 'image/jpeg',
      size: 1,
      bytes: new Uint8Array([1]),
      capturedAt: new Date().toISOString(),
    })
    await put('curation', { key: 'tag:evt-a', value: { tags: ['x'] }, updated_at: 1, author: 'aaa' })

    const ids = await listLocalBlobIds()
    const { curationBlobIdForKey } = await import('../curation')

    expect(ids).toContain('ev-evt-a')
    expect(ids).toContain('doc-sha-a')
    expect(ids).toContain('att-sha-att')
    expect(ids).toContain(await curationBlobIdForKey('tag:evt-a'))
    // vault.key is not a codec, so it is never enumerated.
    expect(ids).not.toContain('vault.key')
  })
})
