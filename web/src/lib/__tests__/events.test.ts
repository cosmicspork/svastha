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
  recentTemplates,
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

describe('recentTemplates for the Meds form', () => {
  const stored = (kind: StoredEvent['event']['kind'], value: StoredEvent['event']['value'], at: string, code: StoredEvent['event']['code'] = null): StoredEvent => ({
    event: { id: `${kind}-${at}`, kind, code, effective_at: at, value, provenance: { source: 'self', source_doc: null } },
    author: 'owner-ed',
    signature: 'sig',
  })
  const RX = { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '745679', display: 'Albuterol inhaler' }

  it('offers recent doses only — never a standing statement, imported or old', () => {
    const events = [
      stored('medication_statement', { text: 'Ibuprofen — 400 mg' }, '2026-07-03T09:00:00Z'),
      stored('medication_statement', null, '2026-07-04T09:00:00Z', RX),
      stored('medication_dose', { text: 'Ibuprofen' }, '2026-07-01T09:00:00Z'),
      // A coded dose logged with no amount has no value, and is still a recent.
      stored('medication_dose', null, '2026-07-02T09:00:00Z', RX),
    ]
    expect(recentTemplates(events, 'med', 8)).toEqual([
      { kind: 'medication_dose', code: RX, value: null },
      { kind: 'medication_dose', value: { text: 'Ibuprofen' } },
    ])
  })

  it('still skips a valueless event in other categories', () => {
    const events = [stored('nutrition_intake', null, '2026-07-01T09:00:00Z')]
    expect(recentTemplates(events, 'food', 8)).toEqual([])
  })
})
