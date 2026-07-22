import { describe, expect, it } from 'vitest'
import { buildSummary } from '../summary'
import type { StoredEvent } from '../events'
import type { EventKind, EventValue } from '../drafts'
import { SNOMED, LOINC, RXNORM, BP_SYSTOLIC, BP_DIASTOLIC, CYCLE_START, CYCLE_END, type Code } from '../codes'

let nextId = 0
function ev(partial: {
  kind?: EventKind
  code?: Code | null
  value?: EventValue | null
  effective_at?: string | null
  id?: string
}): StoredEvent {
  return {
    event: {
      id: partial.id ?? `evt-${nextId++}`,
      kind: partial.kind ?? 'observation',
      code: partial.code ?? null,
      value: partial.value ?? null,
      effective_at: partial.effective_at ?? null,
      provenance: { source: 'import', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

const HTN: Code = { system: SNOMED, code: '38341003', display: 'Hypertension' }
const HR: Code = { system: LOINC, code: '8867-4', display: 'Heart rate' }
const CHOL: Code = { system: LOINC, code: '2093-3', display: 'Cholesterol' }
const CVX_FLU: Code = { system: 'http://hl7.org/fhir/sid/cvx', code: '140', display: 'Influenza' }
const CASHEW: Code = { system: SNOMED, code: '227493005', display: 'Cashew nuts' }

function q(value: string, unitCode?: string): EventValue {
  return { quantity: { value, unit: unitCode ? { system: 'http://unitsofmeasure.org', code: unitCode } : null } }
}

describe('buildSummary: problems', () => {
  it('folds the same condition from two documents into one row with earliest onset and count 2', () => {
    const events = [
      ev({ kind: 'condition', code: HTN, effective_at: '2020-03-01T00:00:00+00:00', id: 'a' }),
      ev({ kind: 'condition', code: HTN, effective_at: '2022-06-01T00:00:00+00:00', id: 'b' }),
    ]
    const { problems } = buildSummary(events)
    expect(problems).toHaveLength(1)
    expect(problems[0].label).toBe('Hypertension')
    expect(problems[0].count).toBe(2)
    expect(problems[0].date).toBe('2020-03-01T00:00:00+00:00') // earliest onset
    expect(problems[0].eventIds).toEqual(['a', 'b'])
    // resolved via the event's own display: name-first, coding demoted as data
    expect(problems[0].nameResolved).toBe(true)
    expect(problems[0].coding).toEqual({ system: 'SNOMED', code: '38341003' })
  })

  it('includes an undated condition and sorts it last', () => {
    const events = [
      ev({ kind: 'condition', code: { system: SNOMED, code: '73211009', display: 'Diabetes' }, effective_at: null }),
      ev({ kind: 'condition', code: HTN, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const { problems } = buildSummary(events)
    expect(problems.map((p) => p.label)).toEqual(['Hypertension', 'Diabetes'])
    expect(problems[1].date).toBeNull()
  })

  it('falls back to "Unnamed entry" — never the raw code — when the source carries no display and nothing else names it', () => {
    const events = [
      ev({ kind: 'condition', code: { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const { problems } = buildSummary(events)
    expect(problems[0].label).toBe('Unnamed entry')
    expect(problems[0].nameResolved).toBe(false)
    // the code is still carried as data for the view to show alongside the placeholder
    expect(problems[0].coding).toEqual({ system: 'ICD-10-CM', code: 'E11.9' })
  })

  it('resolves a display-less condition from the same code named on a different event', () => {
    const icd10 = 'http://hl7.org/fhir/sid/icd-10-cm'
    const events = [
      ev({ kind: 'condition', code: { system: icd10, code: 'E11.9', display: 'Type 2 diabetes mellitus' }, effective_at: '2019-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { system: icd10, code: 'E11.9' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const { problems } = buildSummary(events)
    expect(problems).toHaveLength(1)
    expect(problems[0].label).toBe('Type 2 diabetes mellitus')
    expect(problems[0].nameResolved).toBe(true)
    expect(problems[0].coding).toEqual({ system: 'ICD-10-CM', code: 'E11.9' })
  })

  it('resolves a display-less condition from the offline dictionary when the vault names it nowhere', () => {
    const icd10 = 'http://hl7.org/fhir/sid/icd-10-cm'
    const events = [
      ev({ kind: 'condition', code: { system: icd10, code: 'E11.9' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const dictionary = new Map([[`${icd10}|E11.9`, 'Type 2 diabetes mellitus']])
    const { problems } = buildSummary(events, { dictionary })
    expect(problems[0].label).toBe('Type 2 diabetes mellitus')
    expect(problems[0].nameResolved).toBe(true)
    expect(problems[0].coding).toEqual({ system: 'ICD-10-CM', code: 'E11.9' })
  })

  it('picks the most frequent display, tie-broken shortest-then-lexicographic, under conflicting names', () => {
    const loincBmi = { system: LOINC, code: '39156-5' }
    const events = [
      ev({ kind: 'condition', code: { ...loincBmi, display: 'Body mass index (BMI) [Ratio]' }, effective_at: '2019-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { ...loincBmi, display: 'BMI' }, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { ...loincBmi, display: 'BMI' }, effective_at: '2021-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: loincBmi, effective_at: '2022-01-01T00:00:00+00:00' }),
    ]
    const { problems } = buildSummary(events)
    expect(problems).toHaveLength(1)
    expect(problems[0].label).toBe('BMI')
  })
})

describe('buildSummary: rows with no coding', () => {
  it('carries a null coding and nameResolved true for a free-text medication', () => {
    const events = [
      ev({ kind: 'medication_statement', code: null, value: { text: 'Ibuprofen — 400 mg' }, effective_at: '2024-01-01T00:00:00+00:00' }),
    ]
    const { medications } = buildSummary(events)
    expect(medications[0].label).toBe('Ibuprofen — 400 mg')
    expect(medications[0].coding).toBeNull()
    expect(medications[0].nameResolved).toBe(true)
  })

  it('falls back to the humanized kind word, still nameResolved true, when there is neither coding nor text', () => {
    const events = [ev({ kind: 'medication_statement', code: null, value: null, effective_at: '2024-01-01T00:00:00+00:00' })]
    const { medications } = buildSummary(events)
    expect(medications[0].label).toBe('medication statement')
    expect(medications[0].coding).toBeNull()
    expect(medications[0].nameResolved).toBe(true)
  })
})

describe('buildSummary: allergies', () => {
  it('reads the substance from value.coded, not the (null) event code, and sorts by name', () => {
    const events = [
      ev({ kind: 'allergy_intolerance', code: null, value: { coded: CASHEW }, effective_at: '2019-01-01T00:00:00+00:00' }),
      ev({ kind: 'allergy_intolerance', code: null, value: { coded: { system: RXNORM, code: '7980', display: 'Penicillin' } }, effective_at: '2020-01-01T00:00:00+00:00' }),
    ]
    const { allergies } = buildSummary(events)
    expect(allergies.map((a) => a.label)).toEqual(['Cashew nuts', 'Penicillin'])
    expect(allergies[0].key).toBe(`allergy_intolerance|${SNOMED}|227493005`)
  })
})

describe('buildSummary: immunizations', () => {
  it('reports the dose count when more than one and the latest dose date', () => {
    const events = [
      ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2023-10-01T00:00:00+00:00' }),
      ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-10-01T00:00:00+00:00' }),
    ]
    const { immunizations } = buildSummary(events)
    expect(immunizations).toHaveLength(1)
    expect(immunizations[0].detail).toBe('2 doses')
    expect(immunizations[0].date).toBe('2024-10-01T00:00:00+00:00') // latest
  })

  it('shows no dose count for a single immunization', () => {
    const events = [ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-10-01T00:00:00+00:00' })]
    expect(buildSummary(events).immunizations[0].detail).toBe('')
  })
})

describe('buildSummary: latest vitals', () => {
  it('produces one row per vital code, each the most-recent reading, pairing BP', () => {
    const events = [
      // older BP pair
      ev({ code: BP_SYSTOLIC, value: q('130', 'mm[Hg]'), effective_at: '2024-01-01T09:00:00+00:00' }),
      ev({ code: BP_DIASTOLIC, value: q('85', 'mm[Hg]'), effective_at: '2024-01-01T09:00:00+00:00' }),
      // newer BP pair
      ev({ code: BP_SYSTOLIC, value: q('120', 'mm[Hg]'), effective_at: '2024-05-01T09:00:00+00:00' }),
      ev({ code: BP_DIASTOLIC, value: q('80', 'mm[Hg]'), effective_at: '2024-05-01T09:00:00+00:00' }),
      // heart rate readings
      ev({ code: HR, value: q('72', '/min'), effective_at: '2024-05-01T09:00:00+00:00' }),
      ev({ code: HR, value: q('66', '/min'), effective_at: '2024-02-01T09:00:00+00:00' }),
    ]
    const { latestVitals } = buildSummary(events)
    const bp = latestVitals.find((r) => r.label === 'Blood pressure')!
    const hr = latestVitals.find((r) => r.label === 'Heart rate')!
    expect(bp.detail).toBe('120/80 mm[Hg]') // most-recent pair
    expect(bp.count).toBe(4)
    expect(hr.detail).toBe('72 /min') // most-recent reading
    expect(hr.count).toBe(2)
    // BP row comes before HR (VITALS declaration order)
    expect(latestVitals.map((r) => r.label)).toEqual(['Blood pressure', 'Heart rate'])
    // vitals always resolve from the hardcoded VITALS labels; the paired BP
    // row has no single coding of its own, but a plain vital carries its LOINC.
    expect(bp.coding).toBeNull()
    expect(bp.nameResolved).toBe(true)
    expect(hr.coding).toEqual({ system: 'LOINC', code: '8867-4' })
    expect(hr.nameResolved).toBe(true)
  })
})

describe('buildSummary: recent results', () => {
  it('selects only coded non-vital observations, newest first, respecting the limit', () => {
    const events = [
      ev({ code: CHOL, value: q('190', 'mg/dL'), effective_at: '2024-01-01T00:00:00+00:00' }),
      ev({ code: { system: LOINC, code: '4548-4', display: 'HbA1c' }, value: q('5.4', '%'), effective_at: '2024-03-01T00:00:00+00:00' }),
      ev({ code: { system: LOINC, code: '2951-2', display: 'Sodium' }, value: q('140', 'mmol/L'), effective_at: '2024-02-01T00:00:00+00:00' }),
      // excluded: a vital (categorized 'vital')
      ev({ code: HR, value: q('70', '/min'), effective_at: '2024-04-01T00:00:00+00:00' }),
      // excluded: a coded symptom (SNOMED -> 'symptom')
      ev({ code: { system: SNOMED, code: '25064002', display: 'Headache' }, value: q('4'), effective_at: '2024-04-02T00:00:00+00:00' }),
    ]
    const { recentResults } = buildSummary(events, { resultLimit: 2 })
    expect(recentResults).toHaveLength(2)
    expect(recentResults.map((r) => r.label)).toEqual(['HbA1c', 'Sodium']) // newest first
    expect(recentResults[0].detail).toBe('5.4 %')
  })
})

describe('buildSummary: cycle section', () => {
  it('omits the cycle field entirely when no cycle events are present', () => {
    const events = [ev({ kind: 'condition', code: HTN, effective_at: '2021-01-01T00:00:00+00:00' })]
    expect(buildSummary(events).cycle).toBeUndefined()
  })

  it('includes the cycle summary exactly when cycle events are present', () => {
    const events = [
      ev({ code: CYCLE_START, effective_at: '2026-01-01T09:00:00' }),
      ev({ code: CYCLE_END, effective_at: '2026-01-05T09:00:00' }),
      ev({ code: CYCLE_START, effective_at: '2026-01-29T09:00:00' }),
    ]
    const { cycle } = buildSummary(events)
    expect(cycle).toBeDefined()
    expect(cycle!.cycleCount).toBe(2)
    expect(cycle!.medianLength).toBe(28)
    expect(cycle!.typicalPeriodDays).toBe(5)
  })

  it('degrades to the last-start-only shape with a single recorded start', () => {
    const { cycle } = buildSummary([ev({ code: CYCLE_START, effective_at: '2026-07-01T09:00:00' })])
    expect(cycle).toBeDefined()
    expect(cycle!.cycleCount).toBe(1)
    expect(cycle!.medianLength).toBeNull()
    expect(cycle!.lastStartIso?.slice(0, 10)).toBe('2026-07-01')
  })

  it('drops a hidden cycle event before deriving — hides win here too', () => {
    const { cycle } = buildSummary(
      [ev({ code: CYCLE_START, effective_at: '2026-07-01T09:00:00', id: 'drop' })],
      { hiddenIds: new Set(['drop']) },
    )
    expect(cycle).toBeUndefined()
  })
})

describe('buildSummary: empty and hidden', () => {
  it('returns empty sections when nothing matches (the view renders the allergy sentinel itself)', () => {
    const summary = buildSummary([])
    expect(summary.problems).toEqual([])
    expect(summary.medications).toEqual([])
    expect(summary.allergies).toEqual([])
    expect(summary.immunizations).toEqual([])
    expect(summary.latestVitals).toEqual([])
    expect(summary.recentResults).toEqual([])
  })

  it('subtracts hidden event ids before grouping', () => {
    const events = [
      ev({ kind: 'condition', code: HTN, effective_at: '2021-01-01T00:00:00+00:00', id: 'keep' }),
      ev({ kind: 'condition', code: { system: SNOMED, code: '73211009', display: 'Diabetes' }, effective_at: '2021-01-01T00:00:00+00:00', id: 'drop' }),
    ]
    const { problems } = buildSummary(events, { hiddenIds: new Set(['drop']) })
    expect(problems.map((p) => p.label)).toEqual(['Hypertension'])
  })
})
