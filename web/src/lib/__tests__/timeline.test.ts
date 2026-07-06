import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline'
import type { StoredEvent } from '../events'
import { MOOD, MOOD_NOTE, GRATITUDE } from '../codes'

let nextId = 0
function ev(partial: Partial<StoredEvent['event']> & { effective_at: string }): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: 'observation',
      code: null,
      value: null,
      provenance: { source: 'self', source_doc: null },
      ...partial,
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

describe('buildTimeline: mind category formatting', () => {
  it('formats a mood group as the scale word plus its note', () => {
    const at = '2026-01-01T09:00:00+00:00'
    const events = [
      ev({ effective_at: at, code: MOOD, value: { quantity: { value: '4', unit: null } } }),
      ev({ effective_at: at, code: MOOD_NOTE, value: { text: 'calm morning' } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.category).toBe('mind')
    expect(entry.label).toBe('Mood')
    expect(entry.value).toBe('good — calm morning')
  })

  it('formats a mood group with no note as just the word', () => {
    const at = '2026-01-01T09:00:00+00:00'
    const events = [ev({ effective_at: at, code: MOOD, value: { quantity: { value: '1', unit: null } } })]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.value).toBe('rough')
  })

  it('formats a gratitude group by joining item texts', () => {
    const at = '2026-01-01T21:00:00+00:00'
    const events = [
      ev({ effective_at: at, code: GRATITUDE, value: { text: 'slow morning' } }),
      ev({ effective_at: at, code: GRATITUDE, value: { text: 'call with mom' } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Gratitude')
    expect(entry.value).toBe('slow morning · call with mom')
  })
})
