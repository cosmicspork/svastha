import { describe, expect, it } from 'vitest'
import { searchEvents, SEARCH_CAP } from '../search'
import type { StoredEvent } from '../events'
import type { EventKind, EventValue } from '../drafts'
import { RXNORM, SNOMED, type Code } from '../codes'

let nextId = 0
function ev(partial: {
  kind?: EventKind
  code?: Code | null
  value?: EventValue | null
  effective_at?: string | null
}): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: partial.kind ?? 'observation',
      code: partial.code ?? null,
      value: partial.value ?? null,
      effective_at: partial.effective_at ?? null,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

describe('searchEvents', () => {
  it('returns nothing for an empty or whitespace query', () => {
    const events = [ev({ code: { system: SNOMED, code: '25064002', display: 'Headache' } })]
    expect(searchEvents(events, '').hits).toEqual([])
    expect(searchEvents(events, '   ').hits).toEqual([])
  })

  it('matches on a resolved display label', () => {
    const events = [
      ev({ code: { system: SNOMED, code: '25064002', display: 'Headache' } }),
      ev({ code: { system: SNOMED, code: '84229001', display: 'Fatigue' } }),
    ]
    const { hits } = searchEvents(events, 'headache')
    expect(hits).toHaveLength(1)
    expect(hits[0].label).toBe('Headache')
  })

  it('borrows a name from elsewhere in the vault for a display-less coded event', () => {
    const events = [
      ev({ code: { system: RXNORM, code: '313782', display: 'Acetaminophen 325 MG' } }),
      ev({ code: { system: RXNORM, code: '313782' } }), // no display of its own
    ]
    const { hits } = searchEvents(events, 'acetaminophen')
    expect(hits).toHaveLength(2)
  })

  it('names and matches a display-less code through the offline dictionary', () => {
    // An imported condition: no display of its own, no other occurrence to
    // borrow from, and not one of the app's own quick-log codes — so the
    // dictionary is the only thing that can name it.
    const events = [ev({ code: { system: SNOMED, code: '73211009' } })]
    const dictionary = new Map([[`${SNOMED}|73211009`, 'Diabetes mellitus']])
    expect(searchEvents(events, 'diabetes').hits).toHaveLength(0)
    const { hits } = searchEvents(events, 'diabetes', dictionary)
    expect(hits).toHaveLength(1)
    expect(hits[0].label).toBe('Diabetes mellitus')
  })

  it("names a quick-logged symptom from the app's own label, dictionary or not", () => {
    const events = [ev({ code: { system: SNOMED, code: '25064002' } })]
    expect(searchEvents(events, 'headache').hits).toHaveLength(1)
  })

  it('matches on the raw code and on the system acronym', () => {
    const events = [ev({ code: { system: RXNORM, code: '313782', display: 'Acetaminophen' } })]
    expect(searchEvents(events, '313782').hits).toHaveLength(1)
    expect(searchEvents(events, 'rxnorm').hits).toHaveLength(1)
  })

  it('matches on free-text note content', () => {
    const events = [ev({ kind: 'document', value: { text: 'worse with screen glare' } })]
    const { hits } = searchEvents(events, 'glare')
    expect(hits).toHaveLength(1)
    expect(hits[0].label).toBe('worse with screen glare')
  })

  it('requires every term (AND), not any', () => {
    const events = [
      ev({ code: { system: SNOMED, code: '1', display: 'Left knee pain' } }),
      ev({ code: { system: SNOMED, code: '2', display: 'Right knee pain' } }),
    ]
    expect(searchEvents(events, 'left knee').hits).toHaveLength(1)
    expect(searchEvents(events, 'knee pain').hits).toHaveLength(2)
  })

  it('orders newest first by effective_at, undated last', () => {
    const events = [
      ev({ code: { system: SNOMED, code: '1', display: 'pain' }, effective_at: '2026-07-01T00:00:00Z' }),
      ev({ code: { system: SNOMED, code: '2', display: 'pain' }, effective_at: null }),
      ev({ code: { system: SNOMED, code: '3', display: 'pain' }, effective_at: '2026-07-20T00:00:00Z' }),
    ]
    const { hits } = searchEvents(events, 'pain')
    expect(hits.map((h) => h.event.event.code!.code)).toEqual(['3', '1', '2'])
  })

  it('caps results and reports truncation', () => {
    const events = Array.from({ length: SEARCH_CAP + 5 }, (_, i) =>
      ev({ code: { system: SNOMED, code: String(i), display: 'ache' } }),
    )
    const { hits, truncated } = searchEvents(events, 'ache')
    expect(hits).toHaveLength(SEARCH_CAP)
    expect(truncated).toBe(true)
  })
})
