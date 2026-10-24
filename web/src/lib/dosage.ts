// Renders the timing half of a `dosage` value for people. The dose itself is
// not repeated here: a row's dose column already reads `dosage.dose` through
// `quantityOf`.
import type { Dosage } from './drafts'

/** FHIR event-timing codes. A code outside this table is dropped rather than
 * printed: a raw "PCV" tells a reader nothing and looks like a mistake. */
const WHEN_WORDS: Record<string, string> = {
  HS: 'at bedtime',
  WAKE: 'on waking',
  C: 'with meals',
  CM: 'with breakfast',
  CD: 'with lunch',
  CV: 'with dinner',
  AC: 'before meals',
  ACM: 'before breakfast',
  ACD: 'before lunch',
  ACV: 'before dinner',
  PC: 'after meals',
  PCM: 'after breakfast',
  PCD: 'after lunch',
  PCV: 'after dinner',
  MORN: 'in the morning',
  NOON: 'at noon',
  AFT: 'in the afternoon',
  EVE: 'in the evening',
  NIGHT: 'at night',
}

const UNIT_WORDS = { h: 'hour', d: 'day', wk: 'week', mo: 'month' } as const
const ADVERBS = {
  h: 'hourly',
  d: 'daily',
  wk: 'weekly',
  mo: 'monthly',
} as const

function frequencyPhrase(d: Dosage): string {
  const unit = d.period_unit
  const period = d.period?.trim()
  const frequency = d.frequency?.trim()
  // Without a frequency and a period there is no rate to state; guessing "once"
  // would put words in the source's mouth.
  if (!unit || !(unit in UNIT_WORDS) || !period || !frequency) return ''
  const n = Number(frequency)
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(Number(period))) return ''
  const single = Number(period) === 1
  if (single && unit !== 'h') {
    if (n === 1) return `once ${ADVERBS[unit]}`
    if (n === 2) return `twice ${ADVERBS[unit]}`
    return `${n} times ${ADVERBS[unit]}`
  }
  const every = single ? `every ${UNIT_WORDS[unit]}` : `every ${period} ${UNIT_WORDS[unit]}s`
  return n === 1 ? every : `${n} times ${every}`
}

/** How often a dosage says a medication is taken: its free-text sig when it has
 * one, else a phrase built from its timing fields. Empty when it says nothing
 * about timing (a bare dose), so callers can fall through to "not recorded". */
export function renderDosage(d: Dosage): string {
  const text = d.text?.trim()
  if (text) return text
  const parts = [frequencyPhrase(d)]
  const when = d.when ? WHEN_WORDS[d.when.trim().toUpperCase()] : undefined
  if (when) parts.push(when)
  if (d.as_needed === true) parts.push('as needed')
  return parts.filter(Boolean).join(', ')
}
