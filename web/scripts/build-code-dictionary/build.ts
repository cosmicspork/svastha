// Generates the offline code-dictionary JSON files and their manifest from raw
// source files. Run with bun:
//
//   bun run web/scripts/build-code-dictionary/build.ts
//
// Raw sources live in an uncommitted `sources/` dir next to this script (see
// SOURCES.md for the exact downloads); the generated JSON under
// `web/public/dict/` IS committed and ships with the site. Regeneration is
// manual and documented — no network access here (except LOINC, below), so a
// broken or missing download fails loudly rather than silently shipping stale
// data.
//
// Missing source files are skipped with a warning EXCEPT LOINC: when neither
// the API nor a manual CSV is available, a small starter dictionary is derived
// from the app's own curated LOINC codes (codes.ts) so the file and pipeline
// exist and are testable. SOURCES.md tracks the LOINC setup.
//
// LOINC is fetched automatically via the Download API
// (https://loinc.regenstrief.org/api/v1) when LOINC_USERNAME/LOINC_PASSWORD
// are set (Bun auto-loads a `.env` next to this command's cwd — see
// SOURCES.md). The API is polled at most once a day (its own etiquette) and
// only downloads when the release is newer than what's cached. Missing
// credentials, or any API/network error, fall back to a manual CSV (below)
// and finally to the starter dictionary — this step must never fail the whole
// build.
//
// A manually downloaded "Top 2000+ Lab Observations" CSV remains a fallback
// for offline/no-credentials use:
//
//   LOINC_TOP2000_CSV=/path/to/Top2000CommonLOINCLabResults.csv LOINC_RELEASE=2.80 bun run scripts/build-code-dictionary/build.ts
//   bun run scripts/build-code-dictionary/build.ts --loinc-csv=/path/to/file.csv --loinc-release=2.80
//
// or drop it in sources/ (matched by the "top2000" substring). The release
// identifier is optional but strongly recommended: the LOINC license (Section
// 9) requires a version on every copy, and the API path supplies it
// automatically — the manual path can't derive it from the CSV alone.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseCvx,
  parseIcd10Order,
  parseLoincCsv,
  parseLoincFullTableTop2000,
  parseRxnormConso,
  type CodeMap,
} from './parsers.ts'
import { downloadLoincRelease, extractLoincCsv, fetchLoincMeta, loincBasicAuth, type LoincApiMeta } from './loinc-api.ts'
import { EXERCISE_ACTIVITY, EXERCISE_DURATION, BP_DIASTOLIC, VITALS } from '../../src/lib/codes.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SOURCES_DIR = join(SCRIPT_DIR, 'sources')
const OUT_DIR = join(SCRIPT_DIR, '..', '..', 'public', 'dict')
const MANIFEST_PATH = join(OUT_DIR, 'manifest.json')

// LOINC API poll cache — lives under sources/ (already wholly gitignored) so
// the release zip/CSV and the "last checked" timestamp never reach a commit.
const LOINC_CACHE_DIR = join(SOURCES_DIR, '.loinc-cache')
const LOINC_CACHE_CSV = join(LOINC_CACHE_DIR, 'Loinc.csv')
const LOINC_CACHE_META = join(LOINC_CACHE_DIR, 'meta.json')
const LOINC_POLL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

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
  /** LOINC's release/version, required by the license (Section 9) on every
   * copy. Present whenever loinc.json is real (non-starter) data, whether it
   * came from the API (automatic) or a manual CSV (via --loinc-release). */
  loincRelease?: string
}

const LOINC_ATTRIBUTION =
  'This material contains content from LOINC (http://loinc.org). LOINC is copyright © ' +
  'Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) ' +
  'Committee and is available at no cost under the license at http://loinc.org/license. LOINC® ' +
  'is a registered United States trademark of Regenstrief Institute, Inc.'

/** One entry per system: how to find its source, parse it, and where to write
 * it. `source` is a matcher against the filenames in sources/ so a dated
 * download (e.g. `RxNorm_full_prescribe_07062026`) still resolves. LOINC has
 * no `source`/`parse` here — it's handled specially in main() (API first,
 * manual CSV fallback, starter last). */
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
    source: 'top2000', // manual-CSV fallback only; see fetchLoincDictionary()
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
 * API/manual CSV path has real data. */
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

/** Manual-CSV override: an explicit --loinc-csv=/LOINC_TOP2000_CSV path takes
 * priority over the sources/ substring match. An explicit path that doesn't
 * exist is a typo, not "not supplied" — warn distinctly rather than silently
 * falling through. */
function findLoincSource(): string | null {
  const flagPrefix = '--loinc-csv='
  const flag = process.argv.find((a) => a.startsWith(flagPrefix))
  const explicit = flag ? flag.slice(flagPrefix.length) : process.env.LOINC_TOP2000_CSV
  if (explicit) {
    if (existsSync(explicit)) return explicit
    console.warn(`! LOINC source "${explicit}" (from --loinc-csv/LOINC_TOP2000_CSV) does not exist — ignoring.`)
  }
  return findSource('top2000')
}

function resolveLoincRelease(): string | undefined {
  const flagPrefix = '--loinc-release='
  const flag = process.argv.find((a) => a.startsWith(flagPrefix))
  return flag ? flag.slice(flagPrefix.length) : (process.env.LOINC_RELEASE ?? undefined)
}

function loadPriorManifest(): { files: ManifestFile[] } | null {
  if (!existsSync(MANIFEST_PATH)) return null
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { files: ManifestFile[] }
  } catch {
    return null
  }
}

interface LoincCacheState {
  checkedAt: string
  meta: LoincApiMeta
}

function loadLoincCache(): LoincCacheState | null {
  if (!existsSync(LOINC_CACHE_META)) return null
  try {
    return JSON.parse(readFileSync(LOINC_CACHE_META, 'utf8')) as LoincCacheState
  } catch {
    return null
  }
}

function saveLoincCache(state: LoincCacheState): void {
  mkdirSync(LOINC_CACHE_DIR, { recursive: true })
  writeFileSync(LOINC_CACHE_META, JSON.stringify(state, null, 2))
}

/** API-driven LOINC ingestion. Polls /Loinc at most once a day (LOINC's own
 * best-practice etiquette) and only downloads+extracts when the release is
 * newer than what's cached or than `priorRelease` (the release already baked
 * into the committed manifest). Returns null — never throws — on missing
 * credentials or any API/network/verification failure, so the caller can fall
 * back to the manual CSV or the starter dictionary without failing the build. */
async function fetchLoincViaApi(priorRelease: string | undefined): Promise<{ csv: string; release: string } | null> {
  const user = process.env.LOINC_USERNAME
  const pass = process.env.LOINC_PASSWORD
  if (!user || !pass) {
    console.warn('! LOINC_USERNAME/LOINC_PASSWORD not set — skipping the LOINC API.')
    return null
  }
  const auth = loincBasicAuth(user, pass)

  const cache = loadLoincCache()
  const now = Date.now()
  if (cache && now - Date.parse(cache.checkedAt) < LOINC_POLL_MIN_INTERVAL_MS && existsSync(LOINC_CACHE_CSV)) {
    console.log(`  LOINC: checked the API less than a day ago (release ${cache.meta.version}) — reusing the cache.`)
    return { csv: readFileSync(LOINC_CACHE_CSV, 'utf8'), release: cache.meta.version }
  }

  let meta: LoincApiMeta
  try {
    meta = await fetchLoincMeta(auth)
  } catch (err) {
    console.warn(`! LOINC API metadata request failed — falling back. (${(err as Error).message})`)
    return null
  }
  saveLoincCache({ checkedAt: new Date().toISOString(), meta })

  if (priorRelease === meta.version && existsSync(LOINC_CACHE_CSV)) {
    console.log(`  LOINC: already on the current release (${meta.version}) — skipping download.`)
    return { csv: readFileSync(LOINC_CACHE_CSV, 'utf8'), release: meta.version }
  }

  try {
    const zipBytes = await downloadLoincRelease(meta, auth)
    const csv = extractLoincCsv(zipBytes)
    mkdirSync(LOINC_CACHE_DIR, { recursive: true })
    writeFileSync(LOINC_CACHE_CSV, csv)
    return { csv, release: meta.version }
  } catch (err) {
    console.warn(`! LOINC API download/extract failed — falling back. (${(err as Error).message})`)
    return null
  }
}

/** Resolves loinc.json's contents in priority order: API, then manual CSV,
 * then the starter dictionary. Never throws for a missing/failed source —
 * only a genuinely corrupt CSV (parseLoincCsv/parseLoincFullTableTop2000
 * throwing on an unrecognized header) escapes, which is the same "fail loudly
 * on a broken download" behavior the other code sets get. */
async function fetchLoincDictionary(
  priorRelease: string | undefined,
): Promise<{ map: CodeMap; starter: boolean; release?: string }> {
  const api = await fetchLoincViaApi(priorRelease)
  if (api) return { map: parseLoincFullTableTop2000(api.csv), starter: false, release: api.release }

  const manualPath = findLoincSource()
  if (manualPath) {
    const release = resolveLoincRelease()
    if (!release) {
      console.warn(
        '! LOINC manual CSV has no --loinc-release/LOINC_RELEASE — the LOINC license (Section 9) requires a ' +
          'version on every copy. The manifest will ship without one until you supply it.',
      )
    }
    return { map: parseLoincCsv(readFileSync(manualPath, 'utf8')), starter: false, release }
  }

  const map = starterLoinc()
  console.warn(`! LOINC not available (no API credentials/manual CSV) — writing starter (${Object.keys(map).length} codes). See SOURCES.md.`)
  return { map, starter: true }
}

/** Stable-sorted, compact JSON so regenerated files diff cleanly. */
function serialize(map: CodeMap): string {
  const sorted: CodeMap = {}
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]
  return JSON.stringify(sorted)
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const files: ManifestFile[] = []
  const priorManifest = loadPriorManifest()
  const priorLoinc = priorManifest?.files.find((f) => f.system === 'http://loinc.org' && !f.starter)

  for (const spec of SPECS) {
    let map: CodeMap
    let starter = false
    let loincRelease: string | undefined

    if (spec.system === 'http://loinc.org') {
      const result = await fetchLoincDictionary(priorLoinc?.loincRelease)
      map = result.map
      starter = result.starter
      loincRelease = result.release
    } else {
      const srcPath = findSource(spec.source)
      if (!srcPath) {
        console.warn(`! skipping ${spec.label}: no source matching "${spec.source}" in sources/`)
        continue
      }
      map = spec.parse(readFileSync(srcPath, 'utf8'))
    }

    const json = serialize(map)
    writeFileSync(join(OUT_DIR, spec.out), json)
    const entries = Object.keys(map).length
    const attribution =
      spec.system === 'http://loinc.org' && !starter && loincRelease
        ? `${spec.attribution} Top 2000+ release ${loincRelease}.`
        : spec.attribution
    files.push({
      system: spec.system,
      path: spec.out,
      bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
      entries,
      label: spec.label,
      attribution,
      ...(starter ? { starter: true } : {}),
      ...(loincRelease ? { loincRelease } : {}),
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
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`✓ manifest.json: version ${manifest.version}, ${files.length} files`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
