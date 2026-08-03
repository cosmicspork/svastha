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
  setDraftStatuses,
  markResultSent,
  removeProposal,
  refreshPendingProposals,
  pendingProposals,
  proposalsFrom,
  getProposer,
  putProposer,
  flattenDrafts,
  visibleDrafts,
  approveAllSheetCopy,
  PROPOSALS_PAGE_SIZE,
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

  // Re-reading a page files under the same record id (see read-page.ts). The
  // second pass has to land: an owner who re-reads a page and is told it
  // worked, while nothing changed, has been lied to.
  it('upsertProposal replaces the undecided drafts of an already-seen id', async () => {
    await upsertProposal(
      record({
        id: 'local-att',
        drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }],
      }),
    )
    await setDraftStatus('local-att', 'ev-1', 'approved')

    // A second read of the same page, coded differently this time.
    await upsertProposal(record({ id: 'local-att', drafts: [{ event: draftEvent('ev-3') }] }))

    const merged = (await getProposal('local-att'))!
    expect(merged.drafts.map((d) => [d.event.id, d.status])).toEqual([
      ['ev-3', 'pending'],
      ['ev-1', 'approved'],
    ])
  })

  // A decision is a fact about an event, not about the pass that proposed it.
  it('upsertProposal keeps a decided draft the new pass no longer proposes', async () => {
    await upsertProposal(
      record({
        id: 'local-att',
        drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }],
      }),
    )
    await setDraftStatus('local-att', 'ev-1', 'rejected')
    await setDraftStatus('local-att', 'ev-2', 'approved')

    await upsertProposal(record({ id: 'local-att', drafts: [{ event: draftEvent('ev-9') }] }))

    const merged = (await getProposal('local-att'))!
    expect(merged.drafts.map((d) => d.event.id)).toEqual(['ev-9', 'ev-1', 'ev-2'])
    expect(merged.resolved).toBe(false)
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

  it('setDraftStatuses flips drafts across records in one call and recomputes resolved per record', async () => {
    await upsertProposal(
      record({ id: 'm4', drafts: [{ event: draftEvent('ev-a') }, { event: draftEvent('ev-b') }] }),
    )
    await upsertProposal(record({ id: 'm5', drafts: [{ event: draftEvent('ev-c') }] }))

    const changed = await setDraftStatuses([
      { proposalId: 'm4', eventId: 'ev-a', status: 'approved' },
      { proposalId: 'm4', eventId: 'ev-b', status: 'rejected' },
      { proposalId: 'm5', eventId: 'ev-c', status: 'approved' },
    ])

    expect([...changed.keys()].sort()).toEqual(['m4', 'm5'])
    expect(changed.get('m4')!.resolved).toBe(true)
    expect((await getProposal('m4'))!.drafts.map((d) => d.status)).toEqual(['approved', 'rejected'])
    expect((await getProposal('m5'))!.resolved).toBe(true)
    // Both records are fully decided, so the pending mirror is empty.
    expect(storeGet(pendingProposals)).toEqual([])
  })

  it('setDraftStatuses leaves a partially-decided record pending and mirrors the final state', async () => {
    await upsertProposal(
      record({ id: 'm6', drafts: [{ event: draftEvent('ev-a') }, { event: draftEvent('ev-b') }] }),
    )
    const changed = await setDraftStatuses([{ proposalId: 'm6', eventId: 'ev-a', status: 'approved' }])
    expect(changed.get('m6')!.resolved).toBe(false)
    expect(storeGet(pendingProposals).map((r) => r.id)).toEqual(['m6'])
  })

  it('setDraftStatuses skips unknown proposal and draft ids, returning only changed records', async () => {
    await upsertProposal(record({ id: 'm7' }))
    const changed = await setDraftStatuses([
      { proposalId: 'nope', eventId: 'ev-1', status: 'approved' },
      { proposalId: 'm7', eventId: 'nope', status: 'approved' },
    ])
    expect(changed.size).toBe(0)
    expect((await getProposal('m7'))!.drafts[0].status).toBe('pending')
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

// The periodic pull (sync.ts) re-upserts every still-pending mailbox item, so a
// re-pull of a proposal the owner is deciding right now is the ordinary case,
// not the exotic one. These fixtures are chosen to defeat the guarantee rather
// than to satisfy it: the interleaving that matters is the one where the pull's
// *read* falls between the decision's read and its write, because a
// two-transaction read-modify-write then merges from a pre-decision snapshot and
// writes the decision back out.
//
// `turns(n)` staggers the second operation by n microtask checkpoints. The
// sweep is deterministic — fake-indexeddb has a single-threaded scheduler, so
// each offset produces the same schedule every run — and every offset in it
// clobbers the decision when these ops are two transactions each.
describe('concurrent decisions vs. the pull loop', () => {
  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  }
  const OFFSETS = [0, 1, 2, 3, 4]

  it('a committed decision survives a re-pull started in its gap, at every offset', async () => {
    for (const n of OFFSETS) {
      const id = `race-${n}`
      await upsertProposal(record({ id }))

      const approve = setDraftStatus(id, 'ev-1', 'approved')
      await turns(n)
      const rePull = upsertProposal(record({ id })) // same drafts, all pending
      await Promise.all([approve, rePull])

      expect((await getProposal(id))!.drafts[0].status, `offset ${n}`).toBe('approved')
    }
  })

  it('the reverse ordering — re-pull first, decision second — holds too', async () => {
    for (const n of OFFSETS) {
      const id = `race-rev-${n}`
      await upsertProposal(record({ id }))

      const rePull = upsertProposal(record({ id }))
      await turns(n)
      const approve = setDraftStatus(id, 'ev-1', 'approved')
      await Promise.all([approve, rePull])

      expect((await getProposal(id))!.drafts[0].status, `offset ${n}`).toBe('approved')
    }
  })

  // Atomicity must not cost the merge: a second pass that proposes something new
  // still has to land, whichever side of the decision it is ordered on.
  it("a racing pull's fresh drafts land without disturbing the decision", async () => {
    for (const n of OFFSETS) {
      const id = `race-merge-${n}`
      await upsertProposal(record({ id, drafts: [{ event: draftEvent('ev-1') }] }))

      const approve = setDraftStatus(id, 'ev-1', 'approved')
      await turns(n)
      const rePull = upsertProposal(
        record({ id, drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }] }),
      )
      await Promise.all([approve, rePull])

      const stored = (await getProposal(id))!
      expect(
        stored.drafts.map((d) => [d.event.id, d.status]),
        `offset ${n}`,
      ).toEqual([
        ['ev-1', 'approved'],
        ['ev-2', 'pending'],
      ])
      expect(stored.resolved, `offset ${n}`).toBe(false)
    }
  })

  it('two decisions on different drafts of one record both land', async () => {
    for (const n of OFFSETS) {
      const id = `race-both-${n}`
      await upsertProposal(
        record({ id, drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }] }),
      )

      const first = setDraftStatus(id, 'ev-1', 'approved')
      await turns(n)
      const second = setDraftStatus(id, 'ev-2', 'rejected')
      await Promise.all([first, second])

      const stored = (await getProposal(id))!
      expect(stored.drafts.map((d) => d.status), `offset ${n}`).toEqual(['approved', 'rejected'])
      expect(stored.resolved, `offset ${n}`).toBe(true)
    }
  })

  // The reply-sent flag and the decision are separate facts about one record;
  // neither write may carry the other's field back to what it was when it started.
  it('markResultSent and a concurrent decision both survive', async () => {
    for (const n of OFFSETS) {
      const id = `race-sent-${n}`
      await upsertProposal(
        record({ id, drafts: [{ event: draftEvent('ev-1') }, { event: draftEvent('ev-2') }] }),
      )

      const mark = markResultSent(id, true)
      await turns(n)
      const approve = setDraftStatus(id, 'ev-1', 'approved')
      await Promise.all([mark, approve])

      const stored = (await getProposal(id))!
      expect(stored.resultSent, `offset ${n}`).toBe(true)
      expect(stored.drafts[0].status, `offset ${n}`).toBe('approved')
    }
  })
})

describe('proposer directory', () => {
  it('round-trips a proposer identity', async () => {
    await putProposer({ ed: NODE_A, x25519: 'c'.repeat(64), label: 'Home node' })
    expect(await getProposer(NODE_A)).toEqual({ ed: NODE_A, x25519: 'c'.repeat(64), label: 'Home node' })
    expect(await getProposer(NODE_B)).toBeUndefined()
  })
})

describe('pagination windowing (M5/D5)', () => {
  const drafts = (n: number, prefix = 'd') =>
    Array.from({ length: n }, (_, i) => ({ event: draftEvent(`${prefix}${i}`) }))

  it('PROPOSALS_PAGE_SIZE is 20', () => {
    expect(PROPOSALS_PAGE_SIZE).toBe(20)
  })

  it("flattenDrafts preserves record order then each record's own draft order", () => {
    const a = record({ id: 'a', drafts: drafts(2, 'a') })
    const b = record({ id: 'b', drafts: drafts(1, 'b') })
    expect(flattenDrafts([a, b]).map((x) => x.draft.event.id)).toEqual(['a0', 'a1', 'b0'])
  })

  it("visibleDrafts slices to `shown` across a group's records and reports what remains", () => {
    const a = record({ id: 'a', drafts: drafts(15, 'a') })
    const b = record({ id: 'b', drafts: drafts(10, 'b') })

    const page1 = visibleDrafts([a, b], 20)
    expect(page1.visible.map((x) => x.draft.event.id)).toEqual([
      ...drafts(15, 'a').map((d) => d.event.id),
      ...drafts(5, 'b').map((d) => d.event.id),
    ])
    expect(page1.remaining).toBe(5)

    const page2 = visibleDrafts([a, b], 40)
    expect(page2.visible).toHaveLength(25)
    expect(page2.remaining).toBe(0)
  })

  it('approving a visible draft does not move the pagination boundary (no duplicate or skipped draft on the next page)', () => {
    const r = record({ id: 'r', drafts: drafts(25) })
    const before = visibleDrafts([r], 20)
    expect(before.visible).toHaveLength(20)
    expect(before.remaining).toBe(5)

    // Decide two of the currently-visible drafts in place, as setDraftStatus does
    // (it flips `status` on the same array element rather than removing it).
    r.drafts[3].status = 'approved'
    r.drafts[19].status = 'rejected'

    const after = visibleDrafts([r], 20)
    expect(after.visible.map((x) => x.draft.event.id)).toEqual(before.visible.map((x) => x.draft.event.id))
    expect(after.remaining).toBe(5)

    // "Show more" reveals exactly the next page: nothing repeated, nothing skipped.
    const more = visibleDrafts([r], 40)
    expect(more.visible.map((x) => x.draft.event.id)).toEqual(r.drafts.map((d) => d.event.id))
    expect(more.remaining).toBe(0)
  })

  it('an empty group or a group already fully shown has nothing remaining', () => {
    const r = record({ id: 'r', drafts: drafts(5) })
    expect(visibleDrafts([r], 20).remaining).toBe(0)
    expect(visibleDrafts([], 20)).toEqual({ visible: [], remaining: 0 })
  })
})

describe('approve-all sheet copy (M5/D5)', () => {
  it('echoes the exact pending count in the heading and confirm label, with the locked body copy', () => {
    expect(approveAllSheetCopy(7)).toEqual({
      heading: 'Approve 7 entries?',
      body: 'Each one is signed with your key, exactly as if you had logged it yourself. You can still edit or remove entries afterwards.',
      confirmLabel: 'Approve 7',
    })
  })

  it('scales the count for a small and a large batch', () => {
    expect(approveAllSheetCopy(2).heading).toBe('Approve 2 entries?')
    expect(approveAllSheetCopy(42).confirmLabel).toBe('Approve 42')
  })
})
