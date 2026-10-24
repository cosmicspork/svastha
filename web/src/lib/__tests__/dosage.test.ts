import { describe, expect, it } from 'vitest'
import { renderDosage } from '../dosage'
import type { Dosage } from '../drafts'

const timing = (frequency: string, period: string, period_unit: Dosage['period_unit']): Dosage => ({
  frequency,
  period,
  period_unit,
})

describe('renderDosage', () => {
  it.each([
    [timing('1', '1', 'd'), 'once daily'],
    [timing('2', '1', 'd'), 'twice daily'],
    [timing('3', '1', 'd'), '3 times daily'],
    [timing('1', '8', 'h'), 'every 8 hours'],
    [timing('1', '1', 'h'), 'every hour'],
    [timing('1', '2', 'd'), 'every 2 days'],
    [timing('1', '1', 'wk'), 'once weekly'],
    [timing('2', '1', 'wk'), 'twice weekly'],
    [timing('1', '1', 'mo'), 'once monthly'],
    [timing('3', '2', 'd'), '3 times every 2 days'],
    [timing('1', '0.5', 'h'), 'every 0.5 hours'],
    [timing('1', '1.0', 'd'), 'once daily'],
  ])('renders %j as %s', (d, expected) => {
    expect(renderDosage(d)).toBe(expected)
  })

  it.each([
    ['HS', 'at bedtime'],
    ['WAKE', 'on waking'],
    ['C', 'with meals'],
    ['CM', 'with breakfast'],
    ['CD', 'with lunch'],
    ['CV', 'with dinner'],
    ['AC', 'before meals'],
    ['ACM', 'before breakfast'],
    ['ACD', 'before lunch'],
    ['ACV', 'before dinner'],
    ['PC', 'after meals'],
    ['PCM', 'after breakfast'],
    ['PCD', 'after lunch'],
    ['PCV', 'after dinner'],
    ['MORN', 'in the morning'],
    ['NOON', 'at noon'],
    ['AFT', 'in the afternoon'],
    ['EVE', 'in the evening'],
    ['NIGHT', 'at night'],
  ])('maps when=%s to "%s"', (when, words) => {
    expect(renderDosage({ when })).toBe(words)
  })

  it('combines frequency, when and as-needed in that order', () => {
    expect(renderDosage({ ...timing('2', '1', 'd'), when: 'AC', as_needed: true })).toBe(
      'twice daily, before meals, as needed',
    )
  })

  it('lets a non-blank sig text win over every timing field', () => {
    expect(renderDosage({ text: ' Take 1 tablet by mouth BID ', ...timing('1', '1', 'd'), when: 'HS' })).toBe(
      'Take 1 tablet by mouth BID',
    )
  })

  it('falls back to timing when the text is blank or whitespace', () => {
    expect(renderDosage({ text: '', ...timing('2', '1', 'd') })).toBe('twice daily')
    expect(renderDosage({ text: '   \n', ...timing('2', '1', 'd') })).toBe('twice daily')
  })

  it('never prints an unknown or malformed when code', () => {
    expect(renderDosage({ when: 'XYZ' })).toBe('')
    expect(renderDosage({ ...timing('1', '1', 'd'), when: 'XYZ' })).toBe('once daily')
    expect(renderDosage({ ...timing('1', '1', 'd'), when: '  ' })).toBe('once daily')
  })

  it('accepts a lowercase known code', () => {
    expect(renderDosage({ when: 'hs' })).toBe('at bedtime')
  })

  it('renders as-needed alone', () => {
    expect(renderDosage({ as_needed: true })).toBe('as needed')
    expect(renderDosage({ as_needed: false })).toBe('')
  })

  it('says nothing about timing for a bare dose', () => {
    expect(renderDosage({ dose: { value: '500', unit: { system: 'u', code: 'mg' } } })).toBe('')
  })

  it('does not invent a rate from half of one', () => {
    expect(renderDosage({ frequency: '2' })).toBe('')
    expect(renderDosage({ period: '8', period_unit: 'h' })).toBe('')
  })

  it('does not render a garbled frequency or unit', () => {
    expect(renderDosage(timing('0', '1', 'd'))).toBe('')
    expect(renderDosage(timing('x', '1', 'd'))).toBe('')
    expect(renderDosage(timing('1', '1', 'min' as Dosage['period_unit']))).toBe('')
  })

  it('returns an empty string when every field is null', () => {
    expect(
      renderDosage({
        dose: null,
        text: null,
        frequency: null,
        period: null,
        period_unit: null,
        when: null,
        as_needed: null,
      }),
    ).toBe('')
  })
})
