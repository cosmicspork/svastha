import { describe, expect, it } from 'vitest'
import {
  bpDrafts,
  vitalDraft,
  symptomDraft,
  freeTextSymptomDraft,
  medDraft,
  foodDrafts,
  exerciseDrafts,
  noteDraft,
  fromTemplates,
  toTemplate,
} from '../drafts'
import {
  BP_SYSTOLIC,
  BP_DIASTOLIC,
  MMHG,
  MINUTES,
  EXERCISE_ACTIVITY,
  EXERCISE_DURATION,
  SYMPTOMS,
  VITALS,
} from '../codes'

const AT = '2026-07-04T08:30:00-05:00'

describe('bpDrafts', () => {
  it('emits two observations sharing one effective_at', () => {
    const drafts = bpDrafts('118', '76', AT)
    expect(drafts).toHaveLength(2)
    expect(drafts.every((d) => d.kind === 'observation')).toBe(true)
    expect(drafts.every((d) => d.effective_at === AT)).toBe(true)
    expect(drafts[0].code).toEqual(BP_SYSTOLIC)
    expect(drafts[0].value).toEqual({ quantity: { value: '118', unit: MMHG } })
    expect(drafts[1].code).toEqual(BP_DIASTOLIC)
    expect(drafts[1].value).toEqual({ quantity: { value: '76', unit: MMHG } })
  })
})

describe('vitalDraft', () => {
  it('builds a coded quantity observation', () => {
    const weight = VITALS.find((v) => v.key === 'weight')!
    const draft = vitalDraft(weight.loinc, '82.5', weight.units[0].unit, AT)
    expect(draft.kind).toBe('observation')
    expect(draft.code).toEqual(weight.loinc)
    expect(draft.value).toEqual({ quantity: { value: '82.5', unit: weight.units[0].unit } })
  })
})

describe('symptom drafts', () => {
  it('carries severity as a unitless quantity on coded symptoms', () => {
    const headache = SYMPTOMS[0]
    const draft = symptomDraft(headache.snomed, 8, AT)
    expect(draft.code).toEqual(headache.snomed)
    expect(draft.value).toEqual({ quantity: { value: '8', unit: null } })
  })

  it('free text is one code-less observation whose text is the name', () => {
    const draft = freeTextSymptomDraft('weird tingling', AT)
    expect(draft.code).toBeUndefined()
    expect(draft.value).toEqual({ text: 'weird tingling' })
  })
})

describe('medDraft', () => {
  it('folds an optional dose into the text value', () => {
    expect(medDraft('ibuprofen', AT).value).toEqual({ text: 'ibuprofen' })
    expect(medDraft('ibuprofen', AT, '400', 'mg').value).toEqual({ text: 'ibuprofen — 400 mg' })
  })
})

describe('foodDrafts', () => {
  it('emits one nutrition_intake per item, sharing effective_at', () => {
    const drafts = foodDrafts(['oatmeal', 'coffee', 'toast'], AT)
    expect(drafts).toHaveLength(3)
    expect(drafts.every((d) => d.kind === 'nutrition_intake')).toBe(true)
    expect(drafts.every((d) => d.effective_at === AT)).toBe(true)
    expect(drafts.map((d) => d.value)).toEqual([
      { text: 'oatmeal' },
      { text: 'coffee' },
      { text: 'toast' },
    ])
  })
})

describe('exerciseDrafts', () => {
  it('emits activity only when no duration is given', () => {
    const drafts = exerciseDrafts('walk', AT)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].code).toEqual(EXERCISE_ACTIVITY)
    expect(drafts[0].value).toEqual({ text: 'walk' })
  })

  it('adds a duration observation sharing effective_at when minutes are given', () => {
    const drafts = exerciseDrafts('walk', AT, '30')
    expect(drafts).toHaveLength(2)
    expect(drafts[1].code).toEqual(EXERCISE_DURATION)
    expect(drafts[1].value).toEqual({ quantity: { value: '30', unit: MINUTES } })
    expect(drafts.every((d) => d.effective_at === AT)).toBe(true)
  })
})

describe('noteDraft', () => {
  it('builds a text document', () => {
    const draft = noteDraft('slept badly', AT)
    expect(draft.kind).toBe('document')
    expect(draft.value).toEqual({ text: 'slept badly' })
  })
})

describe('templates', () => {
  it('round-trips drafts through templates with a new timestamp', () => {
    const templates = bpDrafts('118', '76', AT).map(toTemplate)
    expect(templates.every((t) => !('effective_at' in t))).toBe(true)

    const later = '2026-07-05T09:00:00-05:00'
    const drafts = fromTemplates(templates, later)
    expect(drafts).toEqual(bpDrafts('118', '76', later))
  })
})
