// Read one page with the browser's on-device reader and print its transcript.
//
// Invoked by `cargo run -p svastha-devtool -- accuracy`; prints one JSON array
// of line strings on **stdout** and nothing else, with progress on stderr.
//
// ## Why this drives a real browser
//
// The thing being scored is the reader the app actually ships: tesseract.js,
// loading the vendored assets under `web/public/ocr` by URL, with the lines
// assembled by `ocr-layout.ts`'s `groupLines`. None of that is reproducible
// outside a browser — tesseract.js loads a *different* worker under Node than
// the `worker.min.js` committed for the web, and the whole point of the
// vendored set is that those exact bytes are what runs. So this serves
// `web/public` over loopback, loads the app's own module into Chromium, and
// asks it to read the page. A Node-side reimplementation would score something
// this project does not ship.
//
// It also goes through `enableAssets()` rather than reaching past it, so the
// SHA-256 verification the app performs before switching the reader on is part
// of what gets exercised here.
//
// Usage: `bun run scripts/accuracy/read-page.ts <path-to-image>` from `web/`.
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from '@playwright/test'
import { withTimeout } from './timeout.ts'

/** The one Bun-specific API this script uses: its bundler, to turn the app's
 * TypeScript modules (and the `tesseract.js` bare import inside them) into one
 * browser script. Declared locally rather than pulling in `@types/bun` for a
 * single call — every other script in `scripts/` is node-API-only, and this
 * keeps the `tsconfig.scripts.json` type surface that way. */
declare const Bun: {
  build(options: {
    entrypoints: string[]
    target: 'browser'
    format: 'iife'
  }): Promise<{
    success: boolean
    logs: unknown[]
    outputs: { text(): Promise<string> }[]
  }>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')
const PUBLIC = join(WEB, 'public')

/** Bounds one page. The in-browser recognizer has its own 120s timeout; this is
 * the outer stop so a wedged browser cannot hang the whole harness run. */
const PAGE_TIMEOUT_MS = 180_000

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** Content types for the vendored assets. `worker.min.js` is loaded through
 * `importScripts`, and Chromium refuses to execute a classic worker script
 * served without a JavaScript type — so this map is load-bearing, not
 * cosmetic. */
const ASSET_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
}

/** The browser-side entry, generated rather than committed.
 *
 * Written at run time and handed to the bundler as a path so it is never an
 * `import` any TypeScript project in this repo can see: `tsconfig.scripts.json`
 * has no DOM lib, and a committed file that pulled `ocr-engine.ts` into that
 * project would fail `bun run check` on every DOM reference in the app code it
 * reaches. Bundling by path keeps the app modules typechecked where they
 * already are — by `tsconfig.app.json` — and out of the scripts project. */
const ENTRY = `
import { recognizeImage } from ${JSON.stringify(join(WEB, 'src/lib/ocr-engine.ts'))}
import { enableAssets } from ${JSON.stringify(join(WEB, 'src/lib/ocr-assets.ts'))}
globalThis.__accuracy = { recognizeImage, enableAssets }
`

async function bundleReader(work: string): Promise<string> {
  await writeFile(join(work, 'entry.ts'), ENTRY)
  const built = await Bun.build({
    entrypoints: [join(work, 'entry.ts')],
    target: 'browser',
    format: 'iife',
  })
  if (!built.success) {
    throw new Error(`could not bundle the reader: ${built.logs.map(String).join('\n')}`)
  }
  return built.outputs[0].text()
}

async function main(): Promise<void> {
  const image = process.argv[2]
  if (image === undefined || image === '') {
    throw new Error('usage: read-page.ts <path-to-image>')
  }
  const mime = MIME[extname(image).toLowerCase()]
  if (mime === undefined) throw new Error(`unsupported page type: ${extname(image)}`)

  const work = await mkdtemp(join(tmpdir(), 'svastha-accuracy-'))
  try {
    const bundle = await bundleReader(work)
    const pageBytes = await readFile(image)

    // A same-origin server, because that is the condition the vendored assets
    // exist to satisfy: `ocr-assets.ts` fetches `/ocr/...` by absolute path and
    // verifies each file's hash before the reader is allowed to run.
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><meta charset="utf-8"><script>${bundle}</script>`)
        return
      }
      if (path === '/page') {
        res.writeHead(200, { 'content-type': mime })
        res.end(pageBytes)
        return
      }
      // Confined to public/: this serves whatever the page asks for, and the
      // page is under test, so a traversal must not be able to read the repo.
      const target = normalize(join(PUBLIC, path))
      if (!target.startsWith(PUBLIC)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      readFile(target).then(
        (bytes) => {
          const type = ASSET_MIME[extname(target).toLowerCase()]
          res.writeHead(200, type === undefined ? {} : { 'content-type': type })
          res.end(bytes)
        },
        () => {
          res.writeHead(404)
          res.end('not found')
        },
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    let browser: Browser | undefined
    try {
      browser = await chromium.launch()
      const page = await browser.newPage()
      page.setDefaultTimeout(PAGE_TIMEOUT_MS)
      await page.goto(`http://127.0.0.1:${port}/`)

      const lines: string[] = await withTimeout(
        page.evaluate(
        `(async () => {
           const { recognizeImage, enableAssets } = globalThis.__accuracy
           // The real opt-in, hashes and all — not a flag flipped past it.
           await enableAssets()
           const bytes = new Uint8Array(await (await fetch('/page')).arrayBuffer())
           const read = await recognizeImage(bytes, ${JSON.stringify(mime)})
           return read.map((l) => l.text).filter((t) => t !== '')
         })()`,
        ),
        PAGE_TIMEOUT_MS,
        'browser reader timed out before it returned a transcript',
      )

      // stdout carries the transcript and nothing else — the Rust side parses
      // it whole.
      console.log(JSON.stringify(lines))
    } finally {
      try {
        await browser?.close()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

await main()
