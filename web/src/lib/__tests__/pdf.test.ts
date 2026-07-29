import { describe, expect, it, vi, beforeEach } from 'vitest'

// pdf.js itself is the stub, never the functions under test: geometry,
// lifecycle and error mapping are all about how pdf.ts *uses* the library, so
// the library is where the seam belongs.
const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {} as { workerPort?: unknown },
}))
vi.mock('pdfjs-dist', () => pdfjs)
// pdf.ts wires a module worker the first time it loads the library; node has no
// Worker constructor and the wiring is not what these tests are about.
vi.stubGlobal('Worker', class {})

import { pageWordGroups, textLayer, textLayerPages, pdfTextEngine } from '../pdf'
import { UnreadablePageError } from '../ocr'

/** pdf.js's own viewport matrix for an upright page: flip y, origin top-left. */
const upright = (height: number) => [1, 0, 0, -1, 0, height]
/** ...and for a page carrying /Rotate 90, where the width/height swap and
 * content-space x becomes display-space y. Neither matrix is invented here;
 * both are what `page.getViewport({ scale: 1 })` reports. */
const ROTATED_90 = [0, 1, 1, 0, 0, 0]

/** A run drawn horizontally in content space. */
const run = (str: string, x: number, y: number, width: number) => ({
  str,
  width,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
})

/** A run drawn sideways, the way a page faxed in landscape and displayed
 * through /Rotate 90 carries it: the text matrix advances along content +y. */
const sideways = (str: string, x: number, y: number, width: number) => ({
  str,
  width,
  height: 10,
  transform: [0, 10, -10, 0, x, y],
})

/** A run set at a quarter turn to an otherwise upright page — the margin label
 * or side stamp a lab report puts down the edge of the sheet. */
const margin = (str: string, x: number, y: number, width: number) => ({
  str,
  width,
  height: 10,
  transform: [0, -10, 10, 0, x, y],
})

/** A watermark run on no axis at all. */
const diagonal = (str: string, x: number, y: number, width: number) => ({
  str,
  width,
  height: 10,
  transform: [10, -10, 10, 10, x, y],
})

/** One lab row: analyte and value sharing a baseline. */
const labRow = (analyte: string, value: string, baseline: number) => [
  run(analyte, 100, baseline, 60),
  run(value, 200, baseline, 20),
]

interface FakePage {
  items: unknown[]
  /** What `getViewport({ scale: 1 })` reports for this page. */
  viewport: { width: number; height: number; transform: number[] }
}

function stubDocument(pages: FakePage[], destroy = vi.fn(async () => {})) {
  const doc = {
    numPages: pages.length,
    getPage: vi.fn(async (n: number) => ({
      getViewport: () => pages[n - 1].viewport,
      getTextContent: async () => ({ items: pages[n - 1].items }),
    })),
    // Teardown lives on the loading task in pdf.js 6, not on the document.
    loadingTask: { destroy },
  }
  pdfjs.getDocument.mockImplementation(() => ({ promise: Promise.resolve(doc) }))
  return doc
}

/** An upright US-Letter page. */
const letter = (items: unknown[]): FakePage => ({
  items,
  viewport: { width: 612, height: 792, transform: upright(792) },
})

/** The same page with /Rotate 90: pdf.js swaps the reported width and height,
 * but the text items keep their content-stream transforms. */
const letterRotated = (items: unknown[]): FakePage => ({
  items,
  viewport: { width: 792, height: 612, transform: ROTATED_90 },
})

beforeEach(() => {
  pdfjs.getDocument.mockReset()
})

describe('pageWordGroups', () => {
  /** The upright reading stream — the page as a person holds it. */
  const uprightWords = (items: unknown[], transform: number[]) =>
    pageWordGroups(items, transform)[0] ?? []

  // pdf.js reports a bottom-up baseline; every other engine reports top-down.
  // Getting this backwards would silently invert the whole page's line order.
  it('flips pdf.js bottom-up baselines to top-down boxes', () => {
    const [word] = uprightWords([run('Potassium', 20, 700, 60)], upright(800))
    expect(word).toEqual({ text: 'Potassium', x0: 20, x1: 80, y0: 90, y1: 100, conf: 1 })
  })

  it('orders a page top-down after the flip', () => {
    const words = uprightWords([run('bottom', 0, 100, 10), run('top', 0, 700, 10)], upright(800))
    expect(words.map((w) => [w.text, w.y0])).toEqual([
      ['bottom', 690],
      ['top', 90],
    ])
  })

  it('skips marked-content items and blank runs', () => {
    const items = [{ type: 'beginMarkedContent' }, run('   ', 0, 700, 10), run('real', 0, 600, 10)]
    expect(uprightWords(items, upright(800)).map((x) => x.text)).toEqual(['real'])
  })

  // The viewport matrix carries the page's /Rotate; the item transforms do not.
  // Flipping against the (rotation-aware) viewport height while ignoring the
  // rotation puts every run outside the page band it belongs to.
  it('places a /Rotate 90 page in display space, not content space', () => {
    const [word] = uprightWords([sideways('Potassium', 500, 100, 60)], ROTATED_90)
    expect(word).toEqual({ text: 'Potassium', x0: 100, x1: 160, y0: 490, y1: 500, conf: 1 })
  })

  it("keeps a rotated page's rows apart and its columns ordered", () => {
    const words = uprightWords(
      [
        sideways('Potassium', 500, 100, 60),
        sideways('4.1', 500, 180, 20),
        sideways('Sodium', 480, 100, 60),
        sideways('139', 480, 180, 20),
      ],
      ROTATED_90,
    )
    // Same analyte row → same vertical band; the value sits to the right of it.
    expect(words.map((w) => [w.text, w.y0, w.x0])).toEqual([
      ['Potassium', 490, 100],
      ['4.1', 490, 180],
      ['Sodium', 470, 100],
      ['139', 470, 180],
    ])
  })

  // A quarter-turned run's display box is as tall as its text is long. Read in
  // its own frame it is what it looks like on paper: one short band.
  it('reads a quarter-turned run in its own frame', () => {
    const groups = pageWordGroups([margin('REFERENCE RANGE', 20, 620, 120)], upright(792))
    expect(groups).toEqual([
      [{ text: 'REFERENCE RANGE', x0: 0, x1: 120, y0: -30, y1: -20, conf: 1 }],
    ])
  })

  it('keeps each orientation in a group of its own, upright first', () => {
    const groups = pageWordGroups(
      [margin('SPECIMEN', 20, 620, 80), ...labRow('Sodium', '139', 602)],
      upright(792),
    )
    expect(groups.map((g) => g.map((w) => w.text))).toEqual([
      ['Sodium', '139'],
      ['SPECIMEN'],
    ])
  })

  // On no axis at all, so no orientation can read it as part of a line. Alone
  // in a group it still reaches the transcript and can merge nothing.
  it('gives an off-axis run a group to itself', () => {
    const groups = pageWordGroups(
      [...labRow('Sodium', '139', 602), diagonal('VOID', 100, 400, 60)],
      upright(792),
    )
    expect(groups.map((g) => g.map((w) => w.text))).toEqual([['Sodium', '139'], ['VOID']])
  })
})

describe('textLayer', () => {
  it('reads an upright page into lines', async () => {
    stubDocument([letter([run('Sodium', 20, 700, 60), run('139', 200, 700, 20)])])
    expect((await textLayer(new Uint8Array([1]))).map((l) => l.text)).toEqual(['Sodium 139'])
  })

  // The failure this whole module exists to prevent: a lab row split apart, so
  // a value can be paired with the wrong analyte.
  it("keeps a /Rotate 90 page's rows intact", async () => {
    stubDocument([
      letterRotated([
        sideways('Potassium', 500, 100, 60),
        sideways('4.1', 500, 180, 20),
        sideways('Sodium', 480, 100, 60),
        sideways('139', 480, 180, 20),
      ]),
    ])
    const lines = await textLayer(new Uint8Array([1]))
    expect(lines.map((l) => l.text)).toEqual(['Sodium 139', 'Potassium 4.1'])
  })

  // The regression the reviewer caught: a 90° margin run's display box is as
  // tall as its text is long, so an orientation-blind grouper takes it as the
  // band's anchor and every horizontal row it crosses collapses into it — one
  // line holding three analytes and three values, which is the mis-pairing this
  // module exists to prevent.
  it('keeps a 90° margin run from swallowing the lab rows it crosses', async () => {
    stubDocument([
      letter([
        margin('REFERENCE RANGE', 20, 620, 120),
        ...labRow('Sodium', '139', 602),
        ...labRow('Potassium', '4.1', 572),
        ...labRow('Chloride', '104', 542),
      ]),
    ])
    const lines = await textLayer(new Uint8Array([1]))
    expect(lines.map((l) => l.text)).toEqual([
      'Sodium 139',
      'Potassium 4.1',
      'Chloride 104',
      // Kept, and numbered after the page it sits beside: a side stamp can say
      // "AMENDED" and dropping it would be its own kind of wrong.
      'REFERENCE RANGE',
    ])
    expect(lines.map((l) => l.index)).toEqual([1, 2, 3, 4])
  })

  // A fax that arrived sideways with no /Rotate to correct it: every run is a
  // quarter turn off, and read in that turn's frame the page comes out whole.
  // Dropping non-horizontal runs would have made this page unreadable instead.
  it('reads a page whose whole text layer is sideways', async () => {
    stubDocument([
      letter([
        margin('Sodium', 120, 620, 60),
        margin('139', 120, 540, 20),
        margin('Potassium', 100, 620, 60),
        margin('4.1', 100, 540, 20),
      ]),
    ])
    const lines = await textLayer(new Uint8Array([1]))
    expect(lines.map((l) => l.text)).toEqual(['Sodium 139', 'Potassium 4.1'])
  })

  it('numbers lines continuously across pages', async () => {
    stubDocument([letter([run('one', 0, 700, 30)]), letter([run('two', 0, 700, 30)])])
    expect(await textLayer(new Uint8Array([1]))).toMatchObject([
      { index: 1, text: 'one' },
      { index: 2, text: 'two' },
    ])
  })

  it('destroys the document once the text is out', async () => {
    const destroy = vi.fn(async () => {})
    stubDocument([letter([run('one', 0, 700, 30)])], destroy)
    await textLayer(new Uint8Array([1]))
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the document when a page throws', async () => {
    const destroy = vi.fn(async () => {})
    const doc = stubDocument([letter([])], destroy)
    doc.getPage.mockRejectedValue(new Error('page 1 is broken'))
    await expect(textLayer(new Uint8Array([1]))).rejects.toThrow('page 1 is broken')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  // pdf.js's own wording ("No password given") reaches the user as a bug report.
  it("reports a password-protected PDF in the app's words", async () => {
    const err = Object.assign(new Error('No password given'), { name: 'PasswordException' })
    pdfjs.getDocument.mockImplementation(() => ({ promise: Promise.reject(err) }))
    await expect(textLayer(new Uint8Array([1]))).rejects.toBeInstanceOf(UnreadablePageError)
    await expect(textLayer(new Uint8Array([1]))).rejects.toThrow(/password/i)
  })

  it('reports a corrupt PDF as unreadable', async () => {
    const err = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })
    pdfjs.getDocument.mockImplementation(() => ({ promise: Promise.reject(err) }))
    await expect(textLayer(new Uint8Array([1]))).rejects.toBeInstanceOf(UnreadablePageError)
  })
})

describe('textLayerPages', () => {
  // The column render's character scale is per page, so the split has to
  // survive to the caller; the numbering stays document-wide, because that is
  // what a cited line number means.
  it('keeps pages apart while numbering lines across them', async () => {
    stubDocument([
      letter([run('one', 0, 700, 30), run('two', 0, 600, 30)]),
      letter([run('three', 0, 700, 30)]),
    ])
    const pages = await textLayerPages(new Uint8Array([1]))
    expect(pages.map((p) => p.map((l) => [l.index, l.text]))).toEqual([
      [
        [1, 'one'],
        [2, 'two'],
      ],
      [[3, 'three']],
    ])
  })
})

describe('pdfTextEngine', () => {
  it('handles PDFs only, so a caller can try engines in order', async () => {
    expect(await pdfTextEngine.recognize(new Uint8Array([1]), 'image/jpeg')).toEqual([])
    expect(await pdfTextEngine.recognizePages(new Uint8Array([1]), 'image/jpeg')).toEqual([])
    expect(pdfjs.getDocument).not.toHaveBeenCalled()
  })
})
