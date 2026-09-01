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

/** Fixed "today" for the recency-window split: mid-2025, so the 2024-dated
 * fixtures above sit inside a 12-month window and the tests don't rot as the
 * real clock moves. */
const NOW = Date.parse('2025-01-15T00:00:00+00:00')

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
    expect(problems[0].date).toBe('2020-03-01T00:00:00+00:00')
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

describe('buildSummary: medications', () => {
  const LISINOPRIL: Code = { system: RXNORM, code: '29046', display: 'Lisinopril 10 MG Oral Tablet' }
  const AMOXICILLIN: Code = { system: RXNORM, code: '723', display: 'amoxicillin' }
  const ZOLPIDEM: Code = { system: RXNORM, code: '39786', display: 'Zolpidem' }

  it('orders by name, not by date, and ignores case', () => {
    const events = [
      ev({ kind: 'medication_statement', code: ZOLPIDEM, effective_at: '2024-06-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', code: LISINOPRIL, effective_at: '2024-05-01T00:00:00+00:00' }),
      // lowercase display: a case-sensitive sort would drop it below Zolpidem
      ev({ kind: 'medication_statement', code: AMOXICILLIN, effective_at: '2024-01-01T00:00:00+00:00' }),
    ]
    const { medications } = buildSummary(events, { now: NOW })
    expect(medications.map((m) => m.label)).toEqual([
      'amoxicillin',
      'Lisinopril 10 MG Oral Tablet',
      'Zolpidem',
    ])
  })

  it('sorts an undated medication by name alongside the dated ones', () => {
    const events = [
      ev({ kind: 'medication_statement', code: ZOLPIDEM, effective_at: '2024-06-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', code: AMOXICILLIN, effective_at: null }),
    ]
    const { medications } = buildSummary(events, { now: NOW })
    expect(medications.map((m) => m.label)).toEqual(['amoxicillin', 'Zolpidem'])
    expect(medications[0].date).toBeNull()
  })

  it('shows the dose from the most recent statement that recorded one, even when a later one did not', () => {
    // The refill (May) carries no doseQuantity; the dose is on the January
    // statement. Reading only the label source (the latest) loses it.
    const events = [
      ev({ kind: 'medication_statement', code: LISINOPRIL, value: q('10', 'mg'), effective_at: '2024-01-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', code: LISINOPRIL, effective_at: '2024-05-01T00:00:00+00:00' }),
    ]
    const { medications } = buildSummary(events, { now: NOW })
    expect(medications).toHaveLength(1)
    expect(medications[0].detail).toBe('10 mg')
    // and the row still dates from the latest mention
    expect(medications[0].date).toBe('2024-05-01T00:00:00+00:00')
  })

  it('prefers the newer of two recorded doses', () => {
    const events = [
      ev({ kind: 'medication_statement', code: LISINOPRIL, value: q('10', 'mg'), effective_at: '2024-01-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', code: LISINOPRIL, value: q('20', 'mg'), effective_at: '2024-05-01T00:00:00+00:00' }),
    ]
    expect(buildSummary(events, { now: NOW }).medications[0].detail).toBe('20 mg')
  })

  it('never re-derives a dose from a strength baked into the drug name', () => {
    // "400 MG/5 ML" is a concentration; any name-parsed "dose" would misstate
    // it. With no doseQuantity in the source there is no dose to show.
    const suspension: Code = { system: RXNORM, code: '308182', display: 'Amoxicillin 400 MG/5 ML Oral Suspension' }
    const events = [ev({ kind: 'medication_statement', code: suspension, effective_at: '2024-05-01T00:00:00+00:00' })]
    const { medications } = buildSummary(events, { now: NOW })
    expect(medications[0].detail).toBe('')
    expect(medications[0].label).toBe('Amoxicillin 400 MG/5 ML Oral Suspension')
  })

  it('leaves a free-text quick-log medication its own text and no derived dose', () => {
    const events = [
      ev({ kind: 'medication_statement', value: { text: 'Ibuprofen 400 mg' }, effective_at: '2024-05-01T00:00:00+00:00' }),
    ]
    const { medications } = buildSummary(events, { now: NOW })
    expect(medications[0].label).toBe('Ibuprofen 400 mg')
    expect(medications[0].detail).toBe('')
  })

  it('is not windowed — a medication from years ago still leads the list', () => {
    const events = [ev({ kind: 'medication_statement', code: ZOLPIDEM, effective_at: '2015-01-01T00:00:00+00:00' })]
    expect(buildSummary(events, { now: NOW }).medications).toHaveLength(1)
  })
})

describe('buildSummary: the recency window', () => {
  const CVX_TETANUS: Code = { system: 'http://hl7.org/fhir/sid/cvx', code: '115', display: 'Tdap' }

  it('splits immunizations at the window and keeps every older one', () => {
    const events = [
      ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-11-01T00:00:00+00:00' }),
      ev({ kind: 'immunization', code: CVX_TETANUS, effective_at: '2016-05-01T00:00:00+00:00' }),
    ]
    const { immunizations } = buildSummary(events, { now: NOW })
    expect(immunizations.recent.map((r) => r.label)).toEqual(['Influenza'])
    expect(immunizations.older.map((r) => r.label)).toEqual(['Tdap'])
  })

  it('demotes an undated row to older — recency it cannot prove is not claimed', () => {
    const events = [ev({ kind: 'immunization', code: CVX_TETANUS, effective_at: null })]
    const { immunizations } = buildSummary(events, { now: NOW })
    expect(immunizations.recent).toEqual([])
    expect(immunizations.older).toHaveLength(1)
  })

  it('counts the window in calendar months, so exactly-a-year-ago is still inside it', () => {
    const events = [
      ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-01-15T00:00:00+00:00' }),
    ]
    const { immunizations } = buildSummary(events, { now: Date.parse('2025-01-15T00:00:00+00:00') })
    expect(immunizations.recent).toHaveLength(1)
  })

  it('demotes a stale vital rather than presenting it as the latest', () => {
    const events = [
      ev({ code: HR, value: q('72', '/min'), effective_at: '2019-05-01T09:00:00+00:00' }),
      ev({ code: BP_SYSTOLIC, value: q('120', 'mm[Hg]'), effective_at: '2024-12-01T09:00:00+00:00' }),
      ev({ code: BP_DIASTOLIC, value: q('80', 'mm[Hg]'), effective_at: '2024-12-01T09:00:00+00:00' }),
    ]
    const { latestVitals } = buildSummary(events, { now: NOW })
    expect(latestVitals.recent.map((r) => r.label)).toEqual(['Blood pressure'])
    expect(latestVitals.older.map((r) => r.label)).toEqual(['Heart rate'])
    // the stale reading is still carried, not dropped
    expect(latestVitals.older[0].detail).toBe('72 /min')
  })

  it('applies the result limit to each bucket, so older results are not truncated by the recent ones', () => {
    const events = [
      ev({ code: CHOL, value: q('190', 'mg/dL'), effective_at: '2024-12-01T00:00:00+00:00' }),
      ev({ code: { system: LOINC, code: '4548-4', display: 'HbA1c' }, value: q('5.4', '%'), effective_at: '2024-11-01T00:00:00+00:00' }),
      ev({ code: { system: LOINC, code: '2951-2', display: 'Sodium' }, value: q('140', 'mmol/L'), effective_at: '2018-02-01T00:00:00+00:00' }),
      ev({ code: { system: LOINC, code: '2823-3', display: 'Potassium' }, value: q('4.1', 'mmol/L'), effective_at: '2017-02-01T00:00:00+00:00' }),
    ]
    const { recentResults } = buildSummary(events, { resultLimit: 1, now: NOW })
    expect(recentResults.recent.map((r) => r.label)).toEqual(['Cholesterol'])
    expect(recentResults.older.map((r) => r.label)).toEqual(['Sodium'])
  })

  it('reports the window it used', () => {
    expect(buildSummary([], { now: NOW }).windowMonths).toBe(12)
    expect(buildSummary([], { now: NOW, windowMonths: 6 }).windowMonths).toBe(6)
  })

  it('honours a caller-supplied window', () => {
    const events = [ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-09-01T00:00:00+00:00' })]
    expect(buildSummary(events, { now: NOW, windowMonths: 3 }).immunizations.older).toHaveLength(1)
    expect(buildSummary(events, { now: NOW, windowMonths: 24 }).immunizations.recent).toHaveLength(1)
  })
})

describe('buildSummary: focusId (the row\'s "see on timeline" target)', () => {
  it('points at the event whose date the row shows — earliest onset for a problem', () => {
    const events = [
      ev({ kind: 'condition', code: HTN, effective_at: '2020-03-01T00:00:00+00:00', id: 'onset' }),
      ev({ kind: 'condition', code: HTN, effective_at: '2022-06-01T00:00:00+00:00', id: 'later' }),
    ]
    const { problems } = buildSummary(events, { now: NOW })
    expect(problems[0].date).toBe('2020-03-01T00:00:00+00:00')
    expect(problems[0].focusId).toBe('onset')
  })

  it('points at the latest mention for a medication', () => {
    const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
    const events = [
      ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00', id: 'first' }),
      ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-05-01T00:00:00+00:00', id: 'refill' }),
    ]
    expect(buildSummary(events, { now: NOW }).medications[0].focusId).toBe('refill')
  })

  it('falls back to the labelling event when the whole fold is undated', () => {
    const events = [ev({ kind: 'condition', code: HTN, effective_at: null, id: 'undated' })]
    const { problems } = buildSummary(events, { now: NOW })
    expect(problems[0].date).toBeNull()
    expect(problems[0].focusId).toBe('undated')
  })

  it('points a vitals row at the reading it displays', () => {
    const events = [
      ev({ code: HR, value: q('66', '/min'), effective_at: '2024-02-01T09:00:00+00:00', id: 'old' }),
      ev({ code: HR, value: q('72', '/min'), effective_at: '2024-12-01T09:00:00+00:00', id: 'latest' }),
    ]
    const { latestVitals } = buildSummary(events, { now: NOW })
    expect(latestVitals.recent[0].detail).toBe('72 /min')
    expect(latestVitals.recent[0].focusId).toBe('latest')
  })

  it('points a blood-pressure row at the systolic reading it paired', () => {
    const events = [
      ev({ code: BP_SYSTOLIC, value: q('120', 'mm[Hg]'), effective_at: '2024-12-01T09:00:00+00:00', id: 'sys' }),
      ev({ code: BP_DIASTOLIC, value: q('80', 'mm[Hg]'), effective_at: '2024-12-01T09:00:00+00:00', id: 'dia' }),
    ]
    const { latestVitals } = buildSummary(events, { now: NOW })
    expect(latestVitals.recent[0].focusId).toBe('sys')
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
    const { immunizations } = buildSummary(events, { now: NOW })
    expect(immunizations.recent).toHaveLength(1)
    expect(immunizations.recent[0].detail).toBe('2 doses')
    expect(immunizations.recent[0].date).toBe('2024-10-01T00:00:00+00:00')
  })

  it('shows no dose count for a single immunization', () => {
    const events = [ev({ kind: 'immunization', code: CVX_FLU, effective_at: '2024-10-01T00:00:00+00:00' })]
    expect(buildSummary(events, { now: NOW }).immunizations.recent[0].detail).toBe('')
  })
})

describe('buildSummary: latest vitals', () => {
  it('produces one row per vital code, each the most-recent reading, pairing BP', () => {
    const events = [
      ev({ code: BP_SYSTOLIC, value: q('130', 'mm[Hg]'), effective_at: '2024-01-01T09:00:00+00:00' }),
      ev({ code: BP_DIASTOLIC, value: q('85', 'mm[Hg]'), effective_at: '2024-01-01T09:00:00+00:00' }),
      ev({ code: BP_SYSTOLIC, value: q('120', 'mm[Hg]'), effective_at: '2024-05-01T09:00:00+00:00' }),
      ev({ code: BP_DIASTOLIC, value: q('80', 'mm[Hg]'), effective_at: '2024-05-01T09:00:00+00:00' }),
      ev({ code: HR, value: q('72', '/min'), effective_at: '2024-05-01T09:00:00+00:00' }),
      ev({ code: HR, value: q('66', '/min'), effective_at: '2024-02-01T09:00:00+00:00' }),
    ]
    const { latestVitals } = buildSummary(events, { now: NOW })
    const bp = latestVitals.recent.find((r) => r.label === 'Blood pressure')!
    const hr = latestVitals.recent.find((r) => r.label === 'Heart rate')!
    expect(bp.detail).toBe('120/80 mm[Hg]')
    expect(bp.count).toBe(4)
    expect(hr.detail).toBe('72 /min')
    expect(hr.count).toBe(2)
    // BP row comes before HR (VITALS declaration order)
    expect(latestVitals.recent.map((r) => r.label)).toEqual(['Blood pressure', 'Heart rate'])
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
    const { recentResults } = buildSummary(events, { resultLimit: 2, now: NOW })
    expect(recentResults.recent).toHaveLength(2)
    expect(recentResults.recent.map((r) => r.label)).toEqual(['HbA1c', 'Sodium'])
    expect(recentResults.recent[0].detail).toBe('5.4 %')
  })
})

describe('buildSummary: concept status (med/problem lifecycle)', () => {
  const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
  const medKey = `medication_statement|${RXNORM}|723`

  it('defaults every row to active when no status curation is supplied (read-only render)', () => {
    const events = [ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' })]
    expect(buildSummary(events).medications[0].status).toBe('active')
  })

  it('annotates a row from the status map, keyed on keyFor (${kind}|${system}|${code})', () => {
    const events = [ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' })]
    const { medications } = buildSummary(events, { status: new Map([[medKey, 'inactive']]) })
    expect(medications[0].key).toBe(medKey)
    expect(medications[0].status).toBe('inactive')
  })

  it('splits meds into current/past and problems into active/resolved by the status field', () => {
    const HTN2: Code = { system: SNOMED, code: '38341003', display: 'Hypertension' }
    const RESOLVED: Code = { system: SNOMED, code: '195967001', display: 'Asthma' }
    const events = [
      ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: HTN2, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: RESOLVED, effective_at: '2019-01-01T00:00:00+00:00' }),
    ]
    const status = new Map<string, 'active' | 'inactive'>([
      [medKey, 'inactive'],
      [`condition|${SNOMED}|195967001`, 'inactive'],
    ])
    const { medications, problems } = buildSummary(events, { status })
    // The component splits on this field: current = active, past = inactive.
    expect(medications.filter((r) => r.status === 'active')).toHaveLength(0)
    expect(medications.filter((r) => r.status === 'inactive').map((r) => r.label)).toEqual(['Amoxicillin'])
    expect(problems.filter((r) => r.status === 'active').map((r) => r.label)).toEqual(['Hypertension'])
    expect(problems.filter((r) => r.status === 'inactive').map((r) => r.label)).toEqual(['Asthma'])
  })
})

describe('buildSummary: name override', () => {
  const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
  const medKey = `medication_statement|${RXNORM}|723`

  it('override beats the event\'s own display, and the code line stays demoted beneath it', () => {
    const events = [ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' })]
    const { medications } = buildSummary(events, { names: new Map([[medKey, 'Amox (my name)']]) })
    expect(medications[0].label).toBe('Amox (my name)')
    expect(medications[0].nameResolved).toBe(true)
    // Coding preserved so #86's demoted code line still renders under the override.
    expect(medications[0].coding).toEqual({ system: 'RxNorm', code: '723' })
  })

  it('names an otherwise-unnamed coded concept; the code line stays visible', () => {
    const icd10 = 'http://hl7.org/fhir/sid/icd-10-cm'
    const key = `condition|${icd10}|E11.9`
    const events = [ev({ kind: 'condition', code: { system: icd10, code: 'E11.9' }, effective_at: '2021-01-01T00:00:00+00:00' })]
    const { problems } = buildSummary(events, { names: new Map([[key, 'My diabetes']]) })
    expect(problems[0].label).toBe('My diabetes')
    expect(problems[0].nameResolved).toBe(true)
    expect(problems[0].coding).toEqual({ system: 'ICD-10-CM', code: 'E11.9' })
  })

  it('outranks the vault name index and the dictionary (top of the name chain)', () => {
    const icd10 = 'http://hl7.org/fhir/sid/icd-10-cm'
    const key = `condition|${icd10}|E11.9`
    const events = [
      // vault index would resolve this to "Type 2 diabetes mellitus"...
      ev({ kind: 'condition', code: { system: icd10, code: 'E11.9', display: 'Type 2 diabetes mellitus' }, effective_at: '2019-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { system: icd10, code: 'E11.9' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const dictionary = new Map([[`${icd10}|E11.9`, 'Dictionary name']])
    const { problems } = buildSummary(events, { names: new Map([[key, 'Override wins']]), dictionary })
    expect(problems[0].label).toBe('Override wins')
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
    expect(summary.immunizations).toEqual({ recent: [], older: [] })
    expect(summary.latestVitals).toEqual({ recent: [], older: [] })
    expect(summary.recentResults).toEqual({ recent: [], older: [] })
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

describe('buildSummary: regimen curation', () => {
  const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
  const medKey = `medication_statement|${RXNORM}|723`
  const amox = () => ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' })

  it('leaves the row without a regimen when none is curated', () => {
    expect(buildSummary([amox()]).medications[0].regimen).toBeUndefined()
  })

  it('carries the curated regimen on the row, keyed on the concept', () => {
    const regimen = new Map([[medKey, { schedule: 'Twice daily', route: 'mouth' as const, as_needed: true }]])
    const { medications } = buildSummary([amox()], { regimen })
    expect(medications[0].regimen).toEqual({ schedule: 'Twice daily', route: 'mouth', as_needed: true })
  })

  it('a curated dose outranks the recorded dose quantity', () => {
    const dosed = ev({
      kind: 'medication_statement',
      code: AMOX,
      value: q('500', 'mg'),
      effective_at: '2024-01-01T00:00:00+00:00',
    })
    expect(buildSummary([dosed]).medications[0].detail).toBe('500 mg')
    const regimen = new Map([[medKey, { dose: '2 tablets' }]])
    expect(buildSummary([dosed], { regimen }).medications[0].detail).toBe('2 tablets')
  })

  it('falls back to the recorded quantity when the regimen carries no dose', () => {
    const dosed = ev({
      kind: 'medication_statement',
      code: AMOX,
      value: q('500', 'mg'),
      effective_at: '2024-01-01T00:00:00+00:00',
    })
    const regimen = new Map([[medKey, { schedule: 'Twice daily' }]])
    expect(buildSummary([dosed], { regimen }).medications[0].detail).toBe('500 mg')
  })

  it('is inert for a concept with no events — no phantom row appears', () => {
    const regimen = new Map([['medication_statement|rxnorm|999999', { dose: '10 mg' }]])
    const { medications, problems } = buildSummary([amox()], { regimen })
    expect(medications).toHaveLength(1)
    expect(medications[0].key).toBe(medKey)
    expect(medications[0].regimen).toBeUndefined()
    expect(problems).toHaveLength(0)
  })
})
