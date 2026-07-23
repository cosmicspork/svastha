import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb } from '../db'
import {
  buildProposalRecord,
  pendingRecords,
  groupByProposer,
  resultBodyFor,
  isResolved,
  pendingDraftCount,
  upsertProposal,
  getProposal,
  setDraftStatus,
  removeProposal,
  refreshPendingProposals,
  pendingProposals,
  proposalsFrom,
  getProposer,
  putProposer,
  type DraftEvent,
  type ProposalRecord,
} from '../proposals'

beforeEach(async () => {
  await deleteDb()
  pendingProposals.set([])
})

const NODE_A = 'a'.repeat(64)
const NODE_B = 'b'.repeat(64)

/** A minimal schema-valid draft event; the content id is opaque to this module
 * (it's computed by the wasm signer), so a fixture just needs a stable string. */
function draftEvent(id: string, overrides: Partial<DraftEvent> = {}): DraftEvent {
  return {
    id,
    kind: 'observation',
    code: null,
    effective_at: '2026-07-20T09:00:00+00:00',
    value: { text: 'headache' },
    provenance: { source: 'node', source_doc: null },
    ...overrides,
  }
}

function record(overrides: Partial<Parameters<typeof buildProposalRecord>[0]> = {}): ProposalRecord {
  return buildProposalRecord({
    id: 'msg-1',
    fromEd: NODE_A,
    mailboxItemId: 'item-1',
    sentAt: 1000,
    drafts: [{ event: draftEvent('ev-1'), source_blob: 'att-abc', method: 'ocr', model: 'm' }],
    receivedAt: '2026-07-21T00:00:00Z',
    ...overrides,
  })
}

describe('pure helpers', () => {
  it('buildProposalRecord starts every draft pending and unresolved', () => {
    const r = record({
      drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }],
    })
    expect(r.drafts.map((d) => d.status)).toEqual(['pending', 'pending'])
    expect(r.resolved).toBe(false)
    expect(r.resultSent).toBe(false)
  })

  it('isResolved is true only when no draft is pending', () => {
    const r = record({ drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }] })
    expect(isResolved(r)).toBe(false)
    r.drafts[0].status = 'approved'
    expect(isResolved(r)).toBe(false)
    r.drafts[1].status = 'rejected'
    expect(isResolved(r)).toBe(true)
  })

  it('pendingRecords keeps records with a pending draft, oldest first', () => {
    const a = record({ id: 'a', receivedAt: '2026-07-21T02:00:00Z' })
    const b = record({ id: 'b', receivedAt: '2026-07-21T01:00:00Z' })
    const done = record({ id: 'c', drafts: [{ event: draftEvent('x') }] })
    done.drafts[0].status = 'approved'
    expect(pendingRecords([a, b, done]).map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('groupByProposer buckets by fromEd preserving order', () => {
    const a1 = record({ id: 'a1', fromEd: NODE_A })
    const b1 = record({ id: 'b1', fromEd: NODE_B })
    const a2 = record({ id: 'a2', fromEd: NODE_A })
    const groups = groupByProposer([a1, b1, a2])
    expect([...groups.keys()]).toEqual([NODE_A, NODE_B])
    expect(groups.get(NODE_A)!.map((r) => r.id)).toEqual(['a1', 'a2'])
  })

  it('resultBodyFor lists accepted and rejected event ids under the proposal id', () => {
    const r = record({
      id: 'msg-9',
      drafts: [
        { event: draftEvent('ev-a') },
        { event: draftEvent('ev-b') },
        { event: draftEvent('ev-c') },
      ],
    })
    r.drafts[0].status = 'approved'
    r.drafts[1].status = 'rejected'
    r.drafts[2].status = 'approved'
    expect(resultBodyFor(r)).toEqual({
      proposal_id: 'msg-9',
      accepted: ['ev-a', 'ev-c'],
      rejected: ['ev-b'],
    })
  })

  it('pendingDraftCount sums pending drafts across records', () => {
    const a = record({ drafts: [{ event: draftEvent('1') }, { event: draftEvent('2') }] })
    a.drafts[0].status = 'approved'
    const b = record({ id: 'b', drafts: [{ event: draftEvent('3') }] })
    expect(pendingDraftCount([a, b])).toBe(2)
  })
})

describe('persistence + dedupe', () => {
  it('upsertProposal stores a new record and refreshes the pending store', async () => {
    expect(await upsertProposal(record({ id: 'm1' }))).toBe(true)
    expect(await getProposal('m1')).toBeDefined()
    expect(storeGet(pendingProposals).map((r) => r.id)).toEqual(['m1'])
  })

  it('upsertProposal is a no-op for an already-seen message id (never re-processes)', async () => {
    const first = record({ id: 'm1' })
    await upsertProposal(first)
    await setDraftStatus('m1', 'ev-1', 'approved')

    // A re-pull of the same message must not reset the decision.
    const rePull = record({ id: 'm1' })
    expect(await upsertProposal(rePull)).toBe(false)
    expect((await getProposal('m1'))!.drafts[0].status).toBe('approved')
  })

  it('setDraftStatus flips a draft and recomputes resolved', async () => {
    await upsertProposal(
      record({ id: 'm2', drafts: [{ event: draftEvent('ev-a') }, { event: draftEvent('ev-b') }] }),
    )
    let updated = await setDraftStatus('m2', 'ev-a', 'approved')
    expect(updated!.resolved).toBe(false)
    updated = await setDraftStatus('m2', 'ev-b', 'rejected')
    expect(updated!.resolved).toBe(true)
  })

  it('setDraftStatus returns undefined for an unknown id or draft', async () => {
    await upsertProposal(record({ id: 'm3' }))
    expect(await setDraftStatus('nope', 'ev-1', 'approved')).toBeUndefined()
    expect(await setDraftStatus('m3', 'nope', 'approved')).toBeUndefined()
  })

  it('proposalsFrom indexes by proposer, removeProposal forgets one', async () => {
    await upsertProposal(record({ id: 'm1', fromEd: NODE_A }))
    await upsertProposal(record({ id: 'm2', fromEd: NODE_B }))
    expect((await proposalsFrom(NODE_A)).map((r) => r.id)).toEqual(['m1'])
    await removeProposal('m1')
    expect(await getProposal('m1')).toBeUndefined()
  })

  it('refreshPendingProposals mirrors only records with pending drafts', async () => {
    await upsertProposal(record({ id: 'm1' }))
    await setDraftStatus('m1', 'ev-1', 'approved') // now fully resolved
    await refreshPendingProposals()
    expect(storeGet(pendingProposals)).toEqual([])
  })
})

describe('proposer directory', () => {
  it('round-trips a proposer identity', async () => {
    await putProposer({ ed: NODE_A, x25519: 'c'.repeat(64), label: 'Home node' })
    expect(await getProposer(NODE_A)).toEqual({ ed: NODE_A, x25519: 'c'.repeat(64), label: 'Home node' })
    expect(await getProposer(NODE_B)).toBeUndefined()
  })
})
