// On-device recognition for photographed and scanned pages, behind the
// {@link OcrEngine} shape `pdf.ts` already implements for digital PDFs.
//
// **Every asset is served from this origin.** tesseract.js defaults its worker
// to jsDelivr and its language data to a CDN; both are fetches of executable
// code and model data made from a page holding decrypted medical records, they
// tell a third party that this app is reading a document, and they break
// offline. `web/scripts/build-ocr-assets/build.ts` commits them under
// `public/ocr/` and every path below is local. If you change these, check the
// network panel — a silent fall back to the CDN is the failure to watch for.
//
// The recognizer is loaded dynamically so its ~10 MiB of assets never touch the
// initial bundle or the install precache (see `vite.config.ts`'s `globIgnores`).
import type { OcrEngine, OcrLine, OcrWord } from './ocr'
import { groupLines } from './ocr-layout'
import { assetsEnabled, ASSET_BASE } from './ocr-assets'

/** Recognition is CPU-heavy and a phone will thermally throttle on a long page;
 * this bounds a single call rather than letting the UI hang indefinitely. */
const RECOGNIZE_TIMEOUT_MS = 120_000

/** One recognized word as tesseract reports it. Its `bbox` is already in image
 * coordinates (origin top-left, y downward), which is the convention `ocr.ts`
 * standardizes on — no flip needed here, unlike the PDF path. */
interface TesseractWord {
  text: string
  confidence?: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

function isWord(w: unknown): w is TesseractWord {
  const word = w as Partial<TesseractWord> | null
  const b = word?.bbox
  return (
    typeof word?.text === 'string' &&
    !!b &&
    typeof b.x0 === 'number' &&
    typeof b.y0 === 'number' &&
    typeof b.x1 === 'number' &&
    typeof b.y1 === 'number'
  )
}

/**
 * Pull the word list out of a tesseract result.
 *
 * Deliberately shape-tolerant: tesseract.js has moved words between a flat
 * `data.words` and a nested `blocks → paragraphs → lines → words` tree across
 * majors, and silently returning nothing on an upgrade would look exactly like
 * "this page is blank" — which for a medical document is the wrong thing to
 * conclude quietly. Both shapes are read; neither being present is an error the
 * caller surfaces.
 */
export function wordsFromResult(data: unknown): OcrWord[] {
  const found: unknown[] = []

  const flat = (data as { words?: unknown })?.words
  if (Array.isArray(flat)) found.push(...flat)

  const blocks = (data as { blocks?: unknown })?.blocks
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      for (const para of (block as { paragraphs?: unknown[] })?.paragraphs ?? []) {
        for (const line of (para as { lines?: unknown[] })?.lines ?? []) {
          const words = (line as { words?: unknown[] })?.words
          if (Array.isArray(words)) found.push(...words)
        }
      }
    }
  }

  return found.filter(isWord).map((w) => ({
    text: w.text,
    x0: w.bbox.x0,
    x1: w.bbox.x1,
    y0: w.bbox.y0,
    y1: w.bbox.y1,
    // tesseract reports 0-100; OcrWord is 0-1.
    conf: typeof w.confidence === 'number' ? w.confidence / 100 : 0,
  }))
}

/** Thrown when recognition cannot run or produced nothing usable. Distinct from
 * an empty page so the UI can say "couldn't read this" honestly. */
export class OcrUnavailableError extends Error {}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OcrUnavailableError(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recognize one image into lines.
 *
 * Resolves **empty** for a page with no recoverable text. Callers must render
 * that as "couldn't read this page", never as "the page was blank" — the two
 * are indistinguishable from here and only one of them is safe to assume about
 * a medical record.
 */
export async function recognizeImage(bytes: Uint8Array, mime: string): Promise<OcrLine[]> {
  if (!(await assetsEnabled())) {
    throw new OcrUnavailableError('On-device reading is not switched on for this device.')
  }

  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', undefined, {
    // Every one of these is same-origin. The library's defaults are not.
    workerPath: `${ASSET_BASE}/worker.min.js`,
    corePath: ASSET_BASE,
    langPath: ASSET_BASE,
    // The language data is committed uncompressed, so do not look for a .gz.
    gzip: false,
  })

  try {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    const result = await withTimeout(
      worker.recognize(blob, undefined, { blocks: true }),
      RECOGNIZE_TIMEOUT_MS,
      'Reading this page took too long and was stopped.',
    )
    return groupLines(wordsFromResult(result?.data))
  } finally {
    // Always tear the worker down: it holds the wasm core and the language data
    // in memory, which is most of a phone's headroom.
    await worker.terminate().catch(() => {})
  }
}

/** An {@link OcrEngine} for photographed and scanned pages. Handles `image/*`
 * only; anything else resolves empty so a caller can try engines in order. */
export const imageOcrEngine: OcrEngine = {
  async recognize(bytes: Uint8Array, mime: string): Promise<OcrLine[]> {
    if (!mime.startsWith('image/')) return []
    return recognizeImage(bytes, mime)
  },
}
