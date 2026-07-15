import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline'
import type { StoredEvent } from '../events'
import { MOOD, MOOD_NOTE, GRATITUDE, LOINC, UCUM } from '../codes'

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

describe('buildTimeline: med/food/note formatting', () => {
  const at = '2026-01-01T10:00:00+00:00'

  it('labels a quick-logged med from its text value', () => {
    const events = [ev({ kind: 'medication_statement', effective_at: at, value: { text: 'Metformin' } })]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Metformin')
  })

  it('falls back to code.display for an imported med with no text value', () => {
    const events = [
      ev({
        kind: 'medication_statement',
        effective_at: at,
        code: { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076', display: 'Lisinopril 10 MG Oral Tablet' },
        value: null,
      }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Lisinopril 10 MG Oral Tablet')
    expect(entry.hint).toBe('RxNorm 314076')
  })

  it('renders an imported med dose quantity and degrades to the kind without any code', () => {
    const events = [
      ev({
        kind: 'medication_statement',
        effective_at: at,
        code: { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076', display: 'Lisinopril 10 MG Oral Tablet' },
        value: { quantity: { value: '1', unit: { system: UCUM, code: 'mg' } } },
      }),
      ev({ kind: 'medication_statement', effective_at: '2026-01-02T10:00:00+00:00', value: null }),
    ]
    const days = buildTimeline(events, 'all')
    const dosed = days[1].entries[0]
    expect(dosed.label).toBe('Lisinopril 10 MG Oral Tablet')
    expect(dosed.value).toBe('1 mg')
    const bare = days[0].entries[0]
    expect(bare.label).toBe('medication statement')
  })

  it('resolves a display-less imported med from the same RxNorm code named elsewhere', () => {
    const rxnorm = 'http://www.nlm.nih.gov/research/umls/rxnorm'
    const events = [
      ev({
        kind: 'medication_statement',
        effective_at: '2025-06-01T10:00:00+00:00',
        code: { system: rxnorm, code: '314076', display: 'Lisinopril 10 MG Oral Tablet' },
        value: null,
      }),
      ev({
        kind: 'medication_statement',
        effective_at: at,
        code: { system: rxnorm, code: '314076' },
        value: null,
      }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Lisinopril 10 MG Oral Tablet')
  })
})

describe('buildTimeline: clinical/other default formatting', () => {
  const at = '2026-01-01T10:00:00+00:00'

  it('formats a Quantity value the coded row used to drop', () => {
    const entry = buildTimeline(
      [
        ev({
          effective_at: at,
          kind: 'observation',
          code: { system: LOINC, code: '4548-4', display: 'Hemoglobin A1c' },
          value: { quantity: { value: '6.1', unit: { system: UCUM, code: '%' } } },
        }),
      ],
      'all',
    )[0].entries[0]
    expect(entry.label).toBe('Hemoglobin A1c')
    expect(entry.value).toBe('6.1 %')
    // Label already carries the display, so the hint is the shortened coding.
    expect(entry.hint).toBe('LOINC 4548-4')
  })

  it('degrades the label to the humanized kind and hints the coding when no display', () => {
    const entry = buildTimeline(
      [ev({ effective_at: at, kind: 'encounter', code: { system: LOINC, code: '4548-4' } })],
      'all',
    )[0].entries[0]
    expect(entry.label).toBe('encounter')
    expect(entry.hint).toBe('LOINC 4548-4')
  })

  it('hints the provenance source when the event carries no code', () => {
    const entry = buildTimeline(
      [
        ev({
          effective_at: at,
          kind: 'observation',
          provenance: { source: 'import:Nebraska Medicine', source_doc: 'abc123' },
        }),
      ],
      'all',
    )[0].entries[0]
    expect(entry.label).toBe('observation')
    expect(entry.hint).toBe('import:Nebraska Medicine')
  })

  it('leaves the hint empty when a self-logged row carries no code', () => {
    const entry = buildTimeline([ev({ effective_at: at, kind: 'observation' })], 'all')[0].entries[0]
    expect(entry.hint).toBeUndefined()
  })

  it('resolves a null display from the same code elsewhere in the vault', () => {
    const events = [
      // A different day/document named this code...
      ev({ effective_at: '2025-06-01T00:00:00+00:00', code: { system: LOINC, code: '39156-5', display: 'Body mass index (BMI) [Ratio]' } }),
      // ...so the display-less occurrence resolves it instead of degrading to "observation".
      ev({ effective_at: at, code: { system: LOINC, code: '39156-5' } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Body mass index (BMI) [Ratio]')
    // The label came from elsewhere, so the coding still surfaces as the hint.
    expect(entry.hint).toBe('LOINC 39156-5')
  })

  it('picks the most frequent display under conflicting names for the same code', () => {
    const events = [
      ev({ effective_at: '2025-01-01T00:00:00+00:00', code: { system: LOINC, code: '39156-5', display: 'Body mass index (BMI) [Ratio]' } }),
      ev({ effective_at: '2025-02-01T00:00:00+00:00', code: { system: LOINC, code: '39156-5', display: 'BMI' } }),
      ev({ effective_at: '2025-03-01T00:00:00+00:00', code: { system: LOINC, code: '39156-5', display: 'BMI' } }),
      ev({ effective_at: at, code: { system: LOINC, code: '39156-5' } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('BMI')
  })

  it('carries the first event provenance/coding through as detail', () => {
    const entry = buildTimeline(
      [
        ev({
          effective_at: at,
          kind: 'procedure',
          code: { system: LOINC, code: '4548-4', display: 'A1c' },
          provenance: { source: 'import:Clinic', source_doc: 'doc-sha' },
        }),
      ],
      'all',
    )[0].entries[0]
    expect(entry.detail).toEqual({
      kind: 'procedure',
      code: { system: LOINC, code: '4548-4', display: 'A1c' },
      source: 'import:Clinic',
      sourceDoc: 'doc-sha',
    })
  })
})
