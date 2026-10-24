import { describe, expect, it } from 'vitest'
import { categorize, CATEGORY_META, CATEGORIES } from '../category'
import {
  LOINC,
  SNOMED,
  VITALS,
  BP_DIASTOLIC,
  EXERCISE_ACTIVITY,
  EXERCISE_DURATION,
  MOOD,
  GRATITUDE,
  CYCLE_START,
  CYCLE_END,
  CYCLE_FLOW,
  CYCLE_CLOTS,
} from '../codes'

describe('categorize by kind', () => {
  it('maps non-observation kinds directly', () => {
    expect(categorize({ kind: 'nutrition_intake', value: { text: 'oatmeal' } })).toBe('food')
    expect(categorize({ kind: 'medication_statement', value: { text: 'ibuprofen' } })).toBe('med')
    expect(categorize({ kind: 'medication_dose', value: { text: 'albuterol' } })).toBe('med')
    expect(categorize({ kind: 'condition' })).toBe('clinical')
    expect(categorize({ kind: 'immunization' })).toBe('clinical')
    expect(categorize({ kind: 'encounter' })).toBe('clinical')
    expect(categorize({ kind: 'procedure' })).toBe('clinical')
    expect(categorize({ kind: 'allergy_intolerance' })).toBe('clinical')
  })

  it('splits document on value shape: text or attachment is a note, anything else clinical', () => {
    expect(categorize({ kind: 'document', value: { text: 'slept badly' } })).toBe('note')
    expect(
      categorize({
        kind: 'document',
        value: { attachment: { sha256: 'ab', mime: 'image/jpeg', size: 10 } },
      }),
    ).toBe('note')
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

  it('classes a non-cycle svastha-system observation as mind', () => {
    expect(categorize({ kind: 'observation', code: MOOD })).toBe('mind')
    expect(categorize({ kind: 'observation', code: GRATITUDE })).toBe('mind')
  })

  it('classes the cycle svastha codes as cycle, not mind — a regression guard on the shared SVASTHA system', () => {
    expect(categorize({ kind: 'observation', code: CYCLE_START })).toBe('cycle')
    expect(categorize({ kind: 'observation', code: CYCLE_END })).toBe('cycle')
    expect(categorize({ kind: 'observation', code: CYCLE_FLOW })).toBe('cycle')
    expect(categorize({ kind: 'observation', code: CYCLE_CLOTS })).toBe('cycle')
    // Mood and gratitude still land on mind once a sibling category shares the system.
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

  it('flags cycle and mind sensitive, and no other category', () => {
    for (const category of CATEGORIES) {
      const expected = category === 'cycle' || category === 'mind'
      expect(!!CATEGORY_META[category].sensitive).toBe(expected)
    }
  })
})

describe('work category', () => {
  const t = (code: string, text: string) =>
    categorize({ kind: 'observation', code: { system: LOINC, code }, value: { text } })

  it('routes occupation, occupational hazard and industry observations to work, not clinical', () => {
    expect(t('11341-5', 'welder')).toBe('work')
    expect(t('87729-0', 'asbestos')).toBe('work')
    expect(t('86188-0', 'construction')).toBe('work')
  })

  it('does not route the same code under another system, or a neighbouring LOINC text observation', () => {
    expect(
      categorize({ kind: 'observation', code: { system: 'urn:other', code: '11341-5' }, value: { text: 'x' } }),
    ).toBe('clinical')
    expect(t('11342-3', 'x')).toBe('clinical')
  })

  it('is a non-sensitive category, so a default doctor share carries it', () => {
    expect(CATEGORIES).toContain('work')
    expect(CATEGORY_META.work.sensitive).toBeFalsy()
    expect(CATEGORY_META.work.hueClass).toBe('cat-work')
  })
})
