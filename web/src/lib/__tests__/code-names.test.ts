import { describe, expect, it } from 'vitest'
import { buildCodeNameIndex, resolveDisplay } from '../code-names'
import type { StoredEvent } from '../events'
import type { EventKind, EventValue } from '../drafts'
import { LOINC, type Code } from '../codes'

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
