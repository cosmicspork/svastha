// Lazy pdf.js loader and a tiny render-to-canvas facade. pdf.js is multi-MB and
// only the (rare) PDF viewing path needs it, so the library and its worker are
// dynamically imported the first time a PDF is opened — the initial bundle
// stays free of it. The facade keeps AttachmentViewer/PdfDoc dumb (no pdf.js
// types leak into components) and makes the module trivially mockable in tests.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OcrLine, OcrWord } from './ocr'
import { groupLines } from './ocr-layout'

// The css-px ceiling and device-pixel-ratio cap that bound a rendered page's
// backing canvas. A phone canvas is memory-limited (iOS especially kills tabs
// that allocate too much canvas), so cap both the logical width and the retina
// multiplier rather than rendering at the raw device resolution of a full page.
const MAX_CSS_WIDTH = 1600
const MAX_DPR = 2

type Pdfjs = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<Pdfjs> | null = null

/** Import pdf.js once and wire its worker. `new Worker(new URL(...))` is the
 * form Vite recognizes to emit the worker as its own chunk (so it precaches for
 * offline use); `workerPort` hands that module worker straight to pdf.js. */
function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(
        new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
        { type: 'module' },
      )
      return pdfjs
    })
  }
  return pdfjsPromise
}

/** An opened PDF: its page count and a per-page render onto a caller-owned
 * canvas, fit to `cssWidth`. Components hold only this shape. */
export interface OpenedPdf {
  numPages: number
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>
}

/** Open a PDF from its plaintext bytes. Copies the bytes because pdf.js may
 * detach the buffer it is handed, and the caller keeps the originals for the
 * download fallback. Rejects on a corrupt/unreadable PDF (or a failed import),
 * which the component turns into its download-instead fallback. */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs()
  const doc: PDFDocumentProxy = await pdfjs.getDocument({ data: bytes.slice() }).promise
  return {
    numPages: doc.numPages,
    async renderPage(pageNumber, canvas, cssWidth) {
      const page = await doc.getPage(pageNumber)
      const width = Math.min(cssWidth, MAX_CSS_WIDTH)
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const unscaled = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: (width / unscaled.width) * dpr })

      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      // CSS size is the logical width; the extra backing pixels are the retina
      // sharpening the dpr factor bought.
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not get a 2D canvas context.')
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
    },
  }
}

// --- text layer -------------------------------------------------------------

/** A pdf.js text item, narrowed to the fields the text layer needs. pdf.js also
 * emits marked-content items with no `str`/`transform`, which are skipped. */
interface PositionedText {
  str: string
  width: number
  height: number
  /** pdf.js's 6-element affine matrix; `[4]` is x and `[5]` the baseline y. */
  transform: number[]
}

function isPositionedText(item: unknown): item is PositionedText {
  const it = item as Partial<PositionedText> | null
  return (
    typeof it?.str === 'string' &&
    typeof it.width === 'number' &&
    typeof it.height === 'number' &&
    Array.isArray(it.transform) &&
    it.transform.length >= 6 &&
    typeof it.transform[4] === 'number' &&
    typeof it.transform[5] === 'number'
  )
}

/**
 * Positioned runs from one page's embedded text layer.
 *
 * pdf.js reports PDF coordinates: origin at the bottom-left, y growing upward,
 * and `transform[5]` is the *baseline*, not the top. Every other engine reports
 * image coordinates, so this flips to top-down here rather than leaking two
 * conventions into `ocr-layout.ts`.
 *
 * Confidence is 1: an embedded text layer is what the document says, not a
 * guess at it.
 */
export function pageWords(items: unknown[], pageHeight: number): OcrWord[] {
  const words: OcrWord[] = []
  for (const item of items) {
    if (!isPositionedText(item)) continue
    const text = item.str
    if (text.trim() === '') continue
    const x0 = item.transform[4]
    const baseline = item.transform[5]
    words.push({
      text,
      x0,
      x1: x0 + item.width,
      y0: pageHeight - (baseline + item.height),
      y1: pageHeight - baseline,
      conf: 1,
    })
  }
  return words
}

/**
 * Read a PDF's embedded text layer into lines, all pages in order.
 *
 * Returns **empty** for a scanned PDF — pages of images carry no text layer, and
 * that is the honest answer here rather than something to paper over. A caller
 * that wants those pages read has to rasterize them through a recognition
 * engine; this path is exact precisely because it never guesses.
 *
 * Line numbering is continuous across pages, so a citation identifies a line in
 * the document rather than a page-relative position that repeats.
 */
export async function textLayer(bytes: Uint8Array): Promise<OcrLine[]> {
  const pdfjs = await loadPdfjs()
  const doc: PDFDocumentProxy = await pdfjs.getDocument({ data: bytes.slice() }).promise

  const lines: OcrLine[] = []
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber)
    const height = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const pageLines = groupLines(pageWords(content.items, height))
    // Renumber onto the running total; groupLines numbers from 1 per page.
    for (const line of pageLines) {
      lines.push({ ...line, index: lines.length + 1 })
    }
  }
  return lines
}

/** An {@link OcrEngine} over the embedded text layer. Handles `application/pdf`
 * only; anything else resolves empty, so a caller can try engines in order. */
export const pdfTextEngine = {
  async recognize(bytes: Uint8Array, mime: string): Promise<OcrLine[]> {
    if (mime !== 'application/pdf') return []
    return textLayer(bytes)
  },
}
