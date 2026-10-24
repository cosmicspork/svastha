// "Add something I take": the add sheet's plan — one name-only statement plus
// its regimen, and the exact-key duplicate rule.
import { describe, expect, it } from 'vitest'
import { buildSummary, conceptKey } from '../summary'
import { standingMedDraft, type EventKind, type EventValue } from '../drafts'
import { planAddMedication, type AddMedicationFields } from '../addMedication'
import { RXNORM, type Code } from '../codes'
import { toLocalIso } from '../time'
import type { StoredEvent } from '../events'

let nextId = 0
function ev(partial: { kind: EventKind; code?: Code | null; value?: EventValue | null; effective_at?: string | null; source?: string }): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: partial.kind,
      code: partial.code ?? null,
      value: partial.value ?? null,
      effective_at: partial.effective_at ?? null,
      provenance: { source: partial.source ?? 'self', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Local noon, minute-aligned (toLocalIso rounds to the minute). */
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime()
const ago = (days: number) => toLocalIso(new Date(NOW - days * DAY_MS))

const statement = (identity: { code?: Code; text?: string }, at: string | null = ago(200), source = 'import:x.xml') =>
  ev({
    kind: 'medication_statement',
    code: identity.code ?? null,
    value: identity.text !== undefined ? { text: identity.text } : null,
    effective_at: at,
    source,
  })

describe('planAddMedication', () => {
  const fields = (over: Partial<AddMedicationFields> = {}): AddMedicationFields => ({
    name: 'Magnesium glycinate',
    dose: '400 mg',
    schedule: 'Nightly',
    route: 'mouth',
    as_needed: false,
    started: '',
    ...over,
  })
  const now = new Date(NOW)
  const rows = (...events: StoredEvent[]) => buildSummary(events, { now: NOW }).medications

  it('writes one name-only statement and the regimen beside it', () => {
    const plan = planAddMedication(fields(), [], now)
    expect(plan).toEqual({
      kind: 'add',
      key: 'medication_statement||Magnesium glycinate',
      draft: { kind: 'medication_statement', effective_at: toLocalIso(now), value: { text: 'Magnesium glycinate' } },
      regimen: { dose: '400 mg', schedule: 'Nightly', route: 'mouth' },
      reactivate: false,
    })
  })

  it('keys on the trimmed name only, so the dose never enters the concept', () => {
    const plan = planAddMedication(fields({ name: '  Vitamin D3+K2 ', dose: '2000 IU' }), [], now)
    expect(plan.kind === 'add' && plan.key).toBe('medication_statement||Vitamin D3+K2')
    expect(conceptKey(standingMedDraft('Vitamin D3+K2', 'T'))).toBe('medication_statement||Vitamin D3+K2')
  })

  it('dates the statement by the start date and records it in the regimen', () => {
    const plan = planAddMedication(fields({ started: '2026-03-01' }), [], now)
    expect(plan.kind).toBe('add')
    if (plan.kind !== 'add') return
    expect(plan.draft.effective_at).toBe(toLocalIso(new Date(2026, 2, 1)))
    expect(plan.regimen?.started).toBe('2026-03-01')
  })

  it('offers the existing current medication instead of a duplicate', () => {
    const existing = statement({ text: 'Magnesium glycinate' }, ago(10), 'self')
    const plan = planAddMedication(fields(), rows(existing), now)
    expect(plan.kind).toBe('existing')
    expect(plan.kind === 'existing' && plan.row.key).toBe(conceptKey(existing.event))
  })

  // Adversarial: the duplicate rule is the concept key, compared as written.
  it.each([
    ['different case', 'magnesium glycinate'],
    ['an inner difference', 'Magnesium  glycinate'],
  ])('treats a name with %s as a different medication', (_label, name) => {
    const existing = statement({ text: 'Magnesium glycinate' }, ago(10), 'self')
    expect(planAddMedication(fields({ name }), rows(existing), now).kind).toBe('add')
  })

  it('treats surrounding spaces as the same name (the form trims)', () => {
    const existing = statement({ text: 'Magnesium glycinate' }, ago(10), 'self')
    expect(planAddMedication(fields({ name: ' Magnesium glycinate  ' }), rows(existing), now).kind).toBe('existing')
  })

  it('does not count a coded medication of the same display name as a duplicate', () => {
    const coded = statement({ code: { system: RXNORM, code: '1', display: 'Magnesium glycinate' } })
    expect(planAddMedication(fields(), rows(coded), now).kind).toBe('add')
  })

  it('restarts a past medication of the same name rather than leaving the new one under Past', () => {
    const past = statement({ text: 'Magnesium glycinate' }, ago(100), 'self')
    const medications = buildSummary([past], {
      now: NOW,
      status: new Map([[conceptKey(past.event), 'inactive' as const]]),
    }).medications
    const plan = planAddMedication(fields(), medications, now)
    expect(plan.kind === 'add' && plan.reactivate).toBe(true)
  })

  it('writes no regimen when every detail is blank', () => {
    const plan = planAddMedication(fields({ dose: ' ', schedule: '', route: '' }), [], now)
    expect(plan.kind === 'add' && plan.regimen).toBeUndefined()
  })

  it.each([
    ['no name', { name: '   ' }],
    ['a start after today', { started: '2026-07-16' }],
    ['a start that is not a day', { started: '2026-02-31' }],
    ['a start that is not a date', { started: 'March' }],
  ])('is not saveable with %s', (_label, over) => {
    expect(planAddMedication(fields(over), [], now).kind).toBe('invalid')
  })

  it('accepts a start of today', () => {
    expect(planAddMedication(fields({ started: '2026-07-15' }), [], now).kind).toBe('add')
  })
})
