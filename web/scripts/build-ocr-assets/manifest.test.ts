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
  traineddata_source: string
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

  it('include everything the recognizer asks for at runtime', () => {
    const byRole = (role: ManifestFile['role']) =>
      manifest.files.filter((f) => f.role === role).map((f) => f.path)

    expect(byRole('worker')).toEqual(['worker.min.js'])
    expect(byRole('lang')).toEqual(['eng.traineddata'])
    // Both core builds: tesseract feature-detects SIMD and asks for whichever
    // the browser supports, so shipping one would fail on the other.
    expect(byRole('core')).toContain('tesseract-core-simd-lstm.wasm')
    expect(byRole('core')).toContain('tesseract-core-lstm.wasm')
  })

  // Apache-2.0 for both, and the notices ride along the way the dictionary's
  // LOINC and SNOMED notices do.
  it('carry their licence texts', () => {
    expect(manifest.files.filter((f) => f.role === 'notice')).toHaveLength(2)
  })

  it('records where the language data came from, so a bump is traceable', () => {
    expect(manifest.traineddata_source).toMatch(/tessdata_fast/)
  })
})
