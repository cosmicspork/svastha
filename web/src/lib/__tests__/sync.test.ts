import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb, put, del, get as dbGet } from '../db'
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
