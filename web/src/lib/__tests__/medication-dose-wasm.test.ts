// The `medication_dose` kind and the `dosage` value through the real compiled
// wasm: the TS shapes in drafts.ts must be what core decodes, signing one from
// the web must produce an event that verifies, and core's dosage rules must hold
// at this boundary too (an invalid dosage is refused, not signed).
//
// The wasm package is a build artifact (`bun run wasm`, gitignored); both
// `bun run check` and `bun run test` build it first.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { WasmIdentity, event_id, verify_event } from '../../wasm/svastha'

import { UCUM } from '../codes'
import type { Dosage, EventKind, EventValue } from '../drafts'
import type { StoredEvent } from '../events'

beforeAll(async () => {
  const wasm = fileURLToPath(new URL('../../wasm/svastha_bg.wasm', import.meta.url).href)
  await init({ module_or_path: readFileSync(wasm) })
})

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

/** The content `logEvent` hands `sign_event`. */
function content(kind: EventKind, value: EventValue) {
  return {
    kind,
    code: { system: RXNORM, code: '745679', display: null },
    effective_at: '2026-10-23T14:05:00-05:00',
    value,
    provenance: { source: 'self', source_doc: null },
  }
}

const twiceDaily: Dosage = {
  dose: { value: '500', unit: { system: UCUM, code: 'mg' } },
  frequency: '2',
  period: '1',
  period_unit: 'd',
  as_needed: false,
}

describe('medication_dose and dosage across the wasm boundary', () => {
  it('signs a medication_dose from the web and the signature verifies', () => {
    const id = WasmIdentity.generate()
    const json = id.sign_event(JSON.stringify(content('medication_dose', { quantity: { value: '2', unit: { system: UCUM, code: '{puff}' } } })))
    const signed = JSON.parse(json) as StoredEvent
    expect(signed.event.kind).toBe('medication_dose')
    expect(verify_event(json)).toBe(true)

    const relabelled = { ...signed, event: { ...signed.event, kind: 'medication_statement' } }
    expect(verify_event(JSON.stringify(relabelled))).toBe(false)
  })

  it('signs a dosage value and serializes every field back', () => {
    const id = WasmIdentity.generate()
    const json = id.sign_event(JSON.stringify(content('medication_statement', { dosage: twiceDaily })))
    expect(verify_event(json)).toBe(true)
    const value = (JSON.parse(json) as StoredEvent).event.value
    expect(value).toEqual({
      dosage: {
        ...twiceDaily,
        dose: { value: '500', unit: { system: UCUM, code: 'mg', display: null } },
        text: null,
        when: null,
      },
    })
  })

  it('refuses to sign a dosage core would not decode', () => {
    const id = WasmIdentity.generate()
    const bad: unknown[] = [
      {},
      { text: '' },
      { period: '1', period_unit: 'min' },
      { period: '1', period_unit: 'H' },
      { frequency: '1.5' },
      { frequency: '٣' },
      { period: '1e3', period_unit: 'h' },
      { period: '1' },
    ]
    for (const dosage of bad) {
      expect(() => id.sign_event(JSON.stringify(content('medication_statement', { dosage } as EventValue))), JSON.stringify(dosage)).toThrow()
    }
  })

  it('reproduces every pinned event vector id', () => {
    const path = fileURLToPath(new URL('../../../../spec/vectors/event.json', import.meta.url).href)
    const vectors = JSON.parse(new TextDecoder().decode(readFileSync(path))) as { events: { event: StoredEvent['event']; id_hex: string }[] }
    const kinds = new Set(vectors.events.map((v) => v.event.kind))
    expect(kinds.has('medication_dose')).toBe(true)
    expect(vectors.events.some((v) => v.event.value && 'dosage' in v.event.value)).toBe(true)
    for (const v of vectors.events) {
      expect(event_id(JSON.stringify(v.event))).toBe(v.id_hex)
    }
  })
})
