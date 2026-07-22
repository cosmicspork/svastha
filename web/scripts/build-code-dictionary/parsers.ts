// Pure per-source parsers for the offline code dictionary. Each takes the raw
// text of a source file and returns a flat `{ "<code>": "<name>" }` map keyed
// for direct lookup by the exact code string an event carries (see
// web/src/lib/code-names.ts's `keyFor`). No I/O here — build.ts does the
// reading/writing, these stay pure so the unit tests can exercise them against
// tiny synthetic snippets without committing bulk source files.

export type CodeMap = Record<string, string>

/** Split a single CSV line, honoring double-quoted fields with embedded commas
 * and doubled-quote escapes. Deliberately minimal — the LOINC exports we parse
 * are well-formed RFC-4180 and don't need a full streaming parser. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      out.push(field)
      field = ''
    } else {
      field += c
    }
  }
  out.push(field)
  return out
}

function normalizeLines(text: string): string[] {
  // Strip a UTF-8 BOM (CVX and some CDC exports carry one) and CRs so callers
  // never have to reason about \r\n vs \n or a leading ﻿.
  return text.replace(/^﻿/, '').split(/\r?\n/)
}

/** LOINC Top-2000 CSV -> `{ "<LOINC_NUM>": "<name>" }`. The export's exact
 * column set has drifted release to release, so this locates the code and name
 * columns by header rather than by fixed index: the code column is whichever
 * header reads like a LOINC number, the name column prefers the long common
 * name and falls back to the component. See SOURCES.md for the download. */
export function parseLoincCsv(text: string): CodeMap {
  const lines = normalizeLines(text).filter((l) => l.length > 0)
  if (lines.length === 0) return {}
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())

  const codeIdx = header.findIndex(
    (h) => h === 'loinc_num' || h === 'loinc #' || h === 'loinc' || h === 'loinc_number',
  )
  const nameCandidates = ['long_common_name', 'long common name', 'longname', 'component']
  let nameIdx = -1
  for (const cand of nameCandidates) {
    nameIdx = header.indexOf(cand)
    if (nameIdx !== -1) break
  }
  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error(`LOINC CSV: could not find code/name columns in header: ${header.join(', ')}`)
  }

  const out: CodeMap = {}
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    const code = (cols[codeIdx] ?? '').trim()
    // LONG_COMMON_NAME (or its fallbacks above) must be stored verbatim — the
    // LOINC license (Section 2) forbids changing field contents — so `.trim()`
    // here is only undoing CSV whitespace padding, never normalizing the text.
    const name = (cols[nameIdx] ?? '').trim()
    if (code && name) out[code] = name
  }
  return out
}

/** LOINC's full release table (`Loinc.csv`, from the Download API's zip) ->
 * `{ "<LOINC_NUM>": "<LONG_COMMON_NAME>" }`, filtered to COMMON_TEST_RANK 1-2000
 * — the Top 2000+ Lab Observations subset lives in the full table as a rank
 * column rather than a separate export when pulled via the API. See
 * loinc-api.ts for how the release zip is fetched and unzipped. */
function parseLoincTable(text: string, top2000: boolean): CodeMap {
  const lines = normalizeLines(text).filter((l) => l.length > 0)
  if (lines.length === 0) return {}
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())

  const codeIdx = header.indexOf('loinc_num')
  const nameIdx = header.indexOf('long_common_name')
  const rankIdx = header.indexOf('common_test_rank')
  if (codeIdx === -1 || nameIdx === -1 || (top2000 && rankIdx === -1)) {
    throw new Error(
      `LOINC full table: could not find LOINC_NUM/LONG_COMMON_NAME/COMMON_TEST_RANK in header: ${header.join(', ')}`,
    )
  }

  const out: CodeMap = {}
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    if (top2000) {
      const rank = Number((cols[rankIdx] ?? '').trim())
      if (!Number.isFinite(rank) || rank < 1 || rank > 2000) continue
    }
    const code = (cols[codeIdx] ?? '').trim()
    // Verbatim per the LOINC license (Section 2) — see parseLoincCsv above.
    const name = (cols[nameIdx] ?? '').trim()
    if (code && name) out[code] = name
  }
  return out
}

/** Every code in the release, deprecated ones included — an append-only vault
 * renders decades-old documents, and a named deprecated code beats an
 * "Unnamed entry" row. */
export function parseLoincFullTable(text: string): CodeMap {
  return parseLoincTable(text, false)
}

export function parseLoincFullTableTop2000(text: string): CodeMap {
  return parseLoincTable(text, true)
}

// TTY preference for picking one canonical name per RXCUI. Semantic clinical
// drug (SCD) and branded drug (SBD) full names are the most human-readable and
// what the task calls for; the component/pack/generic/ingredient forms are
// fallbacks so a concept that lacks an SCD/SBD still resolves to *something*.
const RXNORM_TTY_PRIORITY = [
  'SCD',
  'SBD',
  'GPCK',
  'BPCK',
  'SCDG',
  'SBDG',
  'SCDF',
  'SBDF',
  'SCDC',
  'SBDC',
  'PIN',
  'IN',
  'MIN',
  'BN',
  'PSN',
]

/** RxNorm RXNCONSO.rrf (pipe-delimited) -> `{ "<RXCUI>": "<name>" }`, one
 * canonical name per RXCUI. Restricted to RxNorm's own atoms (SAB=RXNORM) and
 * non-suppressed rows; among those, the highest-priority term type wins. */
export function parseRxnormConso(text: string): CodeMap {
  // RXNCONSO field positions (0-based): 0 RXCUI, 11 SAB, 12 TTY, 14 STR,
  // 16 SUPPRESS.
  const best = new Map<string, { rank: number; name: string }>()
  for (const line of normalizeLines(text)) {
    if (!line) continue
    const f = line.split('|')
    if (f[11] !== 'RXNORM') continue
    if (f[16] === 'O' || f[16] === 'Y' || f[16] === 'E') continue
    const rank = RXNORM_TTY_PRIORITY.indexOf(f[12])
    if (rank === -1) continue
    const rxcui = f[0]
    const name = f[14]
    if (!rxcui || !name) continue
    const cur = best.get(rxcui)
    if (!cur || rank < cur.rank) best.set(rxcui, { rank, name })
  }
  const out: CodeMap = {}
  for (const [rxcui, { name }] of best) out[rxcui] = name
  return out
}

/** ICD-10-CM code (no dot, as the CDC files carry it) -> the dotted form used
 * in FHIR/C-CDA imports (e.g. `A000` -> `A00.0`, `E119` -> `E11.9`). Events
 * arrive dotted (see summary.test.ts), so the dictionary must key dotted. */
export function dottedIcd10(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code
}

/** ICD-10-CM order file (`icd10cm-order-YYYY.txt`, fixed-width) ->
 * `{ "<dotted-code>": "<long description>" }`. Includes category/header rows
 * (level 0), not just billable leaves, so a category-level code still resolves.
 * Layout (1-based): cols 7-13 code, cols 78+ long description. */
export function parseIcd10Order(text: string): CodeMap {
  const out: CodeMap = {}
  for (const line of normalizeLines(text)) {
    if (line.length < 78) continue
    const code = line.slice(6, 13).trim()
    const longDesc = line.slice(77).trim()
    if (code && longDesc) out[dottedIcd10(code)] = longDesc
  }
  return out
}

/** CVX (CDC IIS `cvx.txt`, pipe-delimited, no header) ->
 * `{ "<CVX code>": "<short description>" }`. Columns: 0 code, 1 short
 * description, 2 full vaccine name, 3 notes, 4 status, 5 non-vaccine, 6 date. */
export function parseCvx(text: string): CodeMap {
  const out: CodeMap = {}
  for (const line of normalizeLines(text)) {
    if (!line.trim()) continue
    const f = line.split('|')
    const code = (f[0] ?? '').trim()
    const name = (f[1] ?? '').trim()
    if (code && name) out[code] = name
  }
  return out
}
