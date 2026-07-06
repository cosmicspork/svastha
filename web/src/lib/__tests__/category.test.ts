import { describe, expect, it } from 'vitest'
import { categorize, CATEGORY_META, CATEGORIES } from '../category'
import { LOINC, SNOMED, VITALS, BP_DIASTOLIC, EXERCISE_ACTIVITY, EXERCISE_DURATION, MOOD, GRATITUDE } from '../codes'

describe('categorize by kind', () => {
  it('maps non-observation kinds directly', () => {
    expect(categorize({ kind: 'nutrition_intake', value: { text: 'oatmeal' } })).toBe('food')
    expect(categorize({ kind: 'medication_statement', value: { text: 'ibuprofen' } })).toBe('med')
    expect(categorize({ kind: 'condition' })).toBe('clinical')
    expect(categorize({ kind: 'immunization' })).toBe('clinical')
    expect(categorize({ kind: 'encounter' })).toBe('clinical')
    expect(categorize({ kind: 'procedure' })).toBe('clinical')
    expect(categorize({ kind: 'allergy_intolerance' })).toBe('clinical')
  })

  it('splits document on value shape: text is a note, anything else clinical', () => {
    expect(categorize({ kind: 'document', value: { text: 'slept badly' } })).toBe('note')
    expect(categorize({ kind: 'document', value: null })).toBe('clinical')
  })
})

describe('categorize observations', () => {
  it('classes every vitals LOINC (including diastolic) as vital', () => {
    for (const vital of VITALS) {
      expect(categorize({ kind: 'observation', code: vital.loinc })).toBe('vital')
    }
    expect(categorize({ kind: 'observation', code: BP_DIASTOLIC })).toBe('vital')
  })

  it('classes the exercise LOINCs as exercise', () => {
    expect(categorize({ kind: 'observation', code: EXERCISE_ACTIVITY })).toBe('exercise')
    expect(categorize({ kind: 'observation', code: EXERCISE_DURATION })).toBe('exercise')
  })

  it('classes any svastha-system observation as mind', () => {
    expect(categorize({ kind: 'observation', code: MOOD })).toBe('mind')
    expect(categorize({ kind: 'observation', code: GRATITUDE })).toBe('mind')
  })

  it('classes SNOMED-coded observations as symptom', () => {
    expect(
      categorize({
        kind: 'observation',
        code: { system: SNOMED, code: '25064002', display: 'Headache' },
      }),
    ).toBe('symptom')
  })

  it('classes a code-less text observation as a self-reported symptom', () => {
    expect(categorize({ kind: 'observation', value: { text: 'weird tingling' } })).toBe('symptom')
  })

  it('falls back to clinical for other coded observations, other for bare ones', () => {
    expect(
      categorize({ kind: 'observation', code: { system: LOINC, code: '2093-3' } }),
    ).toBe('clinical')
    expect(
      categorize({ kind: 'observation', value: { quantity: { value: '3', unit: null } } }),
    ).toBe('other')
  })
})

describe('CATEGORY_META', () => {
  it('covers every category with a label, glyph, and hue class', () => {
    for (const category of CATEGORIES) {
      const meta = CATEGORY_META[category]
      expect(meta.label).toBeTruthy()
      expect(meta.glyph.length).toBeGreaterThan(0)
      expect(meta.hueClass).toBe(`cat-${category}`)
    }
  })
})
