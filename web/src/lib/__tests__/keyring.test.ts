import { describe, expect, it } from 'vitest'
import {
  KeyringBlobKey,
  isKeyringContainer,
  keyHandoffItemId,
  sealKeyHandoff,
  revokeAndRotate,
  type SealingIdentity,
  type WrappableKeyring,
  type Grantee,
  type RotationRelay,
} from '../keyring'
import type { WasmIdentity, WasmKeyring } from '../svastha'

const OWNER_ED = 'a'.repeat(64)
const OWNER_X = 'b'.repeat(64)
const GRANTEE_X = 'c'.repeat(64)

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A fake identity whose `seal_message` records the sealed handoffs and returns a
 * recognizable envelope JSON, so orchestration can be checked without wasm. */
function fakeIdentity(): SealingIdentity & { sealed: { kind: string; body: string }[] } {
  const sealed: { kind: string; body: string }[] = []
  return {
    ed25519_public_hex: OWNER_ED,
    x25519_public_hex: OWNER_X,
    sealed,
    seal_message(_recipient, kind, _sentAt, body) {
      const b = dec.decode(body)
      sealed.push({ kind, body: b })
      return JSON.stringify({ kind, body: b })
    },
  }
}

/** A fake keyring: `rotate` mints a "next" ring, `to_bytes` names the ring, and
 * `wrap_for_grantee` returns a fixed wrapped blob. */
function fakeKeyring(name: string): WrappableKeyring {
  return {
    to_bytes: () => enc.encode(name),
    rotate: () => fakeKeyring(`${name}+1`),
    wrap_for_grantee: () => ({ to_bytes: () => new Uint8Array([0xaa, 0xbb]) }),
  }
}

function fakeRelay(): RotationRelay & {
  blobs: { id: string; bytes: string }[]
  grantsDeleted: string[]
  mail: { to: string; id: string; body: string }[]
} {
  const blobs: { id: string; bytes: string }[] = []
  const grantsDeleted: string[] = []
  const mail: { to: string; id: string; body: string }[] = []
  return {
    blobs,
    grantsDeleted,
    mail,
    async putBlob(id, bytes) {
      blobs.push({ id, bytes: dec.decode(bytes) })
    },
    async deleteGrant(g) {
      grantsDeleted.push(g)
      return true
    },
    async putMailbox(to, id, body) {
      mail.push({ to, id, body: dec.decode(body) })
    },
  }
}

describe('isKeyringContainer', () => {
  it('recognizes the svkr magic, and only it', () => {
    expect(isKeyringContainer(enc.encode('svkr\x01'))).toBe(true)
    expect(isKeyringContainer(new Uint8Array([0x73, 0x76, 0x6b, 0x72]))).toBe(true)
    expect(isKeyringContainer(enc.encode('nope'))).toBe(false)
    expect(isKeyringContainer(new Uint8Array([0x73]))).toBe(false) // legacy bare key, too short
  })
})

describe('keyHandoffItemId', () => {
  it('is stable per owner (a re-rotation overwrites the grantee item)', () => {
    expect(keyHandoffItemId(OWNER_ED)).toBe(`keyring-${'a'.repeat(16)}`)
    expect(keyHandoffItemId(OWNER_ED)).toBe(keyHandoffItemId(OWNER_ED))
  })
})

describe('KeyringBlobKey', () => {
  it('decodes the aad back to the blob id and delegates to seal_blob/open_blob', () => {
    const calls: { op: string; blobId: string }[] = []
    const fakeWasmKeyring = {
      seal_blob(_owner: unknown, blobId: string, _pt: Uint8Array) {
        calls.push({ op: 'seal', blobId })
        return new Uint8Array([1])
      },
      open_blob(_owner: unknown, blobId: string, _sealed: Uint8Array) {
        calls.push({ op: 'open', blobId })
        return new Uint8Array([2])
      },
    } as unknown as WasmKeyring
    const key = new KeyringBlobKey(fakeWasmKeyring, {} as unknown as WasmIdentity)

    key.seal(new Uint8Array([9]), enc.encode('ev-abc'))
    key.open(new Uint8Array([9]), enc.encode('att-def'))

    expect(calls).toEqual([
      { op: 'seal', blobId: 'ev-abc' },
      { op: 'open', blobId: 'att-def' },
    ])
  })
})

describe('sealKeyHandoff', () => {
  it('wraps the ring to the grantee and seals a key_handoff with the owner as from', () => {
    const identity = fakeIdentity()
    const bytes = sealKeyHandoff(identity, fakeKeyring('r0'), GRANTEE_X, 'Alex', 1000)

    expect(identity.sealed).toHaveLength(1)
    expect(identity.sealed[0].kind).toBe('key_handoff')
    const body = JSON.parse(identity.sealed[0].body)
    expect(body).toEqual({
      from_ed: OWNER_ED,
      from_x25519: OWNER_X,
      label: 'Alex',
      wrapped_hex: 'aabb',
    })
    // The returned bytes are the enc'd envelope JSON.
    expect(JSON.parse(dec.decode(bytes)).kind).toBe('key_handoff')
  })
})

describe('revokeAndRotate', () => {
  const grantees: Grantee[] = [
    { ed: 'd'.repeat(64), x25519: 'e'.repeat(64), label: 'Bailey' },
    { ed: 'f'.repeat(64), x25519: '0'.repeat(64), label: 'Node' },
  ]

  it('revokes first, rotates, publishes the new ring, then re-keys every grantee', async () => {
    const relay = fakeRelay()
    const identity = fakeIdentity()
    const revoked = '9'.repeat(64)

    const rotated = await revokeAndRotate({
      relay,
      identity,
      keyring: fakeKeyring('r0'),
      grantees,
      revoke: revoked,
      now: 1000,
    })

    // 1. revoked edge deleted; 2. new ring published as vault.key.
    expect(relay.grantsDeleted).toEqual([revoked])
    expect(relay.blobs).toEqual([{ id: 'vault.key', bytes: 'r0+1' }])
    expect(rotated.to_bytes && dec.decode(rotated.to_bytes())).toBe('r0+1')

    // 3. every still-trusted grantee re-keyed under the stable owner item id.
    expect(relay.mail).toHaveLength(2)
    expect(relay.mail.map((m) => m.to)).toEqual([grantees[0].ed, grantees[1].ed])
    for (const m of relay.mail) {
      expect(m.id).toBe(keyHandoffItemId(OWNER_ED))
      expect(JSON.parse(m.body).kind).toBe('key_handoff')
    }
  })

  it('a plain rotate-now revokes no one', async () => {
    const relay = fakeRelay()
    await revokeAndRotate({
      relay,
      identity: fakeIdentity(),
      keyring: fakeKeyring('r0'),
      grantees: [],
      revoke: null,
      now: 1000,
    })
    expect(relay.grantsDeleted).toEqual([])
    expect(relay.blobs).toEqual([{ id: 'vault.key', bytes: 'r0+1' }])
    expect(relay.mail).toEqual([])
  })
})
