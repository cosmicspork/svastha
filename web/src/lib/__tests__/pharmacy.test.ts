import { describe, expect, it } from 'vitest'
import { buildPharmacyGroups, pharmacyRowCount, sigLine, UNROUTED_TITLE } from '../pharmacy'
import { buildSummary } from '../summary'
import type { StoredEvent } from '../events'
import type { ConceptStatus, Regimen } from '../curation'
import { RXNORM, type Code } from '../codes'

const NOW = Date.parse('2026-01-15T12:00:00+00:00')

let nextId = 0
function med(code: Code): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: 'medication_statement',
      code,
      value: null,
      effective_at: '2024-01-01T00:00:00+00:00',
    },
    // The fold reads `event` only; the envelope fields are inert here.
  } as unknown as StoredEvent
}

const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
const LISI: Code = { system: RXNORM, code: '29046', display: 'Lisinopril' }
const METF: Code = { system: RXNORM, code: '6809', display: 'Metformin' }
const ZOLP: Code = { system: RXNORM, code: '39786', display: 'Zolpidem' }
const ALBU: Code = { system: RXNORM, code: '745679', display: 'Albuterol' }

const key = (code: Code) => `medication_statement|${code.system}|${code.code}`

/** Through the real fold, exactly as the page builds it: nothing here asserts
 * against hand-made rows the app would never produce. */
function groups(
  codes: Code[],
  opts: { regimen?: Map<string, Regimen>; status?: Map<string, ConceptStatus> } = {},
) {
  return buildPharmacyGroups(buildSummary(codes.map(med), { now: NOW, ...opts }).medications)
}

describe('sigLine', () => {
  it('joins schedule and instructions', () => {
    expect(sigLine({ schedule: 'twice a day', instructions: 'with food' })).toBe(
      'twice a day · with food',
    )
  })

  it('carries whichever half was recorded', () => {
    expect(sigLine({ schedule: 'twice a day' })).toBe('twice a day')
    expect(sigLine({ instructions: 'with food' })).toBe('with food')
  })

  it('is empty when nothing was recorded, rather than a placeholder', () => {
    expect(sigLine(undefined)).toBe('')
    expect(sigLine({})).toBe('')
    expect(sigLine({ dose: '500 mg', prescriber: 'Dr. Rao', route: 'mouth' })).toBe('')
  })

  it('never puts the prescriber in the sig', () => {
    // A direction that names a doctor reads as part of the instruction; the
    // prescriber is a separate field on the row.
    expect(sigLine({ schedule: 'once daily', prescriber: 'Dr. Rao' })).toBe('once daily')
  })
})

describe('buildPharmacyGroups', () => {
  it('numbers continuously across every group, past included', () => {
    const regimen = new Map<string, Regimen>([
      [key(LISI), { route: 'mouth' }],
      [key(ALBU), { route: 'inhaled' }],
    ])
    // METF is unrouted (leads), AMOX is past (trails).
    const status = new Map<string, ConceptStatus>([[key(AMOX), 'inactive']])
    const result = groups([METF, LISI, ALBU, AMOX], { regimen, status })

    expect(result.map((g) => g.id)).toEqual(['unrouted', 'mouth', 'inhaled', 'past'])
    expect(result.map((g) => g.rows.map((r) => `${r.n} ${r.name}`))).toEqual([
      ['1 Metformin'],
      ['2 Lisinopril'],
      ['3 Albuterol'],
      ['4 Amoxicillin'],
    ])
  })

  it('starts at 1 when every med is past', () => {
    const status = new Map<string, ConceptStatus>([
      [key(AMOX), 'inactive'],
      [key(LISI), 'inactive'],
    ])
    const result = groups([AMOX, LISI], { status })
    expect(result.map((g) => g.id)).toEqual(['past'])
    expect(result[0].rows.map((r) => r.n)).toEqual([1, 2])
    expect(result[0].rows.every((r) => r.past)).toBe(true)
  })

  it('assigns each row a distinct number covering 1..count', () => {
    // Adversarial: the same drug filed on two routes and a same-named past
    // entry — a numbering bug that restarted per group, or reused a number for
    // rows sharing a label, survives the simpler cases above but not this one.
    const regimen = new Map<string, Regimen>([
      [key(LISI), { route: 'mouth' }],
      [key(METF), { route: 'mouth' }],
      [key(ALBU), { route: 'inhaled' }],
      [key(ZOLP), { route: 'skin' }],
    ])
    const status = new Map<string, ConceptStatus>([[key(AMOX), 'inactive']])
    const result = groups([LISI, METF, ALBU, ZOLP, AMOX], { regimen, status })

    const numbers = result.flatMap((g) => g.rows.map((r) => r.n))
    expect(pharmacyRowCount(result)).toBe(5)
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps an as-needed med on its route shelf and flags it', () => {
    const regimen = new Map<string, Regimen>([
      [key(ALBU), { route: 'inhaled', as_needed: true }],
      [key(LISI), { route: 'mouth' }],
    ])
    const result = groups([ALBU, LISI], { regimen })
    const inhaled = result.find((g) => g.id === 'inhaled')
    expect(inhaled?.rows[0].asNeeded).toBe(true)
    expect(result.find((g) => g.id === 'mouth')?.rows[0].asNeeded).toBe(false)
    expect(result.some((g) => g.id === 'past')).toBe(false)
  })

  it('preserves the fold order inside a group rather than re-sorting', () => {
    const regimen = new Map<string, Regimen>([
      [key(ZOLP), { route: 'mouth' }],
      [key(AMOX), { route: 'mouth' }],
      [key(LISI), { route: 'mouth' }],
    ])
    // Seeded in non-alphabetical order; buildSummary sorts byLabel, and this
    // must pass that order straight through.
    const result = groups([ZOLP, AMOX, LISI], { regimen })
    expect(result[0].rows.map((r) => r.name)).toEqual(['Amoxicillin', 'Lisinopril', 'Zolpidem'])
  })

  it('titles the unrouted shelf for a pharmacist, not the owner', () => {
    const result = groups([LISI])
    expect(result[0].id).toBe('unrouted')
    expect(result[0].title).toBe(UNROUTED_TITLE)
  })

  it('drops empty groups and returns nothing for no meds', () => {
    expect(buildPharmacyGroups([])).toEqual([])
    const result = groups([LISI], { regimen: new Map([[key(LISI), { route: 'mouth' }]]) })
    expect(result.map((g) => g.id)).toEqual(['mouth'])
  })

  it('carries dose, sig and prescriber from the curated regimen', () => {
    const regimen = new Map<string, Regimen>([
      [
        key(LISI),
        {
          route: 'mouth',
          dose: '10 mg tablet',
          schedule: 'once daily',
          instructions: 'in the morning',
          prescriber: 'Dr. Anita Rao',
        },
      ],
    ])
    const row = groups([LISI], { regimen })[0].rows[0]
    expect(row.dose).toBe('10 mg tablet')
    expect(row.sig).toBe('once daily · in the morning')
    expect(row.prescriber).toBe('Dr. Anita Rao')
  })

  it('carries the coding that identifies the drug', () => {
    // The name is what a pharmacist reads; the code is what identifies it, and
    // for an entry nothing named it is the only identity the row has.
    // `buildSummary` has already shortened the system (shortenSystem), so the
    // row shows "RxNorm 29046" rather than the full URL.
    const row = groups([LISI])[0].rows[0]
    expect(row.code).toBe('RxNorm 29046')
  })

  it('leaves unrecorded fields empty', () => {
    const row = groups([LISI])[0].rows[0]
    expect(row.dose).toBe('')
    expect(row.sig).toBe('')
    expect(row.prescriber).toBe('')
    expect(row.asNeeded).toBe(false)
  })
})
