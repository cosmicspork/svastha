import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, get } from '../db'
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
  type OpenKey,
  type UnwrapIdentity,
  type Share,
} from '../shared'
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

/** A pass-through open key: "opening" just returns the sealed bytes, so tests
 * can plant plaintext JSON directly as the "sealed" blob (same trick as
 * sync.test.ts's `passthroughSealKey`). */
function passthroughOpenKey(): OpenKey {
  return { open: (sealed) => sealed }
}

function fakeIdentity(): UnwrapIdentity {
  return { unwrap_key: () => passthroughOpenKey() }
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
