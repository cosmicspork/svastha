// Assemble the self-hosted on-device OCR assets into web/public/ocr/.
//
// Run with: bun run scripts/build-ocr-assets/build.ts
//
// Why self-host at all: tesseract.js defaults `workerPath` to jsDelivr and its
// language data to a CDN. Both are fetches of *executable code and model data*
// made from a page that is holding decrypted medical records — an outbound
// request to a third party that reveals the app is doing OCR, and a supply-chain
// dependency on someone else's CDN for what the reader actually runs. It also
// breaks offline, which is the whole premise of a local-first app. So every
// asset is committed here, exactly the way the offline code dictionary is, and
// the manifest's SHA-256s are what the app verifies before enabling the feature.
//
// The output is committed to the repo (see web/public/dict/ for the precedent).
// Re-run this only to bump tesseract.js or the language data, and commit the
// manifest alongside the bytes.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(SCRIPT_DIR, '..', '..', 'public', 'ocr')
const NODE_MODULES = join(SCRIPT_DIR, '..', '..', 'node_modules')

/** tessdata_fast: the smaller of the two trained models. `tessdata_best` is
 * roughly four times the size for accuracy gains that do not survive the
 * approval loop this feeds — every finding is reviewed by the owner regardless,
 * and this is a multi-megabyte download on a phone.
 *
 * Pinned to a commit, not `main`: a branch ref means upstream retraining the
 * model silently changes what every device downloads next time this script
 * runs, with no diff to review. Bump the SHA deliberately when it matters. */
const TRAINEDDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd'
const TRAINEDDATA_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TRAINEDDATA_COMMIT}/eng.traineddata`

interface Asset {
  /** Filename under public/ocr/. */
  path: string
  /** Where it comes from: a node_modules path, or a URL. */
  from: { file: string } | { url: string }
  label: string
  /** What tesseract.js asks for this file as. */
  role: 'worker' | 'core' | 'lang' | 'notice'
}

// The core set is exactly what the vendored worker.min.js can request — see
// tesseract.js's worker-script/browser/getCore.js: with the LSTM-only OEM
// this app always uses (tessdata_fast has no legacy model), it feature-detects
// relaxed-SIMD, then plain SIMD, then falls back to no SIMD, and asks for the
// matching *-lstm.wasm.js file. Each is self-contained (wasm inlined as a data
// URL in the JS, no companion .wasm fetch) — that's the split-pair predecessor
// this replaces. The non-LSTM cores (`tesseract-core.wasm.js` etc.) exist in
// the same npm package but are never requested and are deliberately excluded;
// manifest.test.ts checks that exclusion against the worker's own byte code so
// this stays honest if tesseract.js's feature detection ever changes.
const CORE_ASSETS: Asset[] = [
  {
    path: 'tesseract-core-relaxedsimd-lstm.wasm.js',
    from: { file: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js' },
    label: 'Recognition core (relaxed SIMD)',
    role: 'core',
  },
  {
    path: 'tesseract-core-simd-lstm.wasm.js',
    from: { file: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js' },
    label: 'Recognition core (SIMD)',
    role: 'core',
  },
  {
    path: 'tesseract-core-lstm.wasm.js',
    from: { file: 'tesseract.js-core/tesseract-core-lstm.wasm.js' },
    label: 'Recognition core (no SIMD)',
    role: 'core',
  },
]

const ASSETS: Asset[] = [
  {
    path: 'worker.min.js',
    from: { file: 'tesseract.js/dist/worker.min.js' },
    label: 'Recognition worker',
    role: 'worker',
  },
  // Not fetched at runtime — attribution for the bundlers named in
  // worker.min.js's own header comment (line 1 points here).
  {
    path: 'worker.min.js.LICENSE.txt',
    from: { file: 'tesseract.js/dist/worker.min.js.LICENSE.txt' },
    label: 'Recognition worker bundled-dependency notices',
    role: 'notice',
  },
  ...CORE_ASSETS,
  {
    path: 'eng.traineddata',
    from: { url: TRAINEDDATA_URL },
    label: 'English language data',
    role: 'lang',
  },
  {
    path: 'TESSERACT_LICENSE.txt',
    from: { file: 'tesseract.js/LICENSE.md' },
    label: 'Tesseract.js licence',
    role: 'notice',
  },
  {
    path: 'TESSERACT_CORE_LICENSE.txt',
    from: { file: 'tesseract.js-core/LICENSE' },
    label: 'Tesseract core licence',
    role: 'notice',
  },
]

async function bytesFor(asset: Asset): Promise<Uint8Array> {
  if ('file' in asset.from) {
    return new Uint8Array(await readFile(join(NODE_MODULES, asset.from.file)))
  }
  const response = await fetch(asset.from.url)
  if (!response.ok) {
    throw new Error(`${asset.from.url} answered ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const files = []
  let total = 0
  for (const asset of ASSETS) {
    const bytes = await bytesFor(asset)
    await writeFile(join(OUT_DIR, asset.path), bytes)
    total += bytes.byteLength
    files.push({
      path: asset.path,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      label: asset.label,
      role: asset.role,
    })
    console.log(`  ${asset.path.padEnd(34)} ${(bytes.byteLength / 1024).toFixed(0).padStart(7)} KiB`)
  }

  const tesseractVersion = JSON.parse(
    await readFile(join(NODE_MODULES, 'tesseract.js/package.json'), 'utf8'),
  ).version

  const manifest = {
    version: tesseractVersion,
    generated_at: new Date().toISOString(),
    /** What the language data was built from, so a bump is traceable. */
    traineddata_source: TRAINEDDATA_URL,
    /** The tessdata_fast commit `traineddata_source` is pinned to. */
    traineddata_commit: TRAINEDDATA_COMMIT,
    files,
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`\n  ${(total / 1024 / 1024).toFixed(1)} MiB total, tesseract.js ${tesseractVersion}`)
}

await main()
