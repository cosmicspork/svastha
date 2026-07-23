// Lazy pdf.js loader and a tiny render-to-canvas facade. pdf.js is multi-MB and
// only the (rare) PDF viewing path needs it, so the library and its worker are
// dynamically imported the first time a PDF is opened — the initial bundle
// stays free of it. The facade keeps AttachmentViewer/PdfDoc dumb (no pdf.js
// types leak into components) and makes the module trivially mockable in tests.
import type { PDFDocumentProxy } from 'pdfjs-dist'

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
