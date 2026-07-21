import { describe, expect, it } from 'vitest'
import { lanes, preceding, shouldDownsample } from '../correlate'
import type { StoredEvent } from '../events'
import { SNOMED, LOINC, UCUM, MOOD, MOOD_NOTE, GRATITUDE, CYCLE_START, CYCLE_END, CYCLE_FLOW, CYCLE_CLOTS } from '../codes'

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

function symptomEvent(effective_at: string, severity: number, name = 'Headache'): StoredEvent {
  return ev({
    effective_at,
    code: { system: SNOMED, code: '25064002', display: name },
    value: { quantity: { value: String(severity), unit: null } },
  })
}

function freeTextSymptomEvent(effective_at: string, name: string): StoredEvent {
  return ev({ effective_at, value: { text: name } })
}

function foodEvent(effective_at: string, item: string): StoredEvent {
  return ev({ kind: 'nutrition_intake', effective_at, value: { text: item } })
}

function medEvent(effective_at: string, name: string): StoredEvent {
  return ev({ kind: 'medication_statement', effective_at, value: { text: name } })
}

function exerciseActivityEvent(effective_at: string, activity: string): StoredEvent {
  return ev({
    effective_at,
    code: { system: LOINC, code: '73985-4', display: 'Exercise activity' },
    value: { text: activity },
  })
}

function exerciseDurationEvent(effective_at: string, minutes: string): StoredEvent {
  return ev({
    effective_at,
    code: { system: LOINC, code: '55411-3', display: 'Exercise duration' },
    value: { quantity: { value: minutes, unit: { system: UCUM, code: 'min' } } },
  })
}

function moodEvent(effective_at: string, score: number): StoredEvent {
  return ev({ effective_at, code: MOOD, value: { quantity: { value: String(score), unit: null } } })
}

function moodNoteEvent(effective_at: string, note: string): StoredEvent {
  return ev({ effective_at, code: MOOD_NOTE, value: { text: note } })
}

function gratitudeEvent(effective_at: string, item: string): StoredEvent {
  return ev({ effective_at, code: GRATITUDE, value: { text: item } })
}

function cycleStartEvent(effective_at: string): StoredEvent {
  return ev({ effective_at, code: CYCLE_START, value: null })
}

function cycleEndEvent(effective_at: string): StoredEvent {
  return ev({ effective_at, code: CYCLE_END, value: null })
}

function cycleFlowEvent(effective_at: string, level: number): StoredEvent {
  return ev({ effective_at, code: CYCLE_FLOW, value: { quantity: { value: String(level), unit: null } } })
}

function cycleClotsEvent(effective_at: string): StoredEvent {
  return ev({ effective_at, code: CYCLE_CLOTS, value: null })
}

describe('lanes', () => {
  it('groups symptoms by code display name and reads severity off the quantity', () => {
    const events = [symptomEvent('2026-01-01T08:00:00+00:00', 8), symptomEvent('2026-01-01T20:00:00+00:00', 3)]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms).toHaveLength(1)
    expect(symptoms[0].name).toBe('Headache')
    expect(symptoms[0].points.map((p) => p.severity)).toEqual([8, 3])
  })

  it('groups a free-text symptom by its text, with null severity', () => {
    const events = [freeTextSymptomEvent('2026-01-01T08:00:00+00:00', 'Weird tingling')]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms).toEqual([
      {
        name: 'Weird tingling',
        points: [{ atIso: '2026-01-01T08:00:00+00:00', severity: null, eventId: events[0].event.id }],
        max: 10,
      },
    ])
  })

  it('separates distinct symptoms into distinct lanes, sorted by name', () => {
    const events = [symptomEvent('2026-01-01T08:00:00+00:00', 5, 'Nausea'), symptomEvent('2026-01-01T09:00:00+00:00', 5, 'Headache')]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms.map((s) => s.name)).toEqual(['Headache', 'Nausea'])
  })

  it('lanes food/med/exercise-activity as input ticks, skipping the exercise duration observation', () => {
    const events = [
      foodEvent('2026-01-01T08:00:00+00:00', 'oatmeal'),
      medEvent('2026-01-01T09:00:00+00:00', 'ibuprofen — 400 mg'),
      exerciseActivityEvent('2026-01-01T10:00:00+00:00', 'walk'),
      exerciseDurationEvent('2026-01-01T10:00:00+00:00', '30'),
    ]
    const { inputs } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(inputs).toEqual([
      { category: 'food', ticks: [{ atIso: '2026-01-01T08:00:00+00:00', label: 'oatmeal' }] },
      { category: 'med', ticks: [{ atIso: '2026-01-01T09:00:00+00:00', label: 'ibuprofen — 400 mg' }] },
      { category: 'exercise', ticks: [{ atIso: '2026-01-01T10:00:00+00:00', label: 'walk' }] },
    ])
  })

  it('filters events outside the [from, to] range', () => {
    const events = [
      symptomEvent('2025-12-31T23:00:00+00:00', 5), // before range
      symptomEvent('2026-01-01T12:00:00+00:00', 5), // inside
      symptomEvent('2026-01-03T00:00:00+00:00', 5), // after range
    ]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms[0].points).toHaveLength(1)
    expect(symptoms[0].points[0].atIso).toBe('2026-01-01T12:00:00+00:00')
  })

  it('range boundaries are inclusive', () => {
    const events = [symptomEvent('2026-01-01T00:00:00+00:00', 5), symptomEvent('2026-01-02T00:00:00+00:00', 5)]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms[0].points).toHaveLength(2)
  })

  it('skips undated events', () => {
    const events = [ev({ effective_at: null as unknown as string, code: null, value: { text: 'nope' } })]
    const { symptoms, inputs } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
    expect(symptoms).toHaveLength(0)
    expect(inputs).toHaveLength(0)
  })

  it('lanes mood observations as a Mood lane scaled to 5, leaving symptom lanes on a 10 scale', () => {
    const events = [
      symptomEvent('2026-01-01T08:00:00+00:00', 8),
      moodEvent('2026-01-01T09:00:00+00:00', 4),
      moodNoteEvent('2026-01-01T09:00:00+00:00', 'calm morning'),
      gratitudeEvent('2026-01-01T10:00:00+00:00', 'slow morning'),
    ]
    const { symptoms, inputs } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')

    const headache = symptoms.find((s) => s.name === 'Headache')
    expect(headache?.max).toBe(10)

    const mood = symptoms.find((s) => s.name === 'Mood')
    expect(mood?.max).toBe(5)
    expect(mood?.points).toEqual([
      { atIso: '2026-01-01T09:00:00+00:00', severity: 4, eventId: events[1].event.id },
    ])

    // Mood note and gratitude never become their own lane, nor an input tick.
    expect(symptoms.some((s) => s.name === 'Mood note' || s.name === 'calm morning')).toBe(false)
    expect(symptoms).toHaveLength(2)
    expect(inputs).toHaveLength(0)
  })

  it('downsamples symptom points to one-per-day (max severity) beyond the 90-day threshold', () => {
    expect(shouldDownsample('2026-01-01T00:00:00+00:00', '2026-04-15T00:00:00+00:00')).toBe(true)
    expect(shouldDownsample('2026-01-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00')).toBe(false)

    const events = [
      symptomEvent('2026-01-05T08:00:00+00:00', 3),
      symptomEvent('2026-01-05T20:00:00+00:00', 9), // day's max
      symptomEvent('2026-01-06T08:00:00+00:00', 4),
    ]
    const { symptoms } = lanes(events, '2026-01-01T00:00:00+00:00', '2026-04-15T00:00:00+00:00')
    expect(symptoms[0].points).toEqual([
      { atIso: '2026-01-05T20:00:00+00:00', severity: 9, eventId: events[1].event.id },
      { atIso: '2026-01-06T08:00:00+00:00', severity: 4, eventId: events[2].event.id },
    ])
  })
})

describe('cycle lane', () => {
  const from = '2026-01-01T00:00:00+00:00'
  const to = '2026-01-31T00:00:00+00:00'

  it('is null when no cycle events fall in the window', () => {
    const { cycle } = lanes([symptomEvent('2026-01-05T08:00:00+00:00', 5)], from, to)
    expect(cycle).toBeNull()
  })

  it('is present when cycle events fall in the window', () => {
    const { cycle } = lanes([cycleFlowEvent('2026-01-05T08:00:00+00:00', 3)], from, to)
    expect(cycle).not.toBeNull()
    expect(cycle!.cells).toHaveLength(1)
  })

  it('is excluded when the only cycle events sit outside the window', () => {
    const { cycle } = lanes([cycleFlowEvent('2025-12-20T08:00:00+00:00', 3)], from, to)
    expect(cycle).toBeNull()
  })

  it('maps a flow observation to its 1–4 level on the band cell', () => {
    const { cycle } = lanes([cycleFlowEvent('2026-01-05T08:00:00+00:00', 4)], from, to)
    expect(cycle!.cells[0].level).toBe(4)
  })

  it('keeps the day’s strongest flow reading when a day has several', () => {
    const { cycle } = lanes(
      [cycleFlowEvent('2026-01-05T08:00:00+00:00', 2), cycleFlowEvent('2026-01-05T20:00:00+00:00', 4)],
      from,
      to,
    )
    expect(cycle!.cells).toHaveLength(1)
    expect(cycle!.cells[0].level).toBe(4)
  })

  it('marks a start day with a null level even without flow', () => {
    const { cycle } = lanes([cycleStartEvent('2026-01-03T09:00:00+00:00')], from, to)
    expect(cycle!.cells).toEqual([{ atIso: '2026-01-03T09:00:00+00:00', level: null }])
  })

  it('lets a flow reading upgrade a same-day start marker from null to its level', () => {
    const { cycle } = lanes(
      [cycleStartEvent('2026-01-03T07:00:00+00:00'), cycleFlowEvent('2026-01-03T08:00:00+00:00', 3)],
      from,
      to,
    )
    expect(cycle!.cells).toHaveLength(1)
    expect(cycle!.cells[0].level).toBe(3)
  })

  it('marks an end day too, and orders cells chronologically', () => {
    const { cycle } = lanes(
      [cycleEndEvent('2026-01-08T09:00:00+00:00'), cycleFlowEvent('2026-01-03T09:00:00+00:00', 2)],
      from,
      to,
    )
    expect(cycle!.cells.map((c) => c.atIso)).toEqual([
      '2026-01-03T09:00:00+00:00',
      '2026-01-08T09:00:00+00:00',
    ])
    expect(cycle!.cells.map((c) => c.level)).toEqual([2, null])
  })

  it('does not open a band cell for a clots reading with no flow or marker that day', () => {
    const { cycle } = lanes([cycleClotsEvent('2026-01-05T09:00:00+00:00')], from, to)
    expect(cycle).toBeNull()
  })
})

describe('preceding', () => {
  it('includes an input at exactly window-start and excludes one at exactly the symptom time', () => {
    const symptomAt = '2026-01-01T12:00:00+00:00'
    const events = [
      foodEvent('2026-01-01T00:00:00+00:00', 'exactly-at-window-start'), // 12h before, window=12
      foodEvent('2026-01-01T12:00:00+00:00', 'exactly-at-symptom-time'),
    ]
    const result = preceding(events, symptomAt, 12)
    expect(result.map((r) => r.label)).toEqual(['exactly-at-window-start'])
    expect(result[0].deltaHours).toBeCloseTo(12, 5)
  })

  it('excludes inputs before the window and after the symptom', () => {
    const symptomAt = '2026-01-01T12:00:00+00:00'
    const events = [
      foodEvent('2026-01-01T00:00:00+00:00', 'too-early'), // 12h before, window 6h
      foodEvent('2026-01-01T10:00:00+00:00', 'in-window'),
      foodEvent('2026-01-01T13:00:00+00:00', 'after-symptom'),
    ]
    const result = preceding(events, symptomAt, 6)
    expect(result.map((r) => r.label)).toEqual(['in-window'])
  })

  it('returns results chronologically (earliest first) grouped implicitly by category', () => {
    const symptomAt = '2026-01-01T12:00:00+00:00'
    const events = [
      medEvent('2026-01-01T10:00:00+00:00', 'ibuprofen'),
      foodEvent('2026-01-01T06:00:00+00:00', 'peanut butter'),
      exerciseActivityEvent('2026-01-01T08:00:00+00:00', 'run'),
    ]
    const result = preceding(events, symptomAt, 24)
    expect(result.map((r) => r.label)).toEqual(['peanut butter', 'run', 'ibuprofen'])
    expect(result.map((r) => Math.round(r.deltaHours))).toEqual([6, 4, 2])
  })

  it('ignores symptom/clinical events even inside the window', () => {
    const symptomAt = '2026-01-01T12:00:00+00:00'
    const events = [symptomEvent('2026-01-01T10:00:00+00:00', 5, 'Nausea')]
    expect(preceding(events, symptomAt, 24)).toEqual([])
  })
})
