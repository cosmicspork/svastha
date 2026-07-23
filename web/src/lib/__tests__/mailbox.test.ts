import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb } from '../db'
import {
  classifyMailboxItem,
  configureMailbox,
  teardownMailbox,
  pullMailbox,
  resolveProposalIfDone,
  type MailboxClient,
  type MailboxIdentity,
  type Envelope,
} from '../mailbox'
import { pendingInvites } from '../shared'
import { getProposal, upsertProposal, putProposer, buildProposalRecord } from '../proposals'

beforeEach(async () => {
  await deleteDb()
  teardownMailbox()
  pendingInvites.set([])
})

const NODE = 'a'.repeat(64)
const NODE_X = 'e'.repeat(64)
const OWNER = 'd'.repeat(64)

// --- fixtures: build the envelope wire shapes the layer classifies/dispatches.
// The body is sealed in production; here the fake identity's `open_message`
// returns a precomputed plaintext keyed by the envelope id, so the test drives
// the dispatch without wasm.

const bodies = new Map<string, Uint8Array>()

function envelope(kind: string, id: string, from = NODE, extra: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    kind,
    from,
    sent_at: 1000,
    id,
    body: 'sealedhex',
    signature: 'ok',
    ...extra,
  }
}

function proposalEnvelope(id: string, eventIds: string[]): Envelope {
  const body = {
    proposals: eventIds.map((evId) => ({
      event: {
        id: evId,
        kind: 'observation',
        code: null,
        effective_at: '2026-07-20T09:00:00+00:00',
        value: { text: 'headache' },
        provenance: { source: 'node', source_doc: null },
      },
      source_blob: 'att-abc',
      method: 'ocr',
      model: 'vision-1',
    })),
  }
  bodies.set(id, new TextEncoder().encode(JSON.stringify(body)))
  return envelope('proposal', id)
}

function keyHandoffEnvelope(id: string): Envelope {
  bodies.set(
    id,
    new TextEncoder().encode(
      JSON.stringify({ from_ed: NODE, from_x25519: NODE_X, label: 'Partner', wrapped_hex: 'ab' }),
    ),
  )
  return envelope('key_handoff', id)
}

function fakeIdentity(overrides: Partial<MailboxIdentity> = {}): MailboxIdentity {
  return {
    open_message(text) {
      const env = JSON.parse(text) as Envelope
      const body = bodies.get(env.id)
      if (!body) throw new Error('no body')
      return body
    },
    seal_message: () => 'sealed-reply-envelope-json',
    unwrap_key: () => ({}),
    ed25519_public_hex: OWNER,
    x25519_public_hex: 'f'.repeat(64),
    ...overrides,
  }
}

/** A fake mailbox holding one envelope per item id; records putMailbox/deletes. */
function fakeClient(items: { id: string; from: string; env: Envelope }[]): MailboxClient & {
  put: { recipient: string; id: string; bytes: Uint8Array }[]
  deleted: string[]
} {
  const put: { recipient: string; id: string; bytes: Uint8Array }[] = []
  const deleted: string[] = []
  const byId = new Map(items.map((i) => [i.id, i]))
  return {
    put,
    deleted,
    async listMailbox() {
      return items.map((i) => ({ id: i.id, from: i.from }))
    },
    async getMailbox(id) {
      const i = byId.get(id)
      if (!i) return null
      return { blob: new TextEncoder().encode(JSON.stringify(i.env)), from: i.from }
    },
    async deleteMailbox(id) {
      deleted.push(id)
      return true
    },
    async putMailbox(recipient, id, bytes) {
      put.push({ recipient, id, bytes })
    },
  }
}

const verifyOk = (text: string) => (JSON.parse(text) as Envelope).signature !== 'BAD'

describe('classifyMailboxItem', () => {
  it('recognizes a typed envelope', () => {
    const c = classifyMailboxItem(JSON.stringify(envelope('proposal', 'x')))
    expect(c.type).toBe('envelope')
  })

  it('recognizes a legacy bare wrapped-key deposit', () => {
    const legacy = { v: 1, from_ed: NODE, from_x25519: NODE_X, label: 'P', wrapped_hex: 'ab' }
    const c = classifyMailboxItem(JSON.stringify(legacy))
    expect(c.type).toBe('legacy')
  })

  it('a typed envelope never parses as legacy and vice versa', () => {
    // The envelope lacks from_ed/wrapped_hex; the legacy lacks kind/signature.
    expect(classifyMailboxItem(JSON.stringify(envelope('chat_msg', 'x'))).type).toBe('envelope')
  })

  it('unparseable bytes and shapeless JSON are unparseable', () => {
    expect(classifyMailboxItem('not json').type).toBe('unparseable')
    expect(classifyMailboxItem(JSON.stringify({ hello: 1 })).type).toBe('unparseable')
  })
})

describe('pullMailbox dispatch', () => {
  it('stores a verified proposal and reports it added', async () => {
    const env = proposalEnvelope('msg-1', ['ev-a', 'ev-b'])
    configureMailbox(fakeClient([{ id: 'item-1', from: NODE, env }]), fakeIdentity(), verifyOk)

    const result = await pullMailbox()

    expect(result.proposalsAdded).toBe(1)
    const stored = await getProposal('msg-1')
    expect(stored!.fromEd).toBe(NODE)
    expect(stored!.mailboxItemId).toBe('item-1')
    expect(stored!.drafts.map((d) => d.event.id)).toEqual(['ev-a', 'ev-b'])
    expect(stored!.drafts[0].method).toBe('ocr')
  })

  it('dedupes a re-pulled proposal by message id (never re-processes)', async () => {
    const env = proposalEnvelope('msg-1', ['ev-a'])
    configureMailbox(fakeClient([{ id: 'item-1', from: NODE, env }]), fakeIdentity(), verifyOk)

    expect((await pullMailbox()).proposalsAdded).toBe(1)
    expect((await pullMailbox()).proposalsAdded).toBe(0)
  })

  it('drops a tampered envelope (verify false) without opening it', async () => {
    const env = proposalEnvelope('msg-2', ['ev-a'])
    env.signature = 'BAD'
    let opened = false
    const id = fakeIdentity({
      open_message() {
        opened = true
        throw new Error('should not open')
      },
    })
    configureMailbox(fakeClient([{ id: 'item-2', from: NODE, env }]), id, verifyOk)

    const result = await pullMailbox()

    expect(result.dropped).toBe(1)
    expect(result.proposalsAdded).toBe(0)
    expect(opened).toBe(false)
    expect(await getProposal('msg-2')).toBeUndefined()
  })

  it('drops an envelope whose svastha-from does not match the signed from', async () => {
    const env = proposalEnvelope('msg-3', ['ev-a'])
    // Relay attests a different depositor than the envelope claims.
    configureMailbox(fakeClient([{ id: 'item-3', from: 'c'.repeat(64), env }]), fakeIdentity(), verifyOk)

    const result = await pullMailbox()

    expect(result.dropped).toBe(1)
    expect(await getProposal('msg-3')).toBeUndefined()
  })

  it('routes a key_handoff envelope to a pending invite', async () => {
    const env = keyHandoffEnvelope('kh-1')
    configureMailbox(fakeClient([{ id: 'item-4', from: NODE, env }]), fakeIdentity(), verifyOk)

    const result = await pullMailbox()

    expect(result.invites).toHaveLength(1)
    expect(storeGet(pendingInvites)).toEqual([
      { mailboxId: 'item-4', fromEd: NODE, fromX: NODE_X, label: 'Partner', wrappedKeyHex: 'ab' },
    ])
  })

  it('routes a grandfathered bare wrapped-key deposit to a pending invite', async () => {
    const legacy = { v: 1, from_ed: NODE, from_x25519: NODE_X, label: 'Partner', wrapped_hex: 'ab' }
    const client: MailboxClient = {
      async listMailbox() {
        return [{ id: 'vaultkey-x', from: NODE }]
      },
      async getMailbox() {
        return { blob: new TextEncoder().encode(JSON.stringify(legacy)), from: NODE }
      },
      async deleteMailbox() {
        return true
      },
      async putMailbox() {},
    }
    configureMailbox(client, fakeIdentity(), verifyOk)

    const result = await pullMailbox()

    expect(result.invites).toHaveLength(1)
    expect(storeGet(pendingInvites)[0].mailboxId).toBe('vaultkey-x')
  })

  it('tolerates and ignores an unknown/other kind (chat_msg)', async () => {
    bodies.set('cm-1', new TextEncoder().encode('{}'))
    const env = envelope('chat_msg', 'cm-1')
    configureMailbox(fakeClient([{ id: 'item-5', from: NODE, env }]), fakeIdentity(), verifyOk)

    const result = await pullMailbox()

    expect(result.ignored).toBe(1)
    expect(result.dropped).toBe(0)
    expect(result.proposalsAdded).toBe(0)
  })

  it('drops a key_handoff whose wrapped key does not unwrap', async () => {
    const env = keyHandoffEnvelope('kh-2')
    const id = fakeIdentity({
      unwrap_key: () => {
        throw new Error('wrong recipient')
      },
    })
    configureMailbox(fakeClient([{ id: 'item-6', from: NODE, env }]), id, verifyOk)

    const result = await pullMailbox()

    expect(result.dropped).toBe(1)
    expect(result.invites).toEqual([])
  })
})

describe('resolveProposalIfDone', () => {
  async function seedResolved(resultSent = false) {
    const record = buildProposalRecord({
      id: 'msg-1',
      fromEd: NODE,
      mailboxItemId: 'item-1',
      sentAt: 1,
      drafts: [
        { event: { id: 'ev-a', kind: 'observation', code: null, effective_at: null, value: null, provenance: { source: 'n', source_doc: null } } },
        { event: { id: 'ev-b', kind: 'observation', code: null, effective_at: null, value: null, provenance: { source: 'n', source_doc: null } } },
      ],
    })
    record.drafts[0].status = 'approved'
    record.drafts[1].status = 'rejected'
    record.resolved = true
    record.resultSent = resultSent
    await upsertProposal(record)
  }

  it('seals a proposal_result to the proposer, deletes the item, and forgets the proposal', async () => {
    await seedResolved()
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Home node' })
    const client = fakeClient([])
    configureMailbox(client, fakeIdentity(), verifyOk)

    const sent = await resolveProposalIfDone('msg-1')

    expect(sent).toBe(true)
    expect(client.put).toHaveLength(1)
    expect(client.put[0].recipient).toBe(NODE)
    expect(client.deleted).toContain('item-1')
    expect(await getProposal('msg-1')).toBeUndefined()
  })

  it('defers the reply (keeps the record) when the proposer key is unknown', async () => {
    await seedResolved()
    const client = fakeClient([])
    configureMailbox(client, fakeIdentity(), verifyOk)

    const sent = await resolveProposalIfDone('msg-1')

    expect(sent).toBe(false)
    expect(client.put).toHaveLength(0)
    expect((await getProposal('msg-1'))!.resultSent).toBe(false)
  })

  it('is a no-op while a draft is still pending', async () => {
    const record = buildProposalRecord({
      id: 'msg-2',
      fromEd: NODE,
      mailboxItemId: 'item-2',
      sentAt: 1,
      drafts: [{ event: { id: 'ev-a', kind: 'observation', code: null, effective_at: null, value: null, provenance: { source: 'n', source_doc: null } } }],
    })
    await upsertProposal(record)
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Home node' })
    configureMailbox(fakeClient([]), fakeIdentity(), verifyOk)

    expect(await resolveProposalIfDone('msg-2')).toBe(false)
    expect(await getProposal('msg-2')).toBeDefined()
  })
})
