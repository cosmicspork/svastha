import { describe, expect, it } from 'vitest'
import {
  splitCsvLine,
  parseLoincCsv,
  parseRxnormConso,
  parseIcd10Order,
  dottedIcd10,
  parseCvx,
} from '../../../scripts/build-code-dictionary/parsers'

// Synthetic snippets only — no bulk real source files are committed as
// fixtures. Each snippet mirrors the real file's shape closely enough to pin
// the parsing rules (delimiter, column selection, code normalization).

describe('splitCsvLine', () => {
  it('handles quoted fields with commas and doubled-quote escapes', () => {
    expect(splitCsvLine('a,"b, c","d""e",f')).toEqual(['a', 'b, c', 'd"e', 'f'])
  })
})

describe('parseLoincCsv', () => {
  it('keys by LOINC_NUM and prefers the long common name', () => {
    const csv = ['LOINC_NUM,COMPONENT,LONG_COMMON_NAME', '2345-7,Glucose,"Glucose [Mass/volume] in Serum or Plasma"'].join(
      '\n',
    )
    expect(parseLoincCsv(csv)).toEqual({ '2345-7': 'Glucose [Mass/volume] in Serum or Plasma' })
  })

  it('falls back to the component column when no long common name exists', () => {
    const csv = ['LOINC_NUM,COMPONENT', '4548-4,Hemoglobin A1c'].join('\n')
    expect(parseLoincCsv(csv)).toEqual({ '4548-4': 'Hemoglobin A1c' })
  })

  it('throws when the header lacks a recognizable code/name column', () => {
    expect(() => parseLoincCsv('foo,bar\n1,2')).toThrow()
  })
})

describe('parseRxnormConso', () => {
  // RXNCONSO columns: 0 RXCUI | ... | 11 SAB | 12 TTY | ... | 14 STR | 15 | 16 SUPPRESS
  const row = (rxcui: string, sab: string, tty: string, str: string, suppress = 'N') =>
    [rxcui, 'ENG', '', '', '', '', '', '', '', '', '', sab, tty, rxcui, str, '', suppress, '4096', ''].join('|')

  it('picks the SCD name over an ingredient name for the same RXCUI', () => {
    const text = [
      row('617314', 'RXNORM', 'IN', 'atorvastatin'),
      row('617314', 'RXNORM', 'SCD', 'atorvastatin 10 MG Oral Tablet'),
    ].join('\n')
    expect(parseRxnormConso(text)).toEqual({ '617314': 'atorvastatin 10 MG Oral Tablet' })
  })

  it('ignores non-RxNorm sources and suppressed rows', () => {
    const text = [
      row('161', 'MTHSPL', 'SU', 'ACETAMINOPHEN'),
      row('161', 'RXNORM', 'IN', 'acetaminophen', 'O'),
      row('161', 'RXNORM', 'IN', 'acetaminophen'),
    ].join('\n')
    expect(parseRxnormConso(text)).toEqual({ '161': 'acetaminophen' })
  })
})

describe('dottedIcd10 / parseIcd10Order', () => {
  it('dots codes longer than three characters', () => {
    expect(dottedIcd10('A000')).toBe('A00.0')
    expect(dottedIcd10('E119')).toBe('E11.9')
    expect(dottedIcd10('A00')).toBe('A00')
  })

  it('parses the fixed-width order file and keeps category (level 0) codes', () => {
    // cols 1-5 order, 7-13 code, 15 level, 17-76 short desc (60), 78+ long desc.
    const short = 'Cholera'.padEnd(60)
    const line0 = `00001 ${'A00'.padEnd(7)} 0 ${short} Cholera`
    const short1 = 'Cholera due to Vibrio cholerae 01, biovar cholerae'.padEnd(60)
    const line1 = `00002 ${'A000'.padEnd(7)} 1 ${short1} Cholera due to Vibrio cholerae 01, biovar cholerae`
    expect(parseIcd10Order([line0, line1].join('\n'))).toEqual({
      A00: 'Cholera',
      'A00.0': 'Cholera due to Vibrio cholerae 01, biovar cholerae',
    })
  })
})

describe('parseCvx', () => {
  it('parses pipe-delimited rows, stripping a BOM, using the short description', () => {
    const text = ['﻿08     |Hep B, adolescent or pediatric|Hepatitis B vaccine||Active|False|2010/05/28', ''].join(
      '\n',
    )
    expect(parseCvx(text)).toEqual({ '08': 'Hep B, adolescent or pediatric' })
  })
})
