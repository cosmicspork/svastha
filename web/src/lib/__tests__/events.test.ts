import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the wasm identity is faked (a dependency, not the unit under test):
// sign_event wraps the content it is handed, so assertions about the stored
// events check what approveProposedEvents actually passed to the signer.
const fake = vi.hoisted(() => ({
  identity: null as null | { sign_event: (content: string) => string },
  signCalls: 0,
}))
vi.mock('../session.svelte', () => ({ session: { get identity() { return fake.identity } } }))

import { deleteDb } from '../db'
import {
  approveProposedEvent,
  approveProposedEvents,
  allEvents,
  setOnEventsLogged,
  type StoredEvent,
} from '../events'

function unlock(): void {
  fake.identity = {
    sign_event: (content: string) => {
      fake.signCalls += 1
      const parsed = JSON.parse(content) as Record<string, unknown>
      const value = parsed.value as { text: string }
      return JSON.stringify({
        event: { id: `id-${value.text}`, ...parsed },
        author: 'owner-ed',
        signature: `sig-${fake.signCalls}`,
      })
    },
  }
}

function draft(text: string) {
  return {
    content: {
      kind: 'observation' as const,
      code: null,
      effective_at: '2026-07-20T09:00:00+00:00',
      value: { text },
      provenance: { source: 'node', source_doc: null },
    },
    proposed: { by: 'n'.repeat(64), source_blob: `att-${text}`, method: 'ocr', model: 'm' },
  }
}

let logged: StoredEvent[][]
beforeEach(async () => {
  await deleteDb()
  fake.identity = null
  fake.signCalls = 0
  logged = []
  setOnEventsLogged((events) => logged.push(events))
})

describe('approveProposedEvents', () => {
  it('stores the whole batch and fires onEventsLogged exactly once, in order', async () => {
    unlock()
    const stored = await approveProposedEvents([draft('a'), draft('b'), draft('c')])

    expect(stored.map((e) => e.event.id)).toEqual(['id-a', 'id-b', 'id-c'])
    const persisted = await allEvents()
    expect(persisted.map((e) => e.event.id).sort()).toEqual(['id-a', 'id-b', 'id-c'])

    expect(logged).toHaveLength(1)
    expect(logged[0]).toEqual(stored)
  })

  it('passes proposed provenance into the signing payload', async () => {
    unlock()
    const [stored] = await approveProposedEvents([draft('a')])
    expect((stored.event as { proposed?: unknown }).proposed).toEqual({
      by: 'n'.repeat(64),
      source_blob: 'att-a',
      method: 'ocr',
      model: 'm',
    })
  })

  it('an empty batch stores nothing and never fires the hook', async () => {
    unlock()
    expect(await approveProposedEvents([])).toEqual([])
    expect(await allEvents()).toEqual([])
    expect(logged).toEqual([])
  })

  it('throws when the session is locked', async () => {
    await expect(approveProposedEvents([draft('a')])).rejects.toThrow('Session is locked')
    expect(await allEvents()).toEqual([])
    expect(logged).toEqual([])
  })
})

describe('approveProposedEvent', () => {
  it('returns the single stored event and fires the hook with a one-element batch', async () => {
    unlock()
    const { content, proposed } = draft('solo')
    const stored = await approveProposedEvent(content, proposed)
    expect(stored.event.id).toBe('id-solo')
    expect((await allEvents()).map((e) => e.event.id)).toEqual(['id-solo'])
    expect(logged).toEqual([[stored]])
  })
})
