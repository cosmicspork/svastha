import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, get } from '../db'
import {
  defaultPrefixes,
  buildOutgoing,
  granteesToReKey,
  enrollGrantee,
  getGrantMeta,
  putGrantMeta,
  removeGrantMeta,
  HOUSEHOLD_PREFIXES,
  NODE_PREFIXES,
  type GrantMeta,
  type EnrollRelay,
} from '../grants'
import { getProposer } from '../proposals'
import type { SealingIdentity, WrappableKeyring } from '../keyring'

beforeEach(async () => {
  await deleteDb()
})

const OWNER_ED = 'a'.repeat(64)
const OWNER_X = 'b'.repeat(64)
const GRANTEE_ED = 'c'.repeat(64)
const GRANTEE_X = 'd'.repeat(64)

function meta(overrides: Partial<GrantMeta> = {}): GrantMeta {
  return {
    ed: GRANTEE_ED,
    x25519: GRANTEE_X,
    label: 'Bailey',
    kind: 'household',
    prefixes: [...HOUSEHOLD_PREFIXES],
    issuedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('defaultPrefixes', () => {
  it('gives households record + attachments, nodes the full read set', () => {
    expect(defaultPrefixes('household')).toEqual(HOUSEHOLD_PREFIXES)
    expect(defaultPrefixes('node')).toEqual(NODE_PREFIXES)
    expect(defaultPrefixes('node')).toEqual(['ev-', 'att-', 'doc-', 'cur-'])
  })
})

describe('buildOutgoing', () => {
  it('resolves each grantee against local metadata, flagging legacy edges', () => {
    const known = meta()
    const legacyEd = 'e'.repeat(64)
    const out = buildOutgoing([GRANTEE_ED, legacyEd], { [GRANTEE_ED]: known })

    const byEd = Object.fromEntries(out.map((g) => [g.ed, g]))
    expect(byEd[GRANTEE_ED]).toMatchObject({
      label: 'Bailey',
      kind: 'household',
      prefixes: HOUSEHOLD_PREFIXES,
      legacy: false,
    })
    expect(byEd[legacyEd]).toMatchObject({ label: '', prefixes: [], legacy: true })
  })

  it('sorts by label then ed for a stable render', () => {
    const a = meta({ ed: 'a'.repeat(64), label: 'Zoe' })
    const b = meta({ ed: 'b'.repeat(64), label: 'Amy' })
    const out = buildOutgoing([a.ed, b.ed], { [a.ed]: a, [b.ed]: b })
    expect(out.map((g) => g.label)).toEqual(['Amy', 'Zoe'])
  })
})

describe('granteesToReKey', () => {
  it('returns every known grantee minus the revoked one', () => {
    const m = { [GRANTEE_ED]: meta(), ['f'.repeat(64)]: meta({ ed: 'f'.repeat(64), label: 'Node' }) }
    expect(granteesToReKey(m, GRANTEE_ED).map((g) => g.ed)).toEqual(['f'.repeat(64)])
    expect(granteesToReKey(m, null)).toHaveLength(2)
  })
})

describe('grant metadata store', () => {
  it('round-trips and removes', async () => {
    await putGrantMeta(meta())
    expect((await getGrantMeta())[GRANTEE_ED].label).toBe('Bailey')
    await removeGrantMeta(GRANTEE_ED)
    expect(await getGrantMeta()).toEqual({})
  })
})

// --- enrollGrantee ---

function fakeIdentity(): SealingIdentity {
  return {
    ed25519_public_hex: OWNER_ED,
    x25519_public_hex: OWNER_X,
    seal_message: (_r, kind) => JSON.stringify({ kind }),
  }
}

function fakeKeyring(): WrappableKeyring {
  return {
    to_bytes: () => new Uint8Array([1]),
    rotate: () => fakeKeyring(),
    wrap_for_grantee: () => ({ to_bytes: () => new Uint8Array([2]) }),
  }
}

function fakeRelay(): EnrollRelay & {
  grants: { ed: string; scope?: { prefixes?: string[]; expires_at?: number } }[]
  mail: string[]
} {
  const grants: { ed: string; scope?: { prefixes?: string[]; expires_at?: number } }[] = []
  const mail: string[] = []
  return {
    grants,
    mail,
    async putGrant(ed, scope) {
      grants.push({ ed, scope })
    },
    async putMailbox(to) {
      mail.push(to)
    },
  }
}

describe('enrollGrantee', () => {
  it('issues a scoped household grant, deposits a handoff, and records the grant', async () => {
    const relay = fakeRelay()
    await enrollGrantee({
      relay,
      identity: fakeIdentity(),
      keyring: fakeKeyring(),
      ownerLabel: 'Alex',
      grantee: { ed: GRANTEE_ED, x25519: GRANTEE_X, label: 'Bailey', kind: 'household' },
      now: 1000,
    })

    expect(relay.grants).toEqual([
      { ed: GRANTEE_ED, scope: { prefixes: HOUSEHOLD_PREFIXES, expires_at: undefined } },
    ])
    expect(relay.mail).toEqual([GRANTEE_ED])

    const stored = (await getGrantMeta())[GRANTEE_ED]
    expect(stored).toMatchObject({ kind: 'household', prefixes: HOUSEHOLD_PREFIXES, label: 'Bailey' })
    // A household grantee is NOT written to the proposer directory.
    expect(await getProposer(GRANTEE_ED)).toBeUndefined()
  })

  it('enrolls a node with node scopes and records it in the proposer directory', async () => {
    const relay = fakeRelay()
    await enrollGrantee({
      relay,
      identity: fakeIdentity(),
      keyring: fakeKeyring(),
      ownerLabel: 'Alex',
      grantee: { ed: GRANTEE_ED, x25519: GRANTEE_X, label: 'My node', kind: 'node', expiresAt: 42 },
      now: 1000,
    })

    expect(relay.grants).toEqual([
      { ed: GRANTEE_ED, scope: { prefixes: NODE_PREFIXES, expires_at: 42 } },
    ])
    // The proposer directory C2's inbox seals replies to (node's X25519 + label).
    expect(await getProposer(GRANTEE_ED)).toEqual({
      ed: GRANTEE_ED,
      x25519: GRANTEE_X,
      label: 'My node',
    })
  })
})
