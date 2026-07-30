import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../session.svelte', () => ({
  session: { identity: null },
}))
import { deleteDb, put } from '../db'
import { buildProposalRecord } from '../proposals'
import { UnreadableAnswerError, type ReadResult } from '../read-page'
import { runBulkRead, unreadAttachmentPages, type BulkPage } from '../bulk-read'

const PAGES: BulkPage[] = [
  { sha256: 'page-a', mime: 'application/pdf', label: 'Synthetic report' },
  { sha256: 'page-b', mime: 'application/pdf', label: 'Synthetic report' },
  { sha256: 'page-c', mime: 'application/pdf', label: 'Synthetic report' },
]

function result(proposed: number): ReadResult {
  return { proposed, dropped: 0, updated: false, fromPage: 1, toPage: 1, totalPages: 1 }
}

beforeEach(deleteDb)

describe('runBulkRead', () => {
  it('stops after the in-flight page settles and retains its result', async () => {
    const read: string[] = []
    let stop = false
    const progress: number[] = []

    const summary = await runBulkRead(
      PAGES,
      async (page) => {
        read.push(page.sha256)
        return result(1)
      },
      {
        shouldStop: () => stop,
        onProgress: (next) => {
          progress.push(next.completed)
          if (next.current?.sha256 === 'page-a') stop = true
        },
      },
    )

    expect(read).toEqual(['page-a'])
    expect(summary).toEqual({ read: 1, nothingFound: 0, unreadable: 0, completed: 1, total: 3, stopped: true })
    expect(progress).toEqual([0, 1])
  })

  it('keeps the reader sequential and distinguishes unreadable answers from nothing found', async () => {
    const read: string[] = []
    let active = 0
    let maximumActive = 0

    const summary = await runBulkRead(PAGES, async (page) => {
      read.push(page.sha256)
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      if (page.sha256 === 'page-b') throw new UnreadableAnswerError('synthetic malformed answer')
      return result(page.sha256 === 'page-a' ? 1 : 0)
    })

    expect(read).toEqual(['page-a', 'page-b', 'page-c'])
    expect(maximumActive).toBe(1)
    expect(summary).toEqual({ read: 1, nothingFound: 1, unreadable: 1, completed: 3, total: 3, stopped: false })
  })
})

describe('unreadAttachmentPages', () => {
  it('uses attachment events and blobs, skips sources with proposals, and keeps the capture label', async () => {
    await put('attachments', { sha256: 'unread', mime: 'image/jpeg', size: 1, bytes: new Uint8Array([1]) })
    await put('attachments', { sha256: 'proposed', mime: 'image/jpeg', size: 1, bytes: new Uint8Array([2]) })
    await put('attachments', { sha256: 'missing', mime: 'image/jpeg', size: 1, bytes: new Uint8Array([3]) })

    const at = '2026-01-02T03:04:05.000Z'
    for (const [id, sha256] of [
      ['unread-event', 'unread'],
      ['proposed-event', 'proposed'],
      ['missing-event', 'not-stored'],
    ]) {
      await put('events', {
        event: {
          id,
          kind: 'document',
          code: null,
          effective_at: at,
          value: { attachment: { sha256, mime: 'image/jpeg', size: 1 } },
          provenance: { source: 'self', source_doc: null },
        },
        author: 'synthetic',
        signature: 'synthetic',
      })
    }
    await put('events', {
      event: {
        id: 'caption',
        kind: 'document',
        code: null,
        effective_at: at,
        value: { text: 'Synthetic report' },
        provenance: { source: 'self', source_doc: null },
      },
      author: 'synthetic',
      signature: 'synthetic',
    })
    await put(
      'proposals',
      buildProposalRecord({
        id: 'local-proposed',
        fromEd: 'synthetic',
        mailboxItemId: '',
        sentAt: 0,
        local: true,
        drafts: [
          {
            event: {
              id: 'draft',
              kind: 'document',
              code: null,
              effective_at: at,
              value: null,
              provenance: { source: 'ocr', source_doc: 'proposed' },
            },
            source_blob: 'proposed',
          },
        ],
      }),
    )

    await expect(unreadAttachmentPages()).resolves.toEqual([
      { sha256: 'unread', mime: 'image/jpeg', label: 'Synthetic report' },
    ])
  })
})
