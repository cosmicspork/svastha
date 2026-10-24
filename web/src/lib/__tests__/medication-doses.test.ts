// Logged doses (`medication_dose`) against standing medications
// (`medication_statement`): the one rule that links them, the usage line, the
// "Taken recently" group, the dose and add-something-I-take builders, and the
// pharmacy list's share of all of it.
import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  conceptKey,
  conceptKeysForEvents,
  curationKey,
  doseUsageLine,
  standingKeyForDose,
  withoutHiddenConcepts,
  DOSE_WINDOW_DAYS,
} from '../summary'
import {
  asDoseTemplate,
  doseDraft,
  doseIdentityOf,
  DOSE_AMOUNT,
  type EventKind,
  type EventValue,
} from '../drafts'
import { buildPharmacyGroups, pharmacyTakenRows } from '../pharmacy'
import { layoutPharmacyPdf } from '../pharmacyPdf'
import { RXNORM, UCUM, DOSE_UNITS, unitLabel, type Code } from '../codes'
import { toLocalIso } from '../time'
import type { StoredEvent } from '../events'

let nextId = 0
function ev(partial: {
  kind: EventKind
  code?: Code | null
  value?: EventValue | null
  effective_at?: string | null
  source?: string
}): StoredEvent {
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
/** Local noon, minute-aligned (toLocalIso rounds to the minute) and well away
 * from any DST change, so "N days ago" is N calendar days in every timezone. */
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime()
const ago = (days: number, extraMs = 0) => toLocalIso(new Date(NOW - days * DAY_MS - extraMs))
const shortDay = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

const ALBUTEROL: Code = { system: RXNORM, code: '745679', display: 'Albuterol inhaler' }

const statement = (identity: { code?: Code; text?: string }, at: string | null = ago(200), source = 'import:x.xml') =>
  ev({
    kind: 'medication_statement',
    code: identity.code ?? null,
    value: identity.text !== undefined ? { text: identity.text } : null,
    effective_at: at,
    source,
  })
const dose = (identity: { code?: Code; text?: string }, at: string | null) =>
  ev({
    kind: 'medication_dose',
    code: identity.code ?? null,
    value: identity.text !== undefined ? { text: identity.text } : null,
    effective_at: at,
  })

describe('standingKeyForDose', () => {
  it('maps a dose key onto the statement key with the same identity', () => {
    expect(standingKeyForDose(`medication_dose|${RXNORM}|745679`)).toBe(`medication_statement|${RXNORM}|745679`)
    expect(standingKeyForDose('medication_dose||Magnesium glycinate')).toBe('medication_statement||Magnesium glycinate')
  })

  it('is null for every key that is not a dose', () => {
    expect(standingKeyForDose(`medication_statement|${RXNORM}|745679`)).toBeNull()
    expect(standingKeyForDose('observation||headache')).toBeNull()
    // A text that merely contains the prefix is not a dose key.
    expect(standingKeyForDose('medication_statement||medication_dose|x')).toBeNull()
    expect(standingKeyForDose('Medication_dose||x')).toBeNull()
  })

  it('links a dose built from a statement back to that statement, coded or free text', () => {
    for (const s of [statement({ code: ALBUTEROL }), statement({ text: 'Magnesium glycinate' })]) {
      const identity = doseIdentityOf(s.event)!
      const d = doseDraft(identity, ago(1))
      expect(standingKeyForDose(conceptKey(d))).toBe(conceptKey(s.event))
      expect(curationKey(d)).toBe(conceptKey(s.event))
    }
  })

  // Adversarial: free-text keys compare as written everywhere else, so a dose
  // must not link by a looser rule than two statements fold by.
  it.each([
    ['different case', 'albuterol inhaler'],
    ['a trailing space', 'Albuterol inhaler '],
    ['a leading space', ' Albuterol inhaler'],
    ['a doubled inner space', 'Albuterol  inhaler'],
  ])('does not link free text that differs by %s', (_label, text) => {
    const s = statement({ text: 'Albuterol inhaler' })
    const d = dose({ text }, ago(1))
    expect(standingKeyForDose(conceptKey(d.event))).not.toBe(conceptKey(s.event))
    const summary = buildSummary([s, d], { now: NOW })
    expect(summary.medications[0].usage).toBeUndefined()
    expect(summary.takenRecently.map((r) => r.label)).toEqual([text])
  })

  it('links a coded dose only to the same system AND code', () => {
    const s = statement({ code: ALBUTEROL })
    const sameCodeOtherSystem = dose({ code: { system: 'http://hl7.org/fhir/sid/ndc', code: '745679' } }, ago(1))
    const sameSystemOtherCode = dose({ code: { system: RXNORM, code: '745678' } }, ago(1))
    const display = dose({ code: { ...ALBUTEROL, display: 'Something else entirely' } }, ago(1))
    expect(curationKey(sameCodeOtherSystem.event)).not.toBe(conceptKey(s.event))
    expect(curationKey(sameSystemOtherCode.event)).not.toBe(conceptKey(s.event))
    // The display is not identity: a dose naming it differently still links.
    expect(curationKey(display.event)).toBe(conceptKey(s.event))
  })

  it('does not link a coded dose to a free-text statement whose text is the code', () => {
    const s = statement({ text: '745679' })
    expect(curationKey(dose({ code: ALBUTEROL }, ago(1)).event)).not.toBe(conceptKey(s.event))
  })
})

describe('curation through the standing key', () => {
  it('hides a hidden standing medication’s doses with it', () => {
    const s = statement({ code: ALBUTEROL })
    const d = dose({ code: ALBUTEROL }, ago(1))
    const other = dose({ text: 'Ibuprofen' }, ago(1))
    const kept = withoutHiddenConcepts([s, d, other], new Set([conceptKey(s.event)]))
    expect(kept).toEqual([other])
  })

  it('collects a dose’s standing key for share curation', () => {
    expect(conceptKeysForEvents([dose({ code: ALBUTEROL }, ago(1))])).toEqual(
      new Set([`medication_statement|${RXNORM}|745679`]),
    )
  })

  it('names a dose by its standing medication’s override', () => {
    // No statement in this set (it was left out, say, by a date-scoped share):
    // the dose still reads the name the owner gave the medication.
    const names = new Map([['medication_statement||Mag', 'Magnesium glycinate']])
    const { takenRecently } = buildSummary([dose({ text: 'Mag' }, ago(2))], { now: NOW, names })
    expect(takenRecently.map((r) => r.label)).toEqual(['Magnesium glycinate'])
  })

  it('renames a standing medication without touching its usage line', () => {
    const s = statement({ code: ALBUTEROL })
    const names = new Map([[conceptKey(s.event), 'Rescue inhaler']])
    const { medications } = buildSummary([s, dose({ code: ALBUTEROL }, ago(2))], { now: NOW, names })
    expect(medications[0].label).toBe('Rescue inhaler')
    expect(medications[0].usage).toBe('Used 1× in the last 30 days · last 2 days ago')
  })
})

describe('doseUsageLine', () => {
  const doses = (...ats: (string | null)[]) => ats.map((at) => dose({ code: ALBUTEROL }, at).event)

  it('counts doses in the window and says when the last one was', () => {
    expect(doseUsageLine(doses(ago(3), ago(5), ago(10), ago(29)), NOW, 'standing')).toBe(
      'Used 4× in the last 30 days · last 3 days ago',
    )
    expect(doseUsageLine(doses(ago(3), ago(40)), NOW, 'taken')).toBe('1 dose in 30 days · last 3 days ago')
    expect(doseUsageLine(doses(ago(3), ago(4)), NOW, 'taken')).toBe('2 doses in 30 days · last 3 days ago')
  })

  it(`includes a dose exactly ${DOSE_WINDOW_DAYS} days old and excludes one a minute older`, () => {
    expect(doseUsageLine(doses(ago(30)), NOW, 'standing')).toBe(`Used 1× in the last 30 days · last ${shortDay(ago(30))}`)
    expect(doseUsageLine(doses(ago(30, 60_000)), NOW, 'standing')).toBe(`Last used ${shortDay(ago(30))}`)
  })

  it('reads relatively under 14 calendar days, as a date from 14 on', () => {
    expect(doseUsageLine(doses(ago(0)), NOW, 'standing')).toBe('Used 1× in the last 30 days · last today')
    expect(doseUsageLine(doses(ago(1)), NOW, 'standing')).toBe('Used 1× in the last 30 days · last yesterday')
    expect(doseUsageLine(doses(ago(13)), NOW, 'standing')).toBe('Used 1× in the last 30 days · last 13 days ago')
    expect(doseUsageLine(doses(ago(14)), NOW, 'standing')).toBe(`Used 1× in the last 30 days · last ${shortDay(ago(14))}`)
  })

  it('says "Last used" when every dose is older than the window, and the year when it is not this one', () => {
    expect(doseUsageLine(doses(ago(45), ago(60)), NOW, 'standing')).toBe(`Last used ${shortDay(ago(45))}`)
    const old = toLocalIso(new Date(2024, 2, 3, 9, 0))
    const expected = new Date('2024-03-03T00:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    expect(doseUsageLine(doses(old), NOW, 'standing')).toBe(`Last used ${expected}`)
  })

  it('does not count or name a dose dated well in the future (a wrong clock elsewhere)', () => {
    const future = toLocalIso(new Date(NOW + 2 * DAY_MS))
    expect(doseUsageLine(doses(future, ago(3)), NOW, 'standing')).toBe('Used 1× in the last 30 days · last 3 days ago')
    expect(doseUsageLine(doses(future), NOW, 'standing')).toBe('')
    expect(doseUsageLine(doses(toLocalIso(new Date(NOW + 6 * 60_000))), NOW, 'standing')).toBe('')
  })

  // A dose logged at 12:00:40 is stamped 12:01 (toLocalIso rounds to the
  // minute), so "just now" is routinely a few seconds ahead of the summary's
  // clock — and a second device's clock may be a few minutes fast.
  it('counts a dose a few minutes ahead as taken today', () => {
    expect(doseUsageLine(doses(toLocalIso(new Date(NOW + 30_000))), NOW, 'standing')).toBe(
      'Used 1× in the last 30 days · last today',
    )
    expect(doseUsageLine(doses(toLocalIso(new Date(NOW + 4 * 60_000))), NOW, 'taken')).toBe(
      '1 dose in 30 days · last today',
    )
  })

  it('ignores an undated dose, which no window can hold', () => {
    expect(doseUsageLine(doses(null, ago(3)), NOW, 'standing')).toBe('Used 1× in the last 30 days · last 3 days ago')
    expect(doseUsageLine(doses(null), NOW, 'standing')).toBe('')
  })
})

describe('buildSummary: doses', () => {
  it('puts the usage line on the standing row and keeps doses out of its fold', () => {
    const s = statement({ code: ALBUTEROL })
    const { medications, takenRecently } = buildSummary([s, dose({ code: ALBUTEROL }, ago(1)), dose({ code: ALBUTEROL }, ago(2))], {
      now: NOW,
    })
    expect(medications).toHaveLength(1)
    expect(medications[0].count).toBe(1)
    expect(medications[0].eventIds).toEqual([s.event.id])
    expect(medications[0].date).toBe(s.event.effective_at)
    expect(medications[0].usage).toBe('Used 2× in the last 30 days · last yesterday')
    expect(takenRecently).toEqual([])
  })

  it('gives a standing row with no doses no usage line', () => {
    expect(buildSummary([statement({ code: ALBUTEROL })], { now: NOW }).medications[0].usage).toBeUndefined()
  })

  it('lists a dose-only concept under Taken recently only with a dose in the window', () => {
    const events = [
      dose({ text: 'Ibuprofen' }, ago(3)),
      dose({ text: 'Ibuprofen' }, ago(50)),
      dose({ text: 'Cetirizine' }, ago(31)), // only older doses: timeline only
      dose({ text: 'Melatonin' }, toLocalIso(new Date(NOW + DAY_MS))), // only a future one
      dose({ text: 'Antacid' }, null), // only an undated one
    ]
    const { medications, takenRecently } = buildSummary(events, { now: NOW })
    expect(medications).toEqual([])
    expect(takenRecently.map((r) => [r.label, r.usage])).toEqual([['Ibuprofen', '1 dose in 30 days · last 3 days ago']])
    expect(takenRecently[0].hideCount).toBe(true)
    expect(takenRecently[0].key).toBe('medication_dose||Ibuprofen')
  })

  it('sorts Taken recently by name and carries a coded dose’s amount as its detail', () => {
    const amount = (value: string): EventValue => ({ quantity: { value, unit: { system: UCUM, code: '{puff}' } } })
    const events = [
      ev({ kind: 'medication_dose', code: ALBUTEROL, value: amount('2'), effective_at: ago(2) }),
      dose({ text: 'Antacid' }, ago(4)),
    ]
    const { takenRecently } = buildSummary(events, { now: NOW })
    expect(takenRecently.map((r) => r.label)).toEqual(['Albuterol inhaler', 'Antacid'])
    expect(takenRecently[0].detail).toBe('2 puffs')
  })

  it('keeps an old free-text medication_statement a statement row', () => {
    // Logged by the Meds form before it wrote doses: signed history, unchanged.
    const old = statement({ text: 'Ibuprofen — 400 mg' }, ago(400), 'self')
    const { medications, takenRecently } = buildSummary([old], { now: NOW })
    expect(medications.map((r) => [r.label, r.origin])).toEqual([['Ibuprofen — 400 mg', 'self']])
    expect(takenRecently).toEqual([])
  })

  it('shows a past medication’s doses on its past row, not under Taken recently', () => {
    const s = statement({ code: ALBUTEROL })
    const status = new Map([[conceptKey(s.event), 'inactive' as const]])
    const { medications, takenRecently } = buildSummary([s, dose({ code: ALBUTEROL }, ago(1))], { now: NOW, status })
    expect(medications[0].status).toBe('inactive')
    expect(medications[0].usage).toBe('Used 1× in the last 30 days · last yesterday')
    expect(takenRecently).toEqual([])
  })
})

describe('doseDraft and doseIdentityOf', () => {
  it('copies a coded statement’s code exactly, display included', () => {
    expect(doseIdentityOf(statement({ code: ALBUTEROL }).event)).toEqual({ code: ALBUTEROL })
  })

  it('copies a free-text statement’s text exactly, untrimmed', () => {
    expect(doseIdentityOf(statement({ text: ' Mag ' }).event)).toEqual({ text: ' Mag ' })
  })

  it('has nothing to copy from a statement with neither', () => {
    expect(doseIdentityOf(statement({}).event)).toBeNull()
  })

  it('writes a coded dose’s amount as a quantity, and no value without one', () => {
    const puffs = DOSE_UNITS.find((u) => u.label === 'puffs')!.unit
    expect(doseDraft({ code: ALBUTEROL }, 'T', { value: '2', unit: puffs })).toEqual({
      kind: 'medication_dose',
      code: ALBUTEROL,
      effective_at: 'T',
      value: { quantity: { value: '2', unit: puffs } },
    })
    expect(doseDraft({ code: ALBUTEROL }, 'T').value).toBeNull()
  })

  it('writes a free-text dose as that text and nothing else', () => {
    expect(doseDraft({ text: 'Ibuprofen' }, 'T')).toEqual({
      kind: 'medication_dose',
      effective_at: 'T',
      value: { text: 'Ibuprofen' },
    })
  })

  it.each(['2', '0.5', '12.5', '0'])('accepts the amount %s', (a) => expect(DOSE_AMOUNT.test(a)).toBe(true))
  it.each(['02', '1.', '.5', '-1', '1e2', ' 2', '2 ', '½', '٣', ''])('refuses the amount %j', (a) =>
    expect(DOSE_AMOUNT.test(a)).toBe(false),
  )

  it('renders the dose form’s units as words, other units as their code', () => {
    expect(unitLabel({ system: UCUM, code: '{puff}' })).toBe('puffs')
    expect(unitLabel({ system: UCUM, code: 'ug' })).toBe('mcg')
    expect(unitLabel({ system: UCUM, code: '[IU]' })).toBe('IU')
    expect(unitLabel({ system: UCUM, code: 'mm[Hg]' })).toBe('mm[Hg]')
    // Only UCUM's own spelling is translated.
    expect(unitLabel({ system: 'urn:other', code: '{puff}' })).toBe('{puff}')
    expect(unitLabel(null)).toBe('')
  })
})

describe('asDoseTemplate (old Meds favorites)', () => {
  it('logs an old statement text favorite as a dose with the same text', () => {
    expect(asDoseTemplate({ kind: 'medication_statement', value: { text: 'Ibuprofen — 400 mg' } })).toEqual({
      kind: 'medication_dose',
      value: { text: 'Ibuprofen — 400 mg' },
    })
  })

  it('keeps a coded favorite’s quantity but drops a dosage sig', () => {
    const q: EventValue = { quantity: { value: '2', unit: null } }
    expect(asDoseTemplate({ kind: 'medication_statement', code: ALBUTEROL, value: q })).toEqual({
      kind: 'medication_dose',
      code: ALBUTEROL,
      value: q,
    })
    expect(
      asDoseTemplate({ kind: 'medication_statement', code: ALBUTEROL, value: { dosage: { text: 'BID' } } }).value,
    ).toBeNull()
  })

  it('leaves every other template alone', () => {
    const t = { kind: 'medication_dose' as const, value: { text: 'x' } }
    expect(asDoseTemplate(t)).toBe(t)
    const food = { kind: 'nutrition_intake' as const, value: { text: 'oatmeal' } }
    expect(asDoseTemplate(food)).toBe(food)
  })
})

describe('pharmacy list with doses', () => {
  const s = statement({ code: ALBUTEROL })
  const summary = buildSummary([s, dose({ code: ALBUTEROL }, ago(2)), dose({ text: 'Ibuprofen' }, ago(3))], {
    now: NOW,
  })

  it('carries the usage line onto the numbered row', () => {
    const [group] = buildPharmacyGroups(summary.medications)
    expect(group.rows.map((r) => [r.n, r.name, r.usage])).toEqual([
      [1, 'Albuterol inhaler', 'Used 1× in the last 30 days · last 2 days ago'],
    ])
  })

  it('keeps a dose-only medication off the numbered list, listed after it', () => {
    expect(buildPharmacyGroups(summary.medications).flatMap((g) => g.rows.map((r) => r.name))).toEqual([
      'Albuterol inhaler',
    ])
    expect(pharmacyTakenRows(summary.takenRecently)).toEqual([
      { key: 'medication_dose||Ibuprofen', name: 'Ibuprofen', dose: '', usage: '1 dose in 30 days · last 3 days ago' },
    ])
  })

  it('prints both in the PDF, the taken-recently lines unnumbered', () => {
    const measure = (text: string, size: number) => text.length * size * 0.5
    const lines = layoutPharmacyPdf(
      buildPharmacyGroups(summary.medications),
      null,
      'now',
      measure,
      undefined,
      pharmacyTakenRows(summary.takenRecently),
    ).flatMap((p) => p.runs.map((r) => r.text))
    expect(lines).toContain('1. Albuterol inhaler')
    expect(lines).toContain('Used 1× in the last 30 days · last 2 days ago')
    expect(lines).toContain('Also taken recently')
    expect(lines).toContain('Ibuprofen')
    expect(lines).toContain('1 dose in 30 days · last 3 days ago')
    expect(lines.some((l) => /^\d+\. Ibuprofen/.test(l))).toBe(false)
  })
})
