// Thin client for LOINC's Download API (https://loinc.regenstrief.org/api/v1),
// used by build.ts to fetch the current Top-2000-bearing release automatically
// when LOINC_USERNAME/LOINC_PASSWORD are set, instead of requiring a manually
// downloaded CSV. Kept separate from build.ts so the pure pieces (zip
// extraction, MD5 verification) are unit-testable without hitting the network
// or touching the filesystem — build.ts owns the orchestration (env vars,
// polling cache, fallback to the manual CSV or starter dictionary).
//
// Credentials are never logged: callers pass an already-built `Authorization`
// header value, and errors here carry only HTTP status / hash-mismatch text.

import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'

export const LOINC_API_BASE = 'https://loinc.regenstrief.org/api/v1'

export interface LoincApiMeta {
  version: string
  releaseDate: string
  numberOfLoincs: number
  downloadUrl: string
  downloadMD5Hash: string
}

/** Basic auth header value for the given credentials. Never log the result. */
export function loincBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** GET /Loinc — the current release's metadata (or a specific one with
 * `version`; the API 404s on an unknown version). Throws on any non-2xx;
 * callers decide whether to fall back rather than fail the build. */
export async function fetchLoincMeta(auth: string, version?: string): Promise<LoincApiMeta> {
  const url = new URL(`${LOINC_API_BASE}/Loinc`)
  if (version) url.searchParams.set('version', version)
  const res = await fetch(url, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`LOINC API /Loinc: HTTP ${res.status}`)
  return (await res.json()) as LoincApiMeta
}

/** Downloads the release archive from `meta.downloadUrl` and verifies it
 * against the API-reported MD5 before returning it — the one integrity check
 * between "the API told us this hash" and "these are the bytes the dictionary
 * gets built from". Throws (rather than returning corrupt bytes) on a fetch
 * failure or hash mismatch. */
export async function downloadLoincRelease(meta: LoincApiMeta, auth: string): Promise<Uint8Array> {
  const res = await fetch(meta.downloadUrl, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`LOINC API download: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const md5 = createHash('md5').update(bytes).digest('hex')
  if (md5.toLowerCase() !== meta.downloadMD5Hash.toLowerCase()) {
    throw new Error('LOINC release download failed MD5 verification against the API-reported hash')
  }
  return bytes
}

/** Pulls the release table out of the zip. The current release layout nests
 * it as `LoincTable/Loinc.csv`; matched by suffix (rather than the exact path)
 * so a future re-nesting doesn't silently break this. */
export function extractLoincCsv(zipBytes: Uint8Array): string {
  const files = unzipSync(zipBytes)
  const path = Object.keys(files).find((p) => /(^|\/)Loinc\.csv$/i.test(p))
  if (!path) {
    throw new Error(`LOINC release zip: no Loinc.csv entry found (saw: ${Object.keys(files).join(', ')})`)
  }
  return strFromU8(files[path])
}
