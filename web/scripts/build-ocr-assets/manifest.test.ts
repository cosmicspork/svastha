import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The manifest's checksums are what the app verifies before switching on-device
// reading on. A committed asset that no longer matches its entry would fail at
// enable time, in front of a user, with no way to tell a bad deploy from a
// tampered one — so it fails here instead, on every CI run.
//
// Lives in scripts/ rather than src/ because it reads the committed bytes off
// disk, and only this tsconfig has Node types (see vitest.config.ts's include).

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OCR_DIR = join(SCRIPT_DIR, '..', '..', 'public', 'ocr')

interface ManifestFile {
  path: string
  bytes: number
  sha256: string
  label: string
  role: 'worker' | 'core' | 'lang' | 'notice'
}

interface Manifest {
  version: string
  revision: string
  traineddata_source: string
  traineddata_commit: string
  files: ManifestFile[]
}

const manifest = JSON.parse(readFileSync(join(OCR_DIR, 'manifest.json'), 'utf8')) as Manifest

describe('the committed OCR assets', () => {
  it('match their manifest entries byte for byte', () => {
    for (const file of manifest.files) {
      const bytes = readFileSync(join(OCR_DIR, file.path))
      expect(bytes.byteLength, `${file.path} size`).toBe(file.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), `${file.path} sha256`).toBe(
        file.sha256,
      )
    }
  })

  // This is the check that would have caught PR #154 dead on arrival: the
  // worker only ever imports a core file by name (see tesseract.js's
  // worker-script/browser/getCore.js), so asking the worker's own bytes what
  // it requests — rather than asserting a hand-picked file list — is the only
  // way this test can't drift out of sync with what actually ships.
  it('include every core file the vendored worker.min.js can request', () => {
    const workerSource = readFileSync(join(OCR_DIR, 'worker.min.js'), 'utf8')
    const requested = [...new Set(workerSource.match(/tesseract-core[a-z.-]*/g) ?? [])]
    // A change to worker.min.js that stops referencing any core by name would
    // make this test vacuously pass — guard against that silent no-op.
    expect(requested.length).toBeGreaterThan(0)

    const vendored = new Set(manifest.files.filter((f) => f.role === 'core').map((f) => f.path))

    // tessdata_fast is LSTM-only, and this app never asks for the legacy
    // engine, so tesseract.js's OEM.LSTM_ONLY path (see getCore.js) never
    // requests these — the *-lstm variants below are the only ones reachable.
    const deliberatelyExcluded = new Set([
      'tesseract-core.wasm.js',
      'tesseract-core-simd.wasm.js',
      'tesseract-core-relaxedsimd.wasm.js',
    ])

    for (const name of requested) {
      expect(vendored.has(name) || deliberatelyExcluded.has(name), name).toBe(true)
    }
  })

  it('has a worker and a language file', () => {
    const byRole = (role: ManifestFile['role']) =>
      manifest.files.filter((f) => f.role === role).map((f) => f.path)

    expect(byRole('worker')).toEqual(['worker.min.js'])
    expect(byRole('lang')).toEqual(['eng.traineddata'])
  })

  // Apache-2.0/MIT/BSD across tesseract.js, tesseract.js-core, and the
  // bundled dependencies worker.min.js's own header points at; the notices
  // ride along the way the dictionary's LOINC and SNOMED notices do.
  it('carry their licence texts', () => {
    expect(manifest.files.filter((f) => f.role === 'notice')).toHaveLength(3)
  })

  it('records where the language data came from, pinned to a commit so a retrain upstream cannot silently change it', () => {
    expect(manifest.traineddata_source).toMatch(/tessdata_fast/)
    expect(manifest.traineddata_source).toContain(manifest.traineddata_commit)
    expect(manifest.traineddata_commit).toMatch(/^[0-9a-f]{40}$/)
  })

  // `version` is the tesseract.js package version, which does not change just
  // because the vendored file *set* does — see this PR's own history: the
  // core files changed under the same "7.0.0". A device compares this digest,
  // not `version`, before trusting already-verified assets (see
  // `ocr-assets.ts`'s `assetsEnabled`), so it has to move whenever any
  // vendored file does.
  it('has a revision digest over the file set, independent of the tesseract.js package version', () => {
    expect(manifest.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.revision).not.toBe(manifest.version)

    const recomputed = createHash('sha256')
      .update(
        JSON.stringify(
          manifest.files
            .map((f) => ({ path: f.path, sha256: f.sha256 }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ),
      )
      .digest('hex')
    expect(manifest.revision).toBe(recomputed)
  })
})
