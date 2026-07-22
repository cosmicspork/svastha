import { describe, expect, it } from 'vitest'
import {
  splitCsvLine,
  parseLoincCsv,
  parseLoincFullTable,
  parseLoincFullTableTop2000,
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

  // The real "Top 2000+ LOINC Lab Observations" download (account-gated at
  // loinc.org/downloads, so not fetchable here) publishes a stripped-down
  // 3-column CSV — LOINC_NUM, LONG_COMMON_NAME, ORDER_OBS — per LOINC's own
  // Mapper's Guide to the Top 2000+ Lab Observations. This fixture mirrors
  // that exact column layout (fabricated codes/names, ≤5 rows) so the parser
  // is pinned against the real file's shape, not just a minimal 2-column one.
  it('parses the real Top-2000 export column layout (LOINC_NUM, LONG_COMMON_NAME, ORDER_OBS)', () => {
    const csv = [
      'LOINC_NUM,LONG_COMMON_NAME,ORDER_OBS',
      '2345-7,"Glucose [Mass/volume] in Serum or Plasma",Both',
      '2160-0,"Creatinine [Mass/volume] in Serum or Plasma",Both',
      '718-7,"Hemoglobin [Mass/volume] in Blood",Both',
      '2951-2,"Sodium [Moles/volume] in Serum or Plasma",Observation',
    ].join('\n')
    expect(parseLoincCsv(csv)).toEqual({
      '2345-7': 'Glucose [Mass/volume] in Serum or Plasma',
      '2160-0': 'Creatinine [Mass/volume] in Serum or Plasma',
      '718-7': 'Hemoglobin [Mass/volume] in Blood',
      '2951-2': 'Sodium [Moles/volume] in Serum or Plasma',
    })
  })
})

describe('parseLoincFullTableTop2000', () => {
  // The full LOINC release table (Loinc.csv, from the Download API's zip)
  // carries far more columns than this — this fixture keeps only the three
  // the parser reads (LOINC_NUM, LONG_COMMON_NAME, COMMON_TEST_RANK), per the
  // documented LOINC table schema (COMMON_TEST_RANK ranks the Top-2000+ set;
  // see LOINC's usage/frequency documentation at loinc.org/usage/obs).
  const csv = [
    'LOINC_NUM,LONG_COMMON_NAME,COMMON_TEST_RANK',
    '2345-7,"Glucose [Mass/volume] in Serum or Plasma",1',
    '2160-0,"Creatinine [Mass/volume] in Serum or Plasma",2',
    '99999-9,"Some rarely ordered test",5000',
    '88888-8,"Not ranked",',
  ].join('\n')

  it('keeps only rows ranked 1-2000, mapping LOINC_NUM to the verbatim long common name', () => {
    expect(parseLoincFullTableTop2000(csv)).toEqual({
      '2345-7': 'Glucose [Mass/volume] in Serum or Plasma',
      '2160-0': 'Creatinine [Mass/volume] in Serum or Plasma',
    })
  })

  it('throws when the header lacks LOINC_NUM/LONG_COMMON_NAME/COMMON_TEST_RANK', () => {
    expect(() => parseLoincFullTableTop2000('LOINC_NUM,LONG_COMMON_NAME\n1,2')).toThrow()
  })
})

describe('parseLoincFullTable', () => {
  it('keeps every code regardless of rank, including unranked rows', () => {
    const csv = [
      'LOINC_NUM,LONG_COMMON_NAME,COMMON_TEST_RANK',
      '2345-7,"Glucose [Mass/volume] in Serum or Plasma",1',
      '99999-9,"Some rarely ordered test",5000',
      '88888-8,"Not ranked",',
    ].join('\n')
    expect(parseLoincFullTable(csv)).toEqual({
      '2345-7': 'Glucose [Mass/volume] in Serum or Plasma',
      '99999-9': 'Some rarely ordered test',
      '88888-8': 'Not ranked',
    })
  })

  it('tolerates a table without COMMON_TEST_RANK, unlike the top-2000 filter', () => {
    expect(parseLoincFullTable('LOINC_NUM,LONG_COMMON_NAME\n1-1,Name')).toEqual({ '1-1': 'Name' })
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
