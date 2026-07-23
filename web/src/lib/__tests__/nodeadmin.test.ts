import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb } from '../db'
import { putProposer } from '../proposals'
import {
  adminLog,
  describeCommand,
  sortNewestFirst,
  enrolledNode,
  recordCommand,
  applyAdminReply,
  refreshAdminLog,
  getNodeLastSeen,
  noteNodeSeen,
  type AdminLogEntry,
} from '../nodeadmin'

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
  })

  it('orders the log newest-sent first', () => {
    const a: AdminLogEntry = { id: 'a', command: { cmd: 'job_status' }, sentAt: '2026-07-24T10:00:00Z' }
    const b: AdminLogEntry = { id: 'b', command: { cmd: 'job_status' }, sentAt: '2026-07-24T11:00:00Z' }
    expect(sortNewestFirst([a, b]).map((e) => e.id)).toEqual(['b', 'a'])
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
