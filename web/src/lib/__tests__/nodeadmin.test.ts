import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb } from '../db'
import { putProposer } from '../proposals'
import { putGrantMeta } from '../grants'
import {
  adminLog,
  describeCommand,
  notifiesOnReply,
  replyState,
  sortNewestFirst,
  enrolledNode,
  isEnrolledNode,
  recordCommand,
  applyAdminReply,
  refreshAdminLog,
  getNodeLastSeen,
  noteNodeSeen,
  type AdminLogEntry,
} from '../nodeadmin'
import { CONFIRM_WINDOW_MS } from '../trackedCommand'

beforeEach(async () => {
  await deleteDb()
  adminLog.set([])
})

const NODE = 'a'.repeat(64)
const NODE_X = 'e'.repeat(64)

describe('pure helpers', () => {
  it('describes each vault-scoped command', () => {
    expect(describeCommand({ cmd: 'set_inference_endpoint', endpoint: 'https://x/v1' })).toContain(
      'https://x/v1',
    )
    expect(describeCommand({ cmd: 'job_status' })).toMatch(/job status/i)
    expect(describeCommand({ cmd: 'log_tail' })).toMatch(/log tail/i)
    expect(describeCommand({ cmd: 'log_tail', lines: 50 })).toContain('50')
    // The log row has to distinguish opting in from opting back out — an empty
    // include is a real instruction, not a no-op.
    expect(describeCommand({ cmd: 'set_answer_scope', include: ['cycle', 'mind'] })).toBe(
      'Let answers read Cycle and Mind',
    )
    expect(describeCommand({ cmd: 'set_answer_scope', include: [] })).toMatch(/kept .*out of answers/i)
  })

  it('orders the log newest-sent first', () => {
    const a: AdminLogEntry = { id: 'a', command: { cmd: 'job_status' }, sentAt: '2026-07-24T10:00:00Z' }
    const b: AdminLogEntry = { id: 'b', command: { cmd: 'job_status' }, sentAt: '2026-07-24T11:00:00Z' }
    expect(sortNewestFirst([a, b]).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('notifies only for the commands with no other surface', () => {
    // Asking a question is the whole point of these two — their answer has
    // nowhere else to appear.
    expect(notifiesOnReply({ cmd: 'job_status' })).toBe(true)
    expect(notifiesOnReply({ cmd: 'log_tail' })).toBe(true)
    expect(notifiesOnReply({ cmd: 'log_tail', lines: 50 })).toBe(true)
    // These confirm themselves on screen; notifying would double-report.
    expect(notifiesOnReply({ cmd: 'set_inference_endpoint', endpoint: 'https://x/v1' })).toBe(false)
    expect(notifiesOnReply({ cmd: 'set_answer_scope', include: ['cycle'] })).toBe(false)
    expect(notifiesOnReply({ cmd: 'pause_ocr' })).toBe(false)
    expect(notifiesOnReply({ cmd: 'resume_ocr' })).toBe(false)
  })
})

describe('replyState', () => {
  const SENT = '2026-07-24T10:00:00Z'
  const sentMs = Date.parse(SENT)
  const pending: AdminLogEntry = { id: 'a', command: { cmd: 'job_status' }, sentAt: SENT }

  it('is waiting inside the window and unanswered past it', () => {
    expect(replyState(pending, sentMs)).toBe('waiting')
    expect(replyState(pending, sentMs + CONFIRM_WINDOW_MS - 1)).toBe('waiting')
    expect(replyState(pending, sentMs + CONFIRM_WINDOW_MS + 1)).toBe('unanswered')
  })

  // Pin the boundary explicitly rather than leaving it to whichever comparison
  // happens to be written: at exactly the window, the wait is over.
  it('treats exactly the window as unanswered', () => {
    expect(replyState(pending, sentMs + CONFIRM_WINDOW_MS)).toBe('unanswered')
  })

  // The timeout is a display state, not a verdict — the node is free to answer
  // late (it may have been off for a day) and the row must go back to replied.
  it('reads replied for a reply that arrives long after the window', () => {
    const late: AdminLogEntry = {
      ...pending,
      reply: { ok: true, detail: 'idle', receivedAt: '2026-07-25T10:00:00Z' },
    }
    expect(replyState(late, sentMs + CONFIRM_WINDOW_MS * 1000)).toBe('replied')
  })

  // Adversarial: a device clock that moved backwards (or skew against whatever
  // stamped `sentAt`) makes `now - sent` negative. That is not evidence the node
  // went quiet, and must not read as instantly waited-out.
  it('keeps waiting when sentAt is in the future', () => {
    expect(replyState(pending, sentMs - CONFIRM_WINDOW_MS * 10)).toBe('waiting')
  })

  // Adversarial: a corrupted or hand-edited record must not throw or silently
  // resolve to unanswered on NaN arithmetic.
  it('keeps waiting on an unparseable sentAt instead of throwing', () => {
    const broken: AdminLogEntry = { id: 'b', command: { cmd: 'log_tail' }, sentAt: 'not-a-date' }
    expect(() => replyState(broken, sentMs)).not.toThrow()
    expect(replyState(broken, sentMs)).toBe('waiting')
  })

  it('reads replied regardless of the clock once a reply is folded on', () => {
    const answered: AdminLogEntry = {
      ...pending,
      reply: { ok: false, detail: 'no such job', receivedAt: SENT },
    }
    expect(replyState(answered, sentMs)).toBe('replied')
  })
})

describe('enrolledNode', () => {
  it('is null when the directory holds no node', async () => {
    expect(await enrolledNode()).toBeNull()
    // A caregiver-kind (or unmarked) proposer is not a node.
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Partner', kind: 'caregiver' })
    expect(await enrolledNode()).toBeNull()
  })

  it('resolves a node-kind proposer', async () => {
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Home node', kind: 'node' })
    const node = await enrolledNode()
    expect(node?.ed).toBe(NODE)
    expect(node?.x25519).toBe(NODE_X)
  })

  it('heals a legacy node proposer stored without kind via grant metadata', async () => {
    // Pre-fix installs wrote the node proposer without `kind`. On its own that
    // record no longer resolves as a node…
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Home node' })
    expect(await enrolledNode()).toBeNull()
    // …but the grant metadata always recorded kind:'node', so the directory read
    // falls back to it and the node resolves — no re-enrol, no migration.
    await putGrantMeta({
      ed: NODE,
      x25519: NODE_X,
      label: 'Home node',
      kind: 'node',
      prefixes: ['ev-', 'att-', 'doc-', 'cur-'],
      issuedAt: '2026-07-24T10:00:00Z',
    })
    expect((await enrolledNode())?.ed).toBe(NODE)
    // The inbound sender gate heals through the same path, so the node's answers
    // are accepted again.
    expect(await isEnrolledNode(NODE)).toBe(true)
  })
})

describe('isEnrolledNode (the inbound sender gate)', () => {
  it('is true only for an enrolled node identity', async () => {
    const other = 'b'.repeat(64)
    await putProposer({ ed: NODE, x25519: NODE_X, label: 'Home node', kind: 'node' })
    await putProposer({ ed: other, x25519: 'f'.repeat(64), label: 'Partner', kind: 'caregiver' })
    expect(await isEnrolledNode(NODE)).toBe(true)
    // A caregiver-kind grantee is not a node — its signed chat/admin is refused.
    expect(await isEnrolledNode(other)).toBe(false)
    // An identity absent from the directory entirely is refused.
    expect(await isEnrolledNode('c'.repeat(64))).toBe(false)
  })
})

describe('admin log round-trip', () => {
  it('records a command, then folds its reply on by in_reply_to', async () => {
    await recordCommand({ id: 'cmd-1', command: { cmd: 'job_status' }, sentAt: '2026-07-24T10:00:00Z' })
    expect(storeGet(adminLog)[0].reply).toBeUndefined()

    const matched = await applyAdminReply('cmd-1', { ok: true, detail: '2 jobs queued', receivedAt: '2026-07-24T10:00:05Z' })
    expect(matched).toBe(true)
    await refreshAdminLog()
    expect(storeGet(adminLog)[0].reply).toEqual({ ok: true, detail: '2 jobs queued', receivedAt: '2026-07-24T10:00:05Z' })
  })

  it('ignores a reply to a command it never issued', async () => {
    expect(await applyAdminReply('unknown', { ok: true, receivedAt: '2026-07-24T10:00:05Z' })).toBe(false)
  })
})

describe('node last-seen', () => {
  it('advances but never rewinds', async () => {
    expect(await getNodeLastSeen()).toBeUndefined()
    await noteNodeSeen('2026-07-24T10:00:00Z')
    expect(await getNodeLastSeen()).toBe('2026-07-24T10:00:00Z')
    await noteNodeSeen('2026-07-24T09:00:00Z') // older, must not rewind
    expect(await getNodeLastSeen()).toBe('2026-07-24T10:00:00Z')
    await noteNodeSeen('2026-07-24T11:00:00Z')
    expect(await getNodeLastSeen()).toBe('2026-07-24T11:00:00Z')
  })
})
