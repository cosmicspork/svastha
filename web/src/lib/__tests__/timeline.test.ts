import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline'
import { dayKey } from '../time'
import type { StoredEvent } from '../events'
import { MOOD, MOOD_NOTE, GRATITUDE, CYCLE_START, CYCLE_END, CYCLE_FLOW, CYCLE_CLOTS, LOINC, UCUM } from '../codes'

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

describe('buildTimeline: cycle category formatting', () => {
  it('formats a lone start marker as "Period started"', () => {
    const at = '2026-01-01T09:00:00+00:00'
    const events = [ev({ effective_at: at, code: CYCLE_START, value: null })]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.category).toBe('cycle')
    expect(entry.label).toBe('Period started')
    expect(entry.value).toBe('')
  })

  it('folds a start marker with its flow and clots siblings into one line', () => {
    const at = '2026-01-01T09:00:00+00:00'
    const events = [
      ev({ effective_at: at, code: CYCLE_START, value: null }),
      ev({ effective_at: at, code: CYCLE_FLOW, value: { quantity: { value: '3', unit: null } } }),
      ev({ effective_at: at, code: CYCLE_CLOTS, value: null }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Period started · Moderate · clots')
  })

  it('formats a flow reading with clots as its word plus a clots suffix', () => {
    const at = '2026-01-02T09:00:00+00:00'
    const events = [
      ev({ effective_at: at, code: CYCLE_FLOW, value: { quantity: { value: '4', unit: null } } }),
      ev({ effective_at: at, code: CYCLE_CLOTS, value: null }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Heavy · clots')
  })

  it('formats an end marker as "Period ended"', () => {
    const at = '2026-01-10T09:00:00+00:00'
    const events = [ev({ effective_at: at, code: CYCLE_END, value: null })]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Period ended')
  })
})

describe('buildTimeline: offline dictionary layering', () => {
  const at = '2026-02-01T10:00:00+00:00'
  const ICD = 'http://hl7.org/fhir/sid/icd-10-cm'

  it('labels an unnamed coded condition from the dictionary, below the vault index', () => {
    const events = [ev({ kind: 'condition', effective_at: at, code: { system: ICD, code: 'E11.9' } })]
    const dict = new Map([[`${ICD}|E11.9`, 'Type 2 diabetes mellitus without complications']])
    // Without the dictionary it degrades to the shortened coding hint / kind.
    expect(buildTimeline(events, 'all')[0].entries[0].label).toBe('condition')
    // With it, the dictionary name surfaces.
    expect(buildTimeline(events, 'all', dict)[0].entries[0].label).toBe(
      'Type 2 diabetes mellitus without complications',
    )
  })

  it('lets a name from the user own records win over the dictionary', () => {
    const events = [
      ev({ kind: 'condition', effective_at: at, code: { system: ICD, code: 'E11.9', display: 'My diabetes' } }),
      ev({ kind: 'condition', effective_at: '2026-02-02T10:00:00+00:00', code: { system: ICD, code: 'E11.9' } }),
    ]
    const dict = new Map([[`${ICD}|E11.9`, 'Type 2 diabetes mellitus without complications']])
    // The second (unnamed) event borrows the first event's display via the
    // vault index, not the dictionary.
    for (const day of buildTimeline(events, 'all', dict)) {
      for (const entry of day.entries) expect(entry.label).toBe('My diabetes')
    }
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

describe('buildTimeline: visit-note nesting (decision C2)', () => {
  function encounter(at: string, sourceDoc: string | null): StoredEvent {
    return ev({
      kind: 'encounter',
      effective_at: at,
      code: { system: LOINC, code: '99213', display: 'Office visit' },
      provenance: { source: 'import:Clinic', source_doc: sourceDoc },
    })
  }
  function note(at: string, text: string, sourceDoc: string | null, display?: string): StoredEvent {
    return ev({
      kind: 'document',
      effective_at: at,
      value: { text },
      code: display ? { system: LOINC, code: '18776-5', display } : null,
      provenance: { source: sourceDoc ? 'import:Clinic' : 'self', source_doc: sourceDoc },
    })
  }

  it('nests a note under the encounter sharing its source document (rule a)', () => {
    const at = '2026-02-01T10:00:00+00:00'
    const days = buildTimeline(
      [encounter(at, 'docA'), note(at, 'Plan: rest and recheck.', 'docA', 'Plan of Care')],
      'all',
    )
    expect(days).toHaveLength(1)
    // Only the encounter is a visible row; the note folded into it.
    expect(days[0].entries).toHaveLength(1)
    const enc = days[0].entries[0]
    expect(enc.category).toBe('clinical')
    expect(enc.notes).toHaveLength(1)
    expect(enc.notes[0]).toMatchObject({ label: 'Plan of Care', text: 'Plan: rest and recheck.' })
    expect(enc.hint).toBe('1 note')
    // Curation still keys off the encounter's own event id, not the note's.
    expect(enc.eventIds).toHaveLength(1)
    expect(enc.eventIds[0]).not.toBe(enc.notes[0].eventIds[0])
  })

  it('nests a note under the sole encounter on its day when no source doc matches (rule b)', () => {
    const days = buildTimeline(
      [
        encounter('2026-02-02T09:00:00+00:00', 'docX'),
        note('2026-02-02T18:00:00+00:00', 'Self note.', null),
      ],
      'all',
    )
    expect(days[0].entries).toHaveLength(1)
    expect(days[0].entries[0].category).toBe('clinical')
    expect(days[0].entries[0].notes).toHaveLength(1)
  })

  it('leaves a note standalone when its day has two encounters and no source-doc match', () => {
    const days = buildTimeline(
      [
        encounter('2026-02-03T09:00:00+00:00', 'docA'),
        encounter('2026-02-03T13:00:00+00:00', 'docB'),
        note('2026-02-03T20:00:00+00:00', 'A standalone personal note.', null),
      ],
      'all',
    )
    // Three rows: two encounters (neither carrying the note) + the lone note.
    expect(days[0].entries).toHaveLength(3)
    const noteRow = days[0].entries.find((e) => e.category === 'note')
    expect(noteRow).toBeDefined()
    expect(days[0].entries.filter((e) => e.category === 'clinical').every((e) => e.notes.length === 0)).toBe(
      true,
    )
  })

  it('leaves a note standalone when its source doc matches only encounters on other days', () => {
    // A longitudinal summary holds many encounters; its own narrative dated to
    // none of them belongs to no single visit and must not be filed under an
    // arbitrary one (which would move it off its own date).
    const days = buildTimeline(
      [
        encounter('2026-03-01T09:00:00+00:00', 'summaryCcd'),
        encounter('2026-03-05T09:00:00+00:00', 'summaryCcd'),
        note('2026-03-10T00:00:00+00:00', 'Summary-level plan prose.', 'summaryCcd', 'Plan of Care'),
      ],
      'all',
    )
    const allEntries = days.flatMap((d) => d.entries)
    expect(allEntries).toHaveLength(3)
    const noteRow = allEntries.find((e) => e.category === 'note')
    expect(noteRow).toBeDefined()
    expect(dayKey(noteRow!.effective_at)).toBe('2026-03-10')
    expect(allEntries.filter((e) => e.category === 'clinical').every((e) => e.notes.length === 0)).toBe(true)
  })

  it('caps a standalone note row to a first-line preview but keeps full prose in notes', () => {
    const long = `${'x'.repeat(200)}\nsecond paragraph`
    const days = buildTimeline([note('2026-02-04T10:00:00+00:00', long, null)], 'all')
    const noteRow = days[0].entries[0]
    expect(noteRow.category).toBe('note')
    expect(noteRow.label.length).toBeLessThanOrEqual(91) // 90 chars + ellipsis
    expect(noteRow.label.endsWith('…')).toBe(true)
    expect(noteRow.notes[0].text).toBe(long)
  })

  it('folds every section of a multi-section visit note under one encounter', () => {
    const at = '2026-02-05T10:00:00+00:00'
    // Two narrative sections sharing the visit date land in one note group,
    // then fold into the encounter as two individually-titled notes.
    const days = buildTimeline(
      [
        encounter(at, 'docV'),
        note(at, 'Plan text.', 'docV', 'Plan of Care'),
        note(at, 'Assessment text.', 'docV', 'Assessment'),
      ],
      'all',
    )
    expect(days[0].entries).toHaveLength(1)
    expect(days[0].entries[0].notes.map((n) => n.label).sort()).toEqual(['Assessment', 'Plan of Care'])
    expect(days[0].entries[0].hint).toBe('2 notes')
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

describe('buildTimeline: paper records (attachment documents)', () => {
  const at = '2026-01-01T09:00:00+00:00'

  it('groups multi-page captures with their caption into one note entry', () => {
    const events = [
      ev({ effective_at: at, kind: 'document', value: { attachment: { sha256: 'bb', mime: 'image/jpeg', size: 20 } } }),
      ev({ effective_at: at, kind: 'document', value: { attachment: { sha256: 'aa', mime: 'image/jpeg', size: 10 } } }),
      ev({ effective_at: at, kind: 'document', value: { text: 'GI consult — Dr. Rao' } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.category).toBe('note')
    expect(entry.label).toBe('GI consult — Dr. Rao')
    expect(entry.hint).toBe('📷 2 pages')
    // sha-sorted for a stable page order.
    expect(entry.attachments).toEqual([
      { sha256: 'aa', mime: 'image/jpeg' },
      { sha256: 'bb', mime: 'image/jpeg' },
    ])
  })

  it('labels an uncaptioned single page "Paper record" with a 1-page hint', () => {
    const events = [
      ev({ effective_at: at, kind: 'document', value: { attachment: { sha256: 'aa', mime: 'image/jpeg', size: 10 } } }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.label).toBe('Paper record')
    expect(entry.hint).toBe('📷 1 page')
    expect(entry.attachments).toHaveLength(1)
  })

  it('keeps a PDF attachment in the entry and switches the hint to 📎 items', () => {
    const events = [
      ev({
        effective_at: at,
        kind: 'document',
        value: { attachment: { sha256: 'aa', mime: 'application/pdf', size: 4096 } },
      }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.hint).toBe('📎 1 item')
    expect(entry.attachments).toEqual([{ sha256: 'aa', mime: 'application/pdf' }])
  })

  it('uses the neutral 📎 items hint when a capture mixes a photo and a PDF', () => {
    const events = [
      ev({ effective_at: at, kind: 'document', value: { attachment: { sha256: 'aa', mime: 'image/jpeg', size: 10 } } }),
      ev({
        effective_at: at,
        kind: 'document',
        value: { attachment: { sha256: 'bb', mime: 'application/pdf', size: 4096 } },
      }),
    ]
    const entry = buildTimeline(events, 'all')[0].entries[0]
    expect(entry.hint).toBe('📎 2 items')
    expect(entry.attachments).toHaveLength(2)
  })
})
