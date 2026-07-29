// Lazy pdf.js loader and a tiny render-to-canvas facade. pdf.js is multi-MB and
// only the (rare) PDF viewing path needs it, so the library and its worker are
// dynamically imported the first time a PDF is opened — the initial bundle
// stays free of it. The facade keeps AttachmentViewer/PdfDoc dumb (no pdf.js
// types leak into components) and makes the module trivially mockable in tests.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { UnreadablePageError, type OcrEngine, type OcrLine, type OcrWord } from './ocr'
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

/**
 * Open the document, with pdf.js's failures translated into this app's.
 *
 * `PasswordException` and friends otherwise reach the UI as library wording
 * ("No password given"), which reads as a bug rather than as something the
 * owner can act on. Matched by `name`: the exception classes are not part of
 * pdf.js's public entry, and this module only ever holds the library behind a
 * dynamic import.
 */
async function openDocument(pdfjs: Pdfjs, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  try {
    // Copied because pdf.js may detach the buffer it is handed, and the caller
    // keeps the originals for the download fallback.
    return await pdfjs.getDocument({ data: bytes.slice() }).promise
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'PasswordException') {
      throw new UnreadablePageError(
        'This PDF is locked with a password, which Svastha cannot unlock. Save an unlocked copy from wherever you can open it, and attach that instead.',
      )
    }
    throw new UnreadablePageError(
      "Couldn't read this PDF — the file looks damaged, incomplete, or is not a PDF at all.",
    )
  }
}

/** An opened PDF: its page count and a per-page render onto a caller-owned
 * canvas, fit to `cssWidth`. Components hold only this shape. */
export interface OpenedPdf {
  numPages: number
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>
}

/** Open a PDF from its plaintext bytes. Rejects with an {@link
 * UnreadablePageError} on a locked or corrupt PDF (or with the import's own
 * error), which the component turns into its download-instead fallback. The
 * returned document lives as long as the viewer holds it. */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs()
  const doc = await openDocument(pdfjs, bytes)
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
  /** pdf.js's 6-element affine matrix, in *content-stream* space: it carries
   * the text matrix but never the page's `/Rotate`. `[4]`/`[5]` are the run's
   * origin (x, baseline). */
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

/** `m1 ∘ m2`, i.e. pdf.js's `Util.transform`. Inlined so the geometry below
 * stays a pure function: the library is multi-MB and dynamically imported, and
 * these six multiplications are not worth loading it for. */
function compose(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

/** A direction as a unit vector; zero-length (a degenerate text matrix) becomes
 * no displacement rather than NaN. */
function unit(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y)
  return length > 0 ? [x / length, y / length] : [0, 0]
}

/** The quarter turns a baseline can sit on, as display-space unit vectors (y
 * downward), indexed by turn. */
const TURN_COS = [1, 0, -1, 0]
const TURN_SIN = [0, 1, 0, -1]

/** How far a baseline may sit off a quarter turn and still be read as part of
 * that turn's stream. A generated text layer's matrices are exact, so this is
 * slack for converter noise only — and deliberately tight: a run admitted at a
 * wider angle keeps part of its length in its vertical band, which is the
 * mechanism this whole split exists to defuse. */
const TURN_SLACK_RAD = (2 * Math.PI) / 180

/** Which quarter turn a baseline sits on, or `null` for a run on no axis at
 * all (a diagonal watermark). */
function quarterTurn(ax: number, ay: number): number | null {
  const angle = Math.atan2(ay, ax)
  const turns = Math.round(angle / (Math.PI / 2))
  if (Math.abs(angle - turns * (Math.PI / 2)) > TURN_SLACK_RAD) return null
  return ((turns % 4) + 4) % 4
}

/** Slide a group's frame so it starts at x = 0. Once the frame is not the
 * page's, its coordinates are synthetic — and left where they fall (a half turn
 * puts them at negative x) they would stretch the horizontal extent a column
 * render scales against, flattening the upright table on the same page. */
function shiftToOrigin(words: OcrWord[]): OcrWord[] {
  const minX = Math.min(...words.map((w) => w.x0))
  return words.map((w) => ({ ...w, x0: w.x0 - minX, x1: w.x1 - minX }))
}

/**
 * Positioned runs from one page's embedded text layer, grouped by the
 * orientation of their baselines: the upright reading stream first, then each
 * quarter turn present, then any off-axis run on its own.
 *
 * `viewportTransform` is `page.getViewport({ scale: 1 }).transform`, and it is
 * the only thing that knows about the page's `/Rotate`: a text item's own
 * transform is the content-stream matrix, which carries no rotation at all.
 * Composing the two is what makes a faxed or portal-rotated page come out
 * upright — flipping against the viewport's (rotation-aware) *height* instead
 * lands every run outside its band, which reaches the reader as a lab value
 * paired with the wrong analyte.
 *
 * **Why groups and not one list.** A box is axis-aligned, so a quarter-turned
 * run's box is as tall as its text is long: a margin label down the side of a
 * lab report spans every row it passes, and a grouper that reads bands of
 * vertical overlap will take it as the anchor and merge those rows into one
 * line. Each group is therefore measured in the frame its own baseline is
 * horizontal in, where a run's box is the band the text actually occupies, and
 * only runs that share an orientation are ever compared. Nothing is dropped:
 * a side stamp can say "AMENDED", and an off-axis run alone in its group can
 * still be read and cited while being unable to merge anything.
 *
 * Within a group, output is top-down (y grows downward), matching what image
 * engines report, so `ocr-layout.ts` never sees two conventions.
 *
 * Confidence is 1: an embedded text layer is what the document says, not a
 * guess at it.
 */
export function pageWordGroups(items: unknown[], viewportTransform: number[]): OcrWord[][] {
  // A run's width and height are user-space magnitudes, so they follow the
  // viewport's scale but not its rotation.
  const scale = Math.hypot(viewportTransform[0], viewportTransform[1]) || 1
  const byTurn = new Map<number, OcrWord[]>()
  const offAxis: OcrWord[][] = []

  for (const item of items) {
    if (!isPositionedText(item)) continue
    const text = item.str
    if (text.trim() === '') continue

    const m = compose(viewportTransform, item.transform)
    const [ax, ay] = unit(m[0], m[1])
    const [ux, uy] = unit(m[2], m[3])
    const advance = item.width * scale
    const rise = item.height * scale
    const corners: [number, number][] = [
      [m[4], m[5]],
      [m[4] + ax * advance, m[5] + ay * advance],
      [m[4] + ux * rise, m[5] + uy * rise],
      [m[4] + ax * advance + ux * rise, m[5] + ay * advance + uy * rise],
    ]

    // Measure in the frame this run reads horizontally in: for the upright
    // stream that is display space unchanged.
    const turn = quarterTurn(ax, ay)
    const [cos, sin] = turn === null ? [ax, ay] : [TURN_COS[turn], TURN_SIN[turn]]
    const xs = corners.map(([x, y]) => x * cos + y * sin)
    const ys = corners.map(([x, y]) => y * cos - x * sin)
    const word: OcrWord = {
      text,
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      conf: 1,
    }

    if (turn === null) {
      offAxis.push([word])
      continue
    }
    const group = byTurn.get(turn)
    if (group) group.push(word)
    else byTurn.set(turn, [word])
  }

  return [
    ...[...byTurn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turn, words]) => (turn === 0 ? words : shiftToOrigin(words))),
    ...offAxis.map(shiftToOrigin),
  ]
}

/**
 * Read a PDF's embedded text layer, one array of lines per page.
 *
 * Resolves **empty** for a scanned PDF — pages of images carry no text layer,
 * and that is the honest answer here rather than something to paper over. A
 * caller that wants those pages read has to rasterize them through a
 * recognition engine; this path is exact precisely because it never guesses.
 *
 * Pages stay separate because a column render's character scale is per page:
 * flattened, one page's full-bleed rule sets the horizontal extent for every
 * other page and collapses their tables. Line numbering is nevertheless
 * continuous across pages, so a citation identifies a line in the document
 * rather than a page-relative position that repeats.
 */
export async function textLayerPages(bytes: Uint8Array): Promise<OcrLine[][]> {
  const pdfjs = await loadPdfjs()
  const doc = await openDocument(pdfjs, bytes)

  try {
    const pages: OcrLine[][] = []
    let numbered = 0
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      // One grouping pass per orientation: `groupLines` compares vertical
      // bands, which only means the same thing within a single orientation.
      const lines = pageWordGroups(content.items, viewport.transform).flatMap((words) =>
        groupLines(words),
      )
      // groupLines numbers from 1 per group; renumber onto the running total.
      pages.push(lines.map((line) => ({ ...line, index: ++numbered })))
    }
    return pages
  } finally {
    // The document holds a copy of the bytes and the worker caches every page
    // it has parsed; on a phone that is tab-kill territory for a long report.
    // Teardown is the loading task's, not the document's, since pdf.js 6.
    await doc.loadingTask.destroy().catch(() => {})
  }
}

/** The same text layer as one run of lines, for callers that do not lay the
 * page out. */
export async function textLayer(bytes: Uint8Array): Promise<OcrLine[]> {
  return (await textLayerPages(bytes)).flat()
}

/** An {@link OcrEngine} that can also say where its pages divide — needed
 * because anything that renders columns has to scale them per page. */
export interface PagedOcrEngine extends OcrEngine {
  recognizePages(bytes: Uint8Array, mime: string): Promise<OcrLine[][]>
}

/** An {@link OcrEngine} over the embedded text layer. Handles `application/pdf`
 * only; anything else resolves empty, so a caller can try engines in order. */
export const pdfTextEngine: PagedOcrEngine = {
  async recognize(bytes: Uint8Array, mime: string): Promise<OcrLine[]> {
    if (mime !== 'application/pdf') return []
    return textLayer(bytes)
  },
  async recognizePages(bytes: Uint8Array, mime: string): Promise<OcrLine[][]> {
    if (mime !== 'application/pdf') return []
    return textLayerPages(bytes)
  },
}
