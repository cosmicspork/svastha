import { describe, expect, it } from 'vitest'
import { buildSummary, shelveMedications, splitProblems } from '../summary'
import type { StoredEvent } from '../events'
import type { EventKind, EventValue } from '../drafts'
import { lwwMerge, priorityMapFrom, type ConceptPriority, type ConceptStatus, type CurationRecord, type Regimen } from '../curation'
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

describe('shelveMedications', () => {
  const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
  const LISI: Code = { system: RXNORM, code: '29046', display: 'Lisinopril' }
  const METF: Code = { system: RXNORM, code: '6809', display: 'Metformin' }
  const ZOLP: Code = { system: RXNORM, code: '39786', display: 'Zolpidem' }

  const key = (code: Code) => `medication_statement|${code.system}|${code.code}`
  const med = (code: Code) =>
    ev({ kind: 'medication_statement', code, effective_at: '2024-01-01T00:00:00+00:00' })

  /** Build the medication rows through the real fold, then shelve them — the
   * page's own pipeline, so the shelves are tested against rows `buildSummary`
   * actually produces (byLabel-sorted, status/regimen applied). */
  function shelve(
    codes: Code[],
    opts: { regimen?: Map<string, Regimen>; status?: Map<string, ConceptStatus> } = {},
  ) {
    return shelveMedications(buildSummary(codes.map(med), { now: NOW, ...opts }).medications)
  }

  it('files each current med on its curated route, in REGIMEN_ROUTES order', () => {
    // Seeded in an order that is neither route order nor name order, so a shelf
    // list that merely echoed the input would fail.
    const regimen = new Map<string, Regimen>([
      [key(AMOX), { route: 'skin' }],
      [key(LISI), { route: 'mouth' }],
      [key(METF), { route: 'injection' }],
      [key(ZOLP), { route: 'nose' }],
    ])
    const { shelves, unrouted, past } = shelve([METF, ZOLP, AMOX, LISI], { regimen })
    expect(shelves.map((s) => s.route)).toEqual(['mouth', 'nose', 'skin', 'injection'])
    expect(shelves.map((s) => s.rows.map((r) => r.label))).toEqual([
      ['Lisinopril'],
      ['Zolpidem'],
      ['Amoxicillin'],
      ['Metformin'],
    ])
    expect(unrouted).toEqual([])
    expect(past).toEqual([])
  })

  it('omits shelves nothing is filed on', () => {
    const regimen = new Map<string, Regimen>([[key(LISI), { route: 'eyes' }]])
    const { shelves } = shelve([LISI], { regimen })
    expect(shelves).toHaveLength(1)
    expect(shelves[0].route).toBe('eyes')
  })

  it('puts route-less current meds in `unrouted`, not on an "other" shelf', () => {
    // 'other' is a route someone chose, not a bin for the unfiled: a med nobody
    // has routed must stay visibly unrouted.
    const regimen = new Map<string, Regimen>([[key(AMOX), { schedule: 'Twice daily' }]])
    const { unrouted, shelves } = shelve([AMOX, LISI], { regimen })
    expect(unrouted.map((r) => r.label)).toEqual(['Amoxicillin', 'Lisinopril'])
    expect(shelves).toEqual([])
  })

  it('sends inactive meds to `past`, off their shelf', () => {
    const regimen = new Map<string, Regimen>([
      [key(LISI), { route: 'mouth' }],
      [key(METF), { route: 'mouth' }],
    ])
    const status = new Map<string, ConceptStatus>([[key(METF), 'inactive']])
    const { shelves, past } = shelve([LISI, METF], { regimen, status })
    expect(past.map((r) => r.label)).toEqual(['Metformin'])
    expect(shelves).toEqual([{ route: 'mouth', rows: [expect.objectContaining({ label: 'Lisinopril' })] }])
  })

  it('keeps an as-needed med current — PRN is a chip, not a status', () => {
    const regimen = new Map<string, Regimen>([[key(ZOLP), { route: 'mouth', as_needed: true }]])
    const { shelves, past, unrouted } = shelve([ZOLP], { regimen })
    expect(past).toEqual([])
    expect(unrouted).toEqual([])
    expect(shelves[0].rows.map((r) => r.label)).toEqual(['Zolpidem'])
  })

  it('files an as-needed med as past once it is marked inactive', () => {
    // The adversarial pair to the case above: `as_needed` must not out-vote an
    // explicit inactive status either.
    const regimen = new Map<string, Regimen>([[key(ZOLP), { route: 'mouth', as_needed: true }]])
    const status = new Map<string, ConceptStatus>([[key(ZOLP), 'inactive']])
    const { shelves, past } = shelve([ZOLP], { regimen, status })
    expect(shelves).toEqual([])
    expect(past.map((r) => r.label)).toEqual(['Zolpidem'])
  })

  it('preserves the incoming order within a shelf', () => {
    const regimen = new Map<string, Regimen>([
      [key(AMOX), { route: 'mouth' }],
      [key(LISI), { route: 'mouth' }],
      [key(METF), { route: 'mouth' }],
    ])
    const { shelves } = shelve([METF, AMOX, LISI], { regimen })
    // buildSummary sorts byLabel, so alphabetical is what "incoming" means here.
    expect(shelves[0].rows.map((r) => r.label)).toEqual(['Amoxicillin', 'Lisinopril', 'Metformin'])
    // And a shelf built from a hand-ordered array is not re-sorted.
    const rows = shelves[0].rows
    const reversed = shelveMedications([...rows].reverse())
    expect(reversed.shelves[0].rows.map((r) => r.label)).toEqual([
      'Metformin',
      'Lisinopril',
      'Amoxicillin',
    ])
  })

  it('returns empty buckets for an empty list', () => {
    expect(shelveMedications([])).toEqual({ unrouted: [], shelves: [], past: [] })
  })
})

describe('buildSummary: concept priority (pin / hide)', () => {
  const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm'
  const DIABETES: Code = { system: SNOMED, code: '73211009', display: 'Diabetes' }
  const ASTHMA: Code = { system: SNOMED, code: '195967001', display: 'Asthma' }
  const PENICILLIN: Code = { system: RXNORM, code: '7980', display: 'Penicillin' }
  const LATEX: Code = { system: SNOMED, code: '111088007', display: 'Latex' }
  const kHtn = `condition|${SNOMED}|38341003`
  const kDiabetes = `condition|${SNOMED}|73211009`
  const kAsthma = `condition|${SNOMED}|195967001`
  const kPenicillin = `allergy_intolerance|${RXNORM}|7980`

  // Problems are newest-first: Asthma (2023), Diabetes (2021), Hypertension (2019).
  const problems = () => [
    ev({ kind: 'condition', code: HTN, effective_at: '2019-01-01T00:00:00+00:00', id: 'htn' }),
    ev({ kind: 'condition', code: DIABETES, effective_at: '2021-01-01T00:00:00+00:00', id: 'dm' }),
    ev({ kind: 'condition', code: ASTHMA, effective_at: '2023-01-01T00:00:00+00:00', id: 'asthma' }),
  ]
  // Allergies are alphabetical: Cashew nuts, Latex, Penicillin.
  const allergies = () => [
    ev({ kind: 'allergy_intolerance', value: { coded: PENICILLIN }, effective_at: '2020-01-01T00:00:00+00:00' }),
    ev({ kind: 'allergy_intolerance', value: { coded: CASHEW }, effective_at: '2019-01-01T00:00:00+00:00' }),
    ev({ kind: 'allergy_intolerance', value: { coded: LATEX }, effective_at: '2018-01-01T00:00:00+00:00' }),
  ]
  const prio = (...entries: [string, ConceptPriority][]) => new Map(entries)

  it('leaves the order alone and nothing hidden when no priority is curated', () => {
    const summary = buildSummary([...problems(), ...allergies()])
    expect(summary.problems.map((r) => r.label)).toEqual(['Asthma', 'Diabetes', 'Hypertension'])
    expect(summary.allergies.map((r) => r.label)).toEqual(['Cashew nuts', 'Latex', 'Penicillin'])
    expect(summary.problems.every((r) => !r.pinned)).toBe(true)
    expect(summary.hidden).toEqual({ problems: [], allergies: [] })
  })

  it('leads Problems with pinned rows, each group still newest-first', () => {
    const { problems: rows } = buildSummary(problems(), { priority: prio([kHtn, 'pinned'], [kDiabetes, 'pinned']) })
    expect(rows.map((r) => r.label)).toEqual(['Diabetes', 'Hypertension', 'Asthma'])
    expect(rows.map((r) => r.pinned)).toEqual([true, true, false])
  })

  it('leads Allergies with pinned rows, each group still alphabetical', () => {
    const { allergies: rows } = buildSummary(allergies(), {
      priority: prio([kPenicillin, 'pinned'], [`allergy_intolerance|${SNOMED}|111088007`, 'pinned']),
    })
    expect(rows.map((r) => r.label)).toEqual(['Latex', 'Penicillin', 'Cashew nuts'])
  })

  it('keeps a pinned resolved problem in the main list, ahead of the active ones', () => {
    const summary = buildSummary(problems(), {
      status: new Map<string, ConceptStatus>([[kHtn, 'inactive'], [kAsthma, 'inactive']]),
      priority: prio([kHtn, 'pinned']),
    })
    const { active, resolved } = splitProblems(summary.problems)
    expect(active.map((r) => [r.label, r.status])).toEqual([
      ['Hypertension', 'inactive'],
      ['Diabetes', 'active'],
    ])
    // An unpinned resolved problem still collapses as before.
    expect(resolved.map((r) => r.label)).toEqual(['Asthma'])
  })

  it('takes a hidden problem out of Problems and lists it only under hidden', () => {
    const summary = buildSummary(problems(), { priority: prio([kDiabetes, 'hidden']) })
    expect(summary.problems.map((r) => r.label)).toEqual(['Asthma', 'Hypertension'])
    expect(summary.hidden.problems.map((r) => r.label)).toEqual(['Diabetes'])
    expect(summary.hidden.allergies).toEqual([])
  })

  it('takes a hidden allergy out of Allergies and lists it only under hidden', () => {
    const summary = buildSummary(allergies(), { priority: prio([kPenicillin, 'hidden']) })
    expect(summary.allergies.map((r) => r.label)).toEqual(['Cashew nuts', 'Latex'])
    expect(summary.hidden.allergies.map((r) => r.label)).toEqual(['Penicillin'])
  })

  it('drops every event of a hidden concept, however many dates it spans', () => {
    const events = [
      ...problems(),
      ev({ kind: 'condition', code: DIABETES, effective_at: '2015-06-01T00:00:00+00:00', id: 'dm-early' }),
      ev({ kind: 'condition', code: { ...DIABETES, display: undefined }, effective_at: null, id: 'dm-undated' }),
    ]
    const summary = buildSummary(events, { priority: prio([kDiabetes, 'hidden']) })
    expect(summary.problems.flatMap((r) => r.eventIds)).toEqual(['asthma', 'htn'])
    // The manage list still holds the whole fold, so unhiding brings all of it back.
    expect(summary.hidden.problems[0].eventIds.sort()).toEqual(['dm', 'dm-early', 'dm-undated'])
  })

  it('does not hide a concept that differs only by code system', () => {
    // Same code string, a different terminology: a different concept. A hide
    // that matched on the code alone would take the wrong problem away.
    const events = [
      ev({ kind: 'condition', code: { system: SNOMED, code: '1234', display: 'Snomed one' }, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { system: ICD10, code: '1234', display: 'Icd one' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const summary = buildSummary(events, { priority: prio([`condition|${SNOMED}|1234`, 'hidden']) })
    expect(summary.problems.map((r) => r.label)).toEqual(['Icd one'])
    expect(summary.hidden.problems.map((r) => r.label)).toEqual(['Snomed one'])
  })

  it('does not hide a concept whose code merely starts with the hidden one', () => {
    const events = [
      ev({ kind: 'condition', code: { system: SNOMED, code: '12', display: 'Short' }, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', code: { system: SNOMED, code: '123', display: 'Long' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const summary = buildSummary(events, { priority: prio([`condition|${SNOMED}|12`, 'hidden']) })
    expect(summary.problems.map((r) => r.label)).toEqual(['Long'])
  })

  it('does not hide the same code under another kind', () => {
    const events = [
      ev({ kind: 'condition', code: { system: SNOMED, code: '91936005', display: 'Penicillin allergy' }, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'allergy_intolerance', value: { coded: { system: SNOMED, code: '91936005', display: 'Penicillin allergy' } }, effective_at: '2020-01-01T00:00:00+00:00' }),
    ]
    const summary = buildSummary(events, { priority: prio([`condition|${SNOMED}|91936005`, 'hidden']) })
    expect(summary.problems).toEqual([])
    expect(summary.allergies.map((r) => r.label)).toEqual(['Penicillin allergy'])
  })

  it('hides a free-text concept by its text key, and only that one', () => {
    // Uncoded entries key on their text (`condition||{text}`), so the hide must
    // too — and a neighbour whose text is merely similar stays.
    const events = [
      ev({ kind: 'condition', value: { text: 'Bad knee' }, effective_at: '2020-01-01T00:00:00+00:00' }),
      ev({ kind: 'condition', value: { text: 'Bad knee (left)' }, effective_at: '2021-01-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', value: { text: 'Bad knee' }, effective_at: '2021-01-01T00:00:00+00:00' }),
    ]
    const summary = buildSummary(events, { priority: prio(['condition||Bad knee', 'hidden']) })
    expect(summary.problems.map((r) => r.label)).toEqual(['Bad knee (left)'])
    expect(summary.hidden.problems.map((r) => r.key)).toEqual(['condition||Bad knee'])
    expect(summary.medications.map((r) => r.label)).toEqual(['Bad knee'])
  })

  it('reads every malformed priority value as normal — nothing hidden, nothing pinned', () => {
    // Each of these is a value this build did not write. Reading any of them as
    // a hide would silently remove a problem; as a pin, silently promote one.
    const adversarial: unknown[] = [
      { priority: 'HIDDEN' },
      { priority: 'Pinned' },
      { priority: ' hidden' },
      { priority: true },
      { priority: 1 },
      { priority: ['hidden'] },
      { priority: { hidden: true } },
      'hidden',
      'pinned',
      ['hidden'],
      null,
      { hidden: true },
      { pinned: true, status: 'hidden' },
    ]
    for (const value of adversarial) {
      const record: CurationRecord = { key: `priority:${kDiabetes}`, value, updated_at: 1, author: 'a'.repeat(64) }
      const summary = buildSummary(problems(), { priority: priorityMapFrom([record]) })
      expect(summary.problems.map((r) => r.label), JSON.stringify(value)).toEqual(['Asthma', 'Diabetes', 'Hypertension'])
      expect(summary.problems.some((r) => r.pinned), JSON.stringify(value)).toBe(false)
      expect(summary.hidden.problems, JSON.stringify(value)).toEqual([])
    }
  })

  it('treats a cleared priority as normal', () => {
    const record: CurationRecord = { key: `priority:${kDiabetes}`, value: { priority: '' }, updated_at: 1, author: 'a'.repeat(64) }
    const summary = buildSummary(problems(), { priority: priorityMapFrom([record]) })
    expect(summary.problems.map((r) => r.label)).toEqual(['Asthma', 'Diabetes', 'Hypertension'])
    expect(summary.hidden.problems).toEqual([])
  })

  it('resolves a pin and a hide written concurrently by LWW, whichever arrives first', () => {
    const pin: CurationRecord = { key: `priority:${kDiabetes}`, value: { priority: 'pinned' }, updated_at: 5, author: 'a'.repeat(64) }
    const hide: CurationRecord = { key: `priority:${kDiabetes}`, value: { priority: 'hidden' }, updated_at: 5, author: 'b'.repeat(64) }
    // Same clock: the tie breaks on the greater author, so the hide wins on
    // every device, merged in either order.
    for (const [local, remote] of [[pin, hide], [hide, pin]]) {
      const winner = lwwMerge(local, remote)
      const summary = buildSummary(problems(), { priority: priorityMapFrom([winner]) })
      expect(summary.hidden.problems.map((r) => r.label)).toEqual(['Diabetes'])
      expect(summary.problems.some((r) => r.pinned)).toBe(false)
    }
  })

  it('leaves medications, results, and the rest unaffected by a pin', () => {
    const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
    const IBU: Code = { system: RXNORM, code: '5640', display: 'Ibuprofen' }
    const events = [
      ev({ kind: 'medication_statement', code: AMOX, effective_at: '2024-01-01T00:00:00+00:00' }),
      ev({ kind: 'medication_statement', code: IBU, effective_at: '2024-01-01T00:00:00+00:00' }),
    ]
    const { medications } = buildSummary(events, { priority: prio([`medication_statement|${RXNORM}|5640`, 'pinned']) })
    // Meds stay alphabetical: the controls (and the reordering) are problems
    // and allergies only.
    expect(medications.map((r) => r.label)).toEqual(['Amoxicillin', 'Ibuprofen'])
  })
})
