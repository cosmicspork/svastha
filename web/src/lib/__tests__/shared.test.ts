import { beforeEach, describe, expect, it, vi } from 'vitest'

// The wasm module needs a browser, so unit tests run in node without it (see
// vitest.config.ts) and mock `../svastha`, mirroring shareRecipient.test.ts.
// The fake keyring is passthrough — the real envelope is core's job, covered by
// its own vectors and by e2e/share.spec.ts — and `verify_event` accepts an
// event iff its `signature` field is 'ok', which is enough to drive the
// verify/store path the batched walk and the per-blob loop now share.
vi.mock('../svastha', () => {
  class FakeKeyring {
    static from_bytes(): FakeKeyring {
      return new FakeKeyring()
    }
    seal_blob(_identity: unknown, _aad: string, plaintext: Uint8Array): Uint8Array {
      return plaintext
    }
    open_blob(_identity: unknown, _aad: string, sealed: Uint8Array): Uint8Array {
      return sealed
    }
  }
  const verify_event = (json: string): boolean => {
    try {
      return (JSON.parse(json) as { signature?: string }).signature === 'ok'
    } catch {
      return false
    }
  }
  return { WasmKeyring: FakeKeyring, verify_event }
})

import { deleteDb, get } from '../db'
import { BATCH_PULL_THRESHOLD, type BatchBlob, type BlobBodyPage } from '../blob-batch'
import {
  listShares,
  putShare,
  removeShare,
  sharedEventsFor,
  configureSharing,
  teardownSharing,
  acceptInvite,
  declineInvite,
  pullShared,
  pendingInvites,
  type SharingClient,
  type Share,
} from '../shared'
import type { WasmIdentity } from '../svastha'
import { get as storeGet } from 'svelte/store'

beforeEach(async () => {
  await deleteDb()
  teardownSharing()
})

const OWNER_ED = 'a'.repeat(64)
const OWNER_X = 'b'.repeat(64)

function fakeShare(overrides: Partial<Share> = {}): Share {
  return {
    ownerEd: OWNER_ED,
    ownerX: OWNER_X,
    label: 'Partner',
    wrappedKeyHex: 'ab',
    hue: 'b',
    acceptedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** A non-null stand-in identity. The pullShared branches these tests exercise
 * (no-op-until-configured, and the 404-stale path) never build a keyring
 * open-key, so the identity is only ever checked for presence — the real
 * open/verify path needs wasm and is covered by e2e/share.spec.ts. */
function fakeIdentity(): WasmIdentity {
  return {} as unknown as WasmIdentity
}

function fakeSharingClient(overrides: Partial<SharingClient> = {}): SharingClient {
  return {
    listShared: async () => [],
    listSharedBlobs: async () => [],
    getSharedBlob: async () => null,
    listMailbox: async () => [],
    getMailbox: async () => null,
    deleteMailbox: async () => false,
    ...overrides,
  }
}

describe('shares CRUD', () => {
  it('round-trips a share and lists it', async () => {
    await putShare(fakeShare())
    expect(await listShares()).toEqual([fakeShare()])
    expect(await get('shares', OWNER_ED)).toEqual(fakeShare())
  })

  it('removeShare forgets it locally', async () => {
    await putShare(fakeShare())
    await removeShare(OWNER_ED)
    expect(await listShares()).toEqual([])
  })
})

// The mailbox scan that surfaces invites now lives in the one consumption
// layer, mailbox.ts (see mailbox.test.ts). shared.ts keeps only the invite
// state and the accept/decline actions covered below.

describe('acceptInvite / declineInvite', () => {
  const invite = {
    mailboxId: 'vaultkey-aaaaaaaa',
    fromEd: OWNER_ED,
    fromX: OWNER_X,
    label: 'Partner',
    wrappedKeyHex: 'ab',
  }

  it('accept stores the share, deletes the mailbox item, and clears the pending invite', async () => {
    let deleted: string | undefined
    const client = fakeSharingClient({
      deleteMailbox: async (id) => {
        deleted = id
        return true
      },
    })
    configureSharing(client, fakeIdentity())
    pendingInvites.set([invite])

    await acceptInvite(invite, 'b')

    expect(deleted).toBe('vaultkey-aaaaaaaa')
    expect(storeGet(pendingInvites)).toEqual([])
    const shares = await listShares()
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ ownerEd: OWNER_ED, label: 'Partner', hue: 'b' })
  })

  it('decline deletes the mailbox item and stores nothing', async () => {
    let deleted: string | undefined
    const client = fakeSharingClient({
      deleteMailbox: async (id) => {
        deleted = id
        return true
      },
    })
    configureSharing(client, fakeIdentity())
    pendingInvites.set([invite])

    await declineInvite(invite)

    expect(deleted).toBe('vaultkey-aaaaaaaa')
    expect(storeGet(pendingInvites)).toEqual([])
    expect(await listShares()).toEqual([])
  })
})

// The full pull (open -> verify_event -> author check -> insert) needs the
// real wasm module instantiated, which vitest's plain-node environment can't
// do — same boundary sync.test.ts documents for its own pullAll/remoteApply.
// That path (including the author check) is covered by e2e/share.spec.ts
// instead; here we only exercise the branches that don't touch `verify_event`.
describe('pullShared', () => {
  it('marks a share stale on a 404 and clears it once shared again', async () => {
    await putShare(fakeShare())
    let revoked = true
    const client = fakeSharingClient({
      listSharedBlobs: async () => (revoked ? null : []),
    })
    configureSharing(client, fakeIdentity())

    await pullShared()
    expect((await listShares())[0].stale).toBe(true)

    revoked = false
    await pullShared()
    expect((await listShares())[0].stale).toBe(false)
  })

  it('is a no-op until configured', async () => {
    await putShare(fakeShare())
    await expect(pullShared()).resolves.toBeUndefined()
    expect(await sharedEventsFor(OWNER_ED)).toEqual([])
  })
})

// --- batched shared pull (?include=body) ---

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** A sealed `ev-` blob as the owner's device would have written it: passthrough
 * "ciphertext" (see the keyring mock above) around a signed-event JSON the fake
 * `verify_event` accepts. */
function sealedEvent(eventId: string, author = OWNER_ED): Uint8Array {
  return utf8(JSON.stringify({ event: { id: eventId }, author, signature: 'ok' }))
}

const ATT_BYTES = new Uint8Array([255, 216, 255, 42])

function sealedAttachment(): Uint8Array {
  return utf8(
    JSON.stringify({ mime: 'image/jpeg', bytes: btoa(String.fromCharCode(...ATT_BYTES)) }),
  )
}

describe('pullShared batching', () => {
  const eventIds = Array.from({ length: BATCH_PULL_THRESHOLD }, (_, i) => `e${i}`)
  let attId = ''
  let attSha = ''
  let ids: string[] = []

  beforeEach(async () => {
    attSha = await sha256Hex(ATT_BYTES)
    attId = `att-${attSha}`
    ids = [...eventIds.map((id) => `ev-${id}`), attId]
  })

  /** Frames handed straight to the walk — the wire framing has its own coverage
   * in blob-batch.test.ts, so nothing here builds a real `Response`. */
  function fakePage(pageIds: string[], next: string | null = null): BlobBodyPage {
    async function* frames(): AsyncGenerator<BatchBlob> {
      for (const id of pageIds) {
        yield { id, blob: id === attId ? sealedAttachment() : sealedEvent(id.slice('ev-'.length)) }
      }
    }
    return { kind: 'page', next, blobs: frames() }
  }

  function batchClient(pages: (cursor: string | null) => Promise<BlobBodyPage | null>) {
    const singleFetches: string[] = []
    return {
      ...fakeSharingClient({
        listSharedBlobs: async () => ids,
        getSharedBlob: async (_owner: string, id: string) => {
          singleFetches.push(id)
          return id === attId ? sealedAttachment() : sealedEvent(id.slice('ev-'.length))
        },
      }),
      singleFetches,
      listSharedBlobsWithBodies: (_owner: string, cursor: string | null) => pages(cursor),
    }
  }

  it('walks a cold share in pages, storing both ev- and att- frames', async () => {
    await putShare(fakeShare())
    const cursors: (string | null)[] = []
    const client = batchClient(async (cursor) => {
      cursors.push(cursor)
      return cursor === null ? fakePage(ids.slice(0, 5), ids[4]) : fakePage(ids.slice(5))
    })
    configureSharing(client, fakeIdentity())

    await pullShared()

    expect(cursors).toEqual([null, ids[4]])
    expect(client.singleFetches).toEqual([]) // the walk replaced every per-blob fetch
    expect(await sharedEventsFor(OWNER_ED)).toHaveLength(eventIds.length)
    expect(await get('attachments', attSha)).toMatchObject({ sha256: attSha, mime: 'image/jpeg', size: 4 })
  })

  it('marks the share stale when the grant vanishes mid-walk, keeping what already applied', async () => {
    await putShare(fakeShare())
    const client = batchClient(async (cursor) => (cursor === null ? fakePage(ids.slice(0, 5), ids[4]) : null))
    configureSharing(client, fakeIdentity())

    await pullShared()

    expect((await listShares())[0].stale).toBe(true)
    expect(await sharedEventsFor(OWNER_ED)).toHaveLength(5)
  })

  it('falls back to per-blob fetches against a relay that does not support batching', async () => {
    await putShare(fakeShare())
    const client = batchClient(async () => ({ kind: 'unsupported' }))
    configureSharing(client, fakeIdentity())

    await pullShared()

    expect(client.singleFetches).toEqual(ids)
    expect(await sharedEventsFor(OWNER_ED)).toHaveLength(eventIds.length)
    expect(await get('attachments', attSha)).toBeDefined()
  })
})
