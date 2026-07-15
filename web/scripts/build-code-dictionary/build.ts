// Generates the offline code-dictionary JSON files and their manifest from raw
// source files. Run with bun:
//
//   bun run web/scripts/build-code-dictionary/build.ts
//
// Raw sources live in an uncommitted `sources/` dir next to this script (see
// SOURCES.md for the exact downloads); the generated JSON under
// `web/public/dict/` IS committed and ships with the site. Regeneration is
// manual and documented — no network access here, so a broken or missing
// download fails loudly rather than silently shipping stale data.
//
// Missing source files are skipped with a warning EXCEPT LOINC: when the
// account-gated Top-2000 CSV is absent, a small starter dictionary is derived
// from the app's own curated LOINC codes (codes.ts) so the file and pipeline
// exist and are testable. SOURCES.md tracks the Top-2000 regeneration.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCvx, parseIcd10Order, parseLoincCsv, parseRxnormConso, type CodeMap } from './parsers.ts'
import { EXERCISE_ACTIVITY, EXERCISE_DURATION, BP_DIASTOLIC, VITALS } from '../../src/lib/codes.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SOURCES_DIR = join(SCRIPT_DIR, 'sources')
const OUT_DIR = join(SCRIPT_DIR, '..', '..', 'public', 'dict')

interface ManifestFile {
  system: string
  path: string
  bytes: number
  sha256: string
  entries: number
  label: string
  /** Shown (muted) under the Settings toggle. LOINC's is mandatory and exact
   * (see SOURCES.md / http://loinc.org/license); the rest are courtesy. */
  attribution: string
  /** True when this file is a placeholder derived from the app's own codes
   * rather than the full upstream release (currently only LOINC). */
  starter?: boolean
}

const LOINC_ATTRIBUTION =
  'This material contains content from LOINC (http://loinc.org). LOINC is copyright © ' +
  'Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) ' +
  'Committee and is available at no cost under the license at http://loinc.org/license. LOINC® ' +
  'is a registered United States trademark of Regenstrief Institute, Inc.'

/** One entry per system: how to find its source, parse it, and where to write
 * it. `source` is a matcher against the filenames in sources/ so a dated
 * download (e.g. `RxNorm_full_prescribe_07062026`) still resolves. */
interface Spec {
  system: string
  label: string
  out: string
  attribution: string
  /** Filename or substring to locate the source under sources/. */
  source: string
  parse: (text: string) => CodeMap
}

const SPECS: Spec[] = [
  {
    system: 'http://loinc.org',
    label: 'LOINC',
    out: 'loinc.json',
    attribution: LOINC_ATTRIBUTION,
    source: 'top2000', // e.g. Top2000CommonLOINCLabResults CSV; see SOURCES.md
    parse: parseLoincCsv,
  },
  {
    system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    label: 'RxNorm',
    out: 'rxnorm.json',
    attribution:
      'Courtesy of the U.S. National Library of Medicine (NLM/NIH). RxNorm Current ' +
      'Prescribable Content; no license required.',
    source: 'RXNCONSO',
    parse: parseRxnormConso,
  },
  {
    system: 'http://hl7.org/fhir/sid/icd-10-cm',
    label: 'ICD-10-CM',
    out: 'icd10cm.json',
    attribution:
      'ICD-10-CM is a U.S. public-domain code set maintained by CMS and the CDC/NCHS.',
    source: 'icd10cm-order',
    parse: parseIcd10Order,
  },
  {
    system: 'http://hl7.org/fhir/sid/cvx',
    label: 'CVX',
    out: 'cvx.json',
    attribution: 'CVX vaccine codes courtesy of the U.S. CDC.',
    source: 'cvx',
    parse: parseCvx,
  },
]

/** The starter LOINC dictionary: the app's own curated LOINC codes (vitals +
 * exercise), so loinc.json exists and the loader is exercisable before the
 * account-gated Top-2000 CSV is downloaded. */
function starterLoinc(): CodeMap {
  const out: CodeMap = {}
  const add = (code: string, display?: string) => {
    if (display) out[code] = display
  }
  for (const v of VITALS) add(v.loinc.code, v.loinc.display)
  add(BP_DIASTOLIC.code, BP_DIASTOLIC.display)
  add(EXERCISE_ACTIVITY.code, EXERCISE_ACTIVITY.display)
  add(EXERCISE_DURATION.code, EXERCISE_DURATION.display)
  return out
}

function findSource(match: string): string | null {
  if (!existsSync(SOURCES_DIR)) return null
  const lower = match.toLowerCase()
  const hit = readdirSync(SOURCES_DIR).find((f) => f.toLowerCase().includes(lower))
  return hit ? join(SOURCES_DIR, hit) : null
}

/** Stable-sorted, compact JSON so regenerated files diff cleanly. */
function serialize(map: CodeMap): string {
  const sorted: CodeMap = {}
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]
  return JSON.stringify(sorted)
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  const files: ManifestFile[] = []

  for (const spec of SPECS) {
    const srcPath = findSource(spec.source)
    let map: CodeMap
    let starter = false

    if (srcPath) {
      map = spec.parse(readFileSync(srcPath, 'utf8'))
    } else if (spec.system === 'http://loinc.org') {
      map = starterLoinc()
      starter = true
      console.warn(`! LOINC Top-2000 source not found — writing starter (${Object.keys(map).length} codes). See SOURCES.md.`)
    } else {
      console.warn(`! skipping ${spec.label}: no source matching "${spec.source}" in sources/`)
      continue
    }

    const json = serialize(map)
    writeFileSync(join(OUT_DIR, spec.out), json)
    const entries = Object.keys(map).length
    files.push({
      system: spec.system,
      path: spec.out,
      bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
      entries,
      label: spec.label,
      attribution: spec.attribution,
      ...(starter ? { starter: true } : {}),
    })
    console.log(`✓ ${spec.out}: ${entries} entries, ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB${starter ? ' (starter)' : ''}`)
  }

  const manifest = {
    // Date-stamped so a device can compare and offer an update without
    // decrypting anything — the manifest and files are public.
    version: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    files,
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`✓ manifest.json: version ${manifest.version}, ${files.length} files`)
}

main()
