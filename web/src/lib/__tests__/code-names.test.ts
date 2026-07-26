import { describe, expect, it } from 'vitest'
import { buildCodeNameIndex, resolveDisplay } from '../code-names'
import type { StoredEvent } from '../events'
import type { EventKind, EventValue } from '../drafts'
import { LOINC, RXNORM, SNOMED, canonicalSystem, shortenSystem, type Code } from '../codes'

let nextId = 0
function ev(partial: { kind?: EventKind; code?: Code | null; value?: EventValue | null }): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: partial.kind ?? 'observation',
      code: partial.code ?? null,
      value: partial.value ?? null,
      effective_at: null,
      provenance: { source: 'import', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

const BMI_CODE = { system: LOINC, code: '39156-5' }

describe('buildCodeNameIndex', () => {
  it('indexes a display-bearing event so a display-less event of the same code resolves it', () => {
    const events = [ev({ code: { ...BMI_CODE, display: 'Body mass index (BMI) [Ratio]' } }), ev({ code: BMI_CODE })]
    const index = buildCodeNameIndex(events)
    expect(resolveDisplay(index, BMI_CODE)).toBe('Body mass index (BMI) [Ratio]')
  })

  it('indexes a coded value (event.value.coded), not just event.code', () => {
    const events = [ev({ value: { coded: { ...BMI_CODE, display: 'BMI' } } })]
    const index = buildCodeNameIndex(events)
    expect(resolveDisplay(index, BMI_CODE)).toBe('BMI')
  })

  it('picks the most frequent display when a code carries conflicting names', () => {
    const events = [
      ev({ code: { ...BMI_CODE, display: 'Body mass index (BMI) [Ratio]' } }),
      ev({ code: { ...BMI_CODE, display: 'BMI' } }),
      ev({ code: { ...BMI_CODE, display: 'BMI' } }),
    ]
    const index = buildCodeNameIndex(events)
    expect(resolveDisplay(index, BMI_CODE)).toBe('BMI')
  })

  it('breaks a frequency tie by shortest-then-lexicographic, independent of input order', () => {
    const forward = [
      ev({ code: { ...BMI_CODE, display: 'Body mass index (BMI) [Ratio]' } }),
      ev({ code: { ...BMI_CODE, display: 'BMI' } }),
    ]
    const reversed = [...forward].reverse()
    expect(resolveDisplay(buildCodeNameIndex(forward), BMI_CODE)).toBe('BMI')
    expect(resolveDisplay(buildCodeNameIndex(reversed), BMI_CODE)).toBe('BMI')
  })

  it('breaks an equal-length tie lexicographically', () => {
    const events = [ev({ code: { ...BMI_CODE, display: 'Bmi' } }), ev({ code: { ...BMI_CODE, display: 'BMI' } })]
    const index = buildCodeNameIndex(events)
    expect(resolveDisplay(index, BMI_CODE)).toBe('BMI') // 'BMI' < 'Bmi' lexicographically
  })

  it('has no entry for a code that never carries a display anywhere', () => {
    const events = [ev({ code: BMI_CODE }), ev({ code: BMI_CODE })]
    const index = buildCodeNameIndex(events)
    expect(resolveDisplay(index, BMI_CODE)).toBeNull()
  })

  it('resolveDisplay returns null for a null/undefined code', () => {
    const index = buildCodeNameIndex([])
    expect(resolveDisplay(index, null)).toBeNull()
    expect(resolveDisplay(index, undefined)).toBeNull()
  })
})

describe('resolveDisplay dictionary layering', () => {
  const key = `${LOINC}|39156-5`
  const CODE = { system: LOINC, code: '39156-5' }

  it('uses the dictionary when the vault index has nothing', () => {
    const dict = new Map([[key, 'Body mass index']])
    expect(resolveDisplay(new Map(), CODE, dict)).toBe('Body mass index')
  })

  it('prefers the vault index over the dictionary for the same code', () => {
    const index = new Map([[key, 'BMI (from my records)']])
    const dict = new Map([[key, 'Body mass index']])
    expect(resolveDisplay(index, CODE, dict)).toBe('BMI (from my records)')
  })

  it('returns null (raw fallback) when neither index nor dictionary names it', () => {
    expect(resolveDisplay(new Map(), CODE, new Map())).toBeNull()
    expect(resolveDisplay(new Map(), CODE)).toBeNull()
  })
})

describe('OID system canonicalization', () => {
  it('canonicalSystem maps known urn:oid and bare OIDs, passes others through', () => {
    expect(canonicalSystem('urn:oid:2.16.840.1.113883.6.88')).toBe(RXNORM)
    expect(canonicalSystem('2.16.840.1.113883.6.96')).toBe(SNOMED)
    expect(canonicalSystem(RXNORM)).toBe(RXNORM)
    expect(canonicalSystem('urn:oid:9.9.9')).toBe('urn:oid:9.9.9')
  })

  it('shortenSystem renders an acronym for an OID-form system instead of the raw urn', () => {
    expect(shortenSystem('urn:oid:2.16.840.1.113883.6.88')).toBe('RxNorm')
    expect(shortenSystem('urn:oid:2.16.840.1.113883.6.96')).toBe('SNOMED')
    // Unknown OID still degrades to the raw string (provenance, not reading).
    expect(shortenSystem('urn:oid:9.9.9')).toBe('urn:oid:9.9.9')
  })

  it('resolves an OID-coded med against a canonical-keyed dictionary', () => {
    const oidCode = { system: 'urn:oid:2.16.840.1.113883.6.88', code: '313782' }
    const dict = new Map([[`${RXNORM}|313782`, 'Acetaminophen 325 MG Oral Tablet']])
    expect(resolveDisplay(new Map(), oidCode, dict)).toBe('Acetaminophen 325 MG Oral Tablet')
  })

  it('a URL-coded event names its OID-coded twin through the vault index', () => {
    const events = [ev({ code: { system: RXNORM, code: '313782', display: 'Acetaminophen 325 MG' } })]
    const index = buildCodeNameIndex(events)
    const oidCode = { system: 'urn:oid:2.16.840.1.113883.6.88', code: '313782' }
    expect(resolveDisplay(index, oidCode)).toBe('Acetaminophen 325 MG')
  })
})
