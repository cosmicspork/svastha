// Stage A of reading a document: turning a page into positioned text.
//
// Splitting "read the page" from "code what it says" is what makes the second
// half checkable. A single vision pass that both reads and codes a lab panel can
// assert "Potassium 14.2" with nothing to compare against; once stage A has
// produced ground truth with coordinates, a coded finding can be verified
// against the line it claims to come from. That guard lands with the extractor;
// this module is the ground truth it will check against.
//
// One interface, several engines over time:
//
//   1. **The PDF text layer** (`pdf.ts`'s `textLayer`) — exact, free, no model
//      and no download. Most portal-issued lab reports are digital PDFs, so
//      this covers a large slice on its own.
//   2. **A recognition engine** for photographed and scanned pages, added later
//      behind this same shape.
//   3. **Native OS text recognition** when the app gains a wrapper.
//
// Coordinates are **top-down** (y grows downward, origin at the page's top-left)
// for every engine, because that is what image-based recognizers report; the PDF
// path flips pdf.js's bottom-up coordinates to match rather than leaking two
// conventions into the layout code.

/** A positioned piece of text.
 *
 * "Word" is the engine-neutral name, but a PDF text layer emits *runs* — a run
 * may hold several words and its own spaces. That is a feature here: a table
 * cell is usually one run, so run-level boxes align columns better than
 * splitting them apart would. */
export interface OcrWord {
  text: string
  /** Left and right edges, in page units. */
  x0: number
  x1: number
  /** Top and bottom edges, y growing downward. */
  y0: number
  y1: number
  /** Recognition confidence in `[0, 1]`. An embedded PDF text layer is exact, so
   * it reports 1 — this is not a signal to filter on, only to surface. */
  conf: number
}

/** One line of a page: the runs that share a baseline, left to right. */
export interface OcrLine {
  /** 1-based, and stable — this is the number a finding cites back to. */
  index: number
  words: OcrWord[]
  /** The line's plain text, single-spaced. */
  text: string
  /** Representative vertical position (the line's top edge). */
  y: number
}

/** Thrown when a page could not be read at all — a locked or damaged PDF, or a
 * scan no engine on this device can transcribe. It lives here rather than with
 * either reader because both throw it and the UI checks one type: putting it in
 * `read-page.ts` would make `pdf.ts` import the coding path (and drag wasm and
 * the inference client into the viewer's bundle) just to name an error. */
export class UnreadablePageError extends Error {}

/** What a page-reading engine must provide. */
export interface OcrEngine {
  /** Read `bytes` of the given MIME type into lines, top to bottom. Resolves
   * empty for a page with no recoverable text — which callers must treat as
   * "couldn't read this", never as "the page was blank". */
  recognize(bytes: Uint8Array, mime: string): Promise<OcrLine[]>
}
