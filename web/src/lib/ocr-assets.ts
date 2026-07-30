// The default-on preference for on-device page reading, and the integrity check
// behind it.
// The recognizer's assets are ~10 MiB, committed under `public/ocr/` and
// excluded from the install precache (`vite.config.ts`'s `globIgnores`), so a
// first install stays small. A reader checks every runtime file against the
// manifest's SHA-256 before it runs — the same posture the offline code
// dictionary takes, for the same reason: this is executable code and model data
// that will read medical records, so "it downloaded" is not the same as "it is
// what we shipped".
//
// Unlike the dictionary, the bytes are not copied into IndexedDB. tesseract
// fetches its worker, core, and language data *by URL*, so they have to be
// reachable as ordinary same-origin requests; the verification pass warms the
// HTTP cache as a side effect. Reliable offline use after enabling would need a
// runtime-caching rule in the service worker — see the roadmap.
import { get, put } from './db'

/** Where the committed assets are served from. Same-origin, always. */
export const ASSET_BASE = '/ocr'

const MANIFEST_URL = `${ASSET_BASE}/manifest.json`
const ENABLED_PREF = 'ocr-enabled'
const MANIFEST_PREF = 'ocr-manifest'

export interface OcrManifestFile {
  path: string
  bytes: number
  sha256: string
  label: string
  role: 'worker' | 'core' | 'lang' | 'notice'
}

export interface OcrManifest {
  version: string
  /** SHA-256 over the vendored file set (path + hash of each), distinct from
   * `version` — the tesseract.js package version doesn't change just because
   * the file *set* under it does. This is what a device's verified state is
   * checked against. */
  revision: string
  generated_at: string
  traineddata_source: string
  files: OcrManifestFile[]
}

/** Thrown when a fetched asset's bytes don't hash to the manifest's `sha256`.
 * Carries the entry so the UI can name the file rather than failing generically. */
export class OcrVerificationError extends Error {
  constructor(public readonly file: OcrManifestFile) {
    super(`${file.label} failed to verify — the downloaded bytes don't match the expected checksum.`)
    this.name = 'OcrVerificationError'
  }
}

/** Thrown when an asset's fetch itself fails (offline, non-2xx). */
export class OcrFetchError extends Error {
  constructor(
    public readonly file: OcrManifestFile,
    reason: string,
  ) {
    super(`${file.label}: ${reason}`)
    this.name = 'OcrFetchError'
  }
}

/** Lowercase-hex SHA-256, duplicated the same way `dictionary.ts` duplicates it. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function loadManifest(): Promise<OcrManifest> {
  const response = await fetch(MANIFEST_URL)
  if (!response.ok) throw new Error(`The reader's file list answered ${response.status}.`)
  return (await response.json()) as OcrManifest
}

/** Bytes a verified download must cover — what the UI shows as the size. */
export function downloadBytes(manifest: OcrManifest): number {
  return manifest.files.filter((f) => f.role !== 'notice').reduce((n, f) => n + f.bytes, 0)
}

/**
 * Fetch and verify every runtime asset, reporting progress by completed bytes.
 *
 * Licence texts are shipped for attribution and skipped here — they are not
 * loaded at runtime, so making a user wait on them would be theatre.
 */
export async function verifyAssets(
  manifest: OcrManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const runtime = manifest.files.filter((f) => f.role !== 'notice')
  const total = runtime.reduce((n, f) => n + f.bytes, 0)
  let done = 0

  for (const file of runtime) {
    let response: Response
    try {
      response = await fetch(`${ASSET_BASE}/${file.path}`)
    } catch {
      throw new OcrFetchError(file, 'could not be downloaded.')
    }
    if (!response.ok) throw new OcrFetchError(file, `download answered ${response.status}.`)

    const bytes = new Uint8Array(await response.arrayBuffer())
    if ((await sha256Hex(bytes)) !== file.sha256) throw new OcrVerificationError(file)

    done += file.bytes
    onProgress?.(done, total)
  }
}

/** Page reading is available by default; only an explicit device-local opt-out
 * turns it off. This does not claim the reader is ready — `assetsEnabled`
 * separately requires a verified current manifest revision. */
export async function pageReadingEnabled(): Promise<boolean> {
  return (await get<boolean>('prefs', ENABLED_PREF)) !== false
}

/**
 * Whether on-device reading may run: its preference is enabled and the
 * currently-shipped assets are the ones this device verified.
 *
 * A device that enabled this before a deploy swapped the underlying files —
 * same manifest `version`, different `revision`, as happened once already —
 * must not read as ready: `recognizeImage` would fetch and execute whatever's
 * now served at those URLs without ever checking it against the new
 * manifest's hashes. Reports not-enabled rather than throwing if the current
 * manifest can't even be reached — a device that cannot confirm what's
 * shipped has nothing to trust either way. Re-enabling (Settings) is what
 * runs `verifyAssets` again against the new revision.
 */
export async function assetsEnabled(): Promise<boolean> {
  if (!(await pageReadingEnabled())) return false
  try {
    const manifest = await loadManifest()
    return (await verifiedRevision()) === manifest.revision
  } catch {
    return false
  }
}

/** The manifest revision this device verified, if any — compared against the
 * currently-shipped manifest's `revision` by {@link assetsEnabled}. */
export async function verifiedRevision(): Promise<string | null> {
  return (await get<string>('prefs', MANIFEST_PREF)) ?? null
}

/**
 * Verify the assets and make the reader ready. Throws without recording a
 * revision if any file fails — a half-verified reader is never usable.
 */
export async function enableAssets(onProgress?: (done: number, total: number) => void): Promise<void> {
  const manifest = await loadManifest()
  await verifyAssets(manifest, onProgress)
  await put('prefs', manifest.revision, MANIFEST_PREF)
  await put('prefs', true, ENABLED_PREF)
}

/** Switch it off. The committed assets stay where they are — they are part of
 * the deployed app, not a download this can delete — so this only stops the
 * reader being used. */
export async function disableAssets(): Promise<void> {
  await put('prefs', false, ENABLED_PREF)
}
