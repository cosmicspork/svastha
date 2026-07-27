import { describe, expect, it } from 'vitest'
import type { StoredEvent } from '../events'
import { BP_SYSTOLIC, BP_DIASTOLIC, VITALS, SYMPTOMS } from '../codes'
import { recentActivity, vitalGlances, recentSymptoms, medicationGlance } from '../glance'

const HR = VITALS.find((v) => v.key === 'hr')!.loinc
const NOW = Date.parse('2026-07-27T12:00:00Z')
const DAY = 86_400_000
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

let seq = 0
function evt(o: {
  kind?: StoredEvent['event']['kind']
  code?: StoredEvent['event']['code']
  value?: StoredEvent['event']['value']
  at?: string | null
}): StoredEvent {
  return {
    event: {
      id: `e${seq++}`,
      kind: o.kind ?? 'observation',
      code: o.code ?? null,
      effective_at: o.at ?? null,
      value: o.value ?? null,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'a',
    signature: 's',
  }
}
const qty = (value: string): StoredEvent['event']['value'] => ({
  quantity: { value, unit: null },
})

describe('vitalGlances', () => {
  it('averages blood pressure over the last week and trends vs the prior week', () => {
    const events = [
      // last 7 days: systolic mean 118, diastolic mean 76
      evt({ code: BP_SYSTOLIC, value: qty('116'), at: iso(1) }),
      evt({ code: BP_SYSTOLIC, value: qty('120'), at: iso(5) }),
      evt({ code: BP_DIASTOLIC, value: qty('74'), at: iso(1) }),
      evt({ code: BP_DIASTOLIC, value: qty('78'), at: iso(5) }),
      // prior week: systolic mean 124 (so recent is lower -> down)
      evt({ code: BP_SYSTOLIC, value: qty('122'), at: iso(9) }),
      evt({ code: BP_SYSTOLIC, value: qty('126'), at: iso(12) }),
      evt({ code: BP_DIASTOLIC, value: qty('80'), at: iso(9) }),
    ]
    const bp = vitalGlances(events, NOW).find((g) => g.key === 'bp')
    expect(bp).toMatchObject({ value: '118/76', basis: 'avg', trend: 'down' })
  })

  it('falls back to the latest reading when there is no recent week of data', () => {
    const hr = vitalGlances([evt({ code: HR, value: qty('64'), at: iso(9) })], NOW).find(
      (g) => g.key === 'hr',
    )
    expect(hr).toMatchObject({ value: '64', basis: 'latest', trend: null })
  })

  it('omits vitals the record has never had', () => {
    expect(vitalGlances([evt({ code: HR, value: qty('64'), at: iso(1) })], NOW)).toHaveLength(1)
  })
})

describe('recentSymptoms', () => {
  it('returns in-window symptoms, most severe first, with severity', () => {
    const events = [
      evt({ code: SYMPTOMS[0].snomed, value: qty('3'), at: iso(1) }), // Headache 3
      evt({ code: SYMPTOMS[1].snomed, value: qty('6'), at: iso(2) }), // Fatigue 6
      evt({ code: SYMPTOMS[2].snomed, value: qty('8'), at: iso(30) }), // Nausea, too old
    ]
    const out = recentSymptoms(events, NOW, 14)
    expect(out.map((s) => s.label)).toEqual(['Fatigue', 'Headache'])
    expect(out[0].severity).toBe(6)
  })

  it('keeps the worst reading of a repeated symptom', () => {
    const events = [
      evt({ code: SYMPTOMS[0].snomed, value: qty('2'), at: iso(1) }),
      evt({ code: SYMPTOMS[0].snomed, value: qty('7'), at: iso(3) }),
    ]
    expect(recentSymptoms(events, NOW, 14)).toEqual([{ label: 'Headache', severity: 7 }])
  })
})

describe('recentActivity', () => {
  it('returns the newest entries first, capped at the limit', () => {
    const events = [
      evt({ code: HR, value: qty('60'), at: iso(5) }),
      evt({ code: HR, value: qty('61'), at: iso(1) }),
      evt({ code: HR, value: qty('62'), at: iso(3) }),
    ]
    const out = recentActivity(events, 2)
    expect(out).toHaveLength(2)
    expect(out[0].atIso).toBe(iso(1))
    expect(out[1].atIso).toBe(iso(3))
  })

  it('ignores undated events', () => {
    expect(recentActivity([evt({ code: HR, value: qty('60'), at: null })])).toHaveLength(0)
  })
})

describe('medicationGlance', () => {
  it('counts distinct medications, newest names first', () => {
    const med = (display: string, at: string) =>
      evt({
        kind: 'medication_statement',
        code: { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: display, display },
        at,
      })
    const { count, names } = medicationGlance(
      [med('Lisinopril', iso(5)), med('Montelukast', iso(1)), med('Lisinopril', iso(9))],
      4,
    )
    expect(count).toBe(2)
    expect(names).toEqual(['Montelukast', 'Lisinopril'])
  })
})
