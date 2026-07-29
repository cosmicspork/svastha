// Turning positioned text into something a model reads correctly.
//
// The failure this exists to prevent is specific and it is a safety issue: a lab
// panel is a table, and flattening it row-major loses which value belongs to
// which analyte. "Potassium 4.1 3.5-5.1 Sodium 139 135-145" invites a model to
// pair 139 with potassium. Two cheap renderings avoid it, and neither needs the
// engine — these are pure functions over word boxes, so they unit-test with no
// PDF, no recognizer, and no browser.
//
//   - {@link renderColumns} keeps the visual table intact by padding each run to
//     its horizontal position. Models read aligned monospace tables well.
//   - {@link numberedLines} gives every row a stable number, so a finding can
//     name the line it came from and be checked against it.
//
// Raw hOCR is deliberately not an option: it is heavy token-wise and models read
// it poorly, and it would put markup between the reader and the record.
import type { OcrLine, OcrWord } from './ocr'

/** How far a run's vertical center may sit from its row's, as a multiple of the
 * shorter of the two glyph heights involved. Strictly under 1 on purpose: at a
 * full height the two bands merely touch, so a table set solid — no leading at
 * all — would merge, and a rule that merges at touching has no margin left for
 * the rows that are merely close. Under it, and still loose enough for a scan's
 * baseline wobble and the droop a fraction of a degree of skew accumulates
 * across a wide panel. */
const BAND_TOLERANCE = 0.9

/** Character width of a rendered column block. Wide enough for a lab panel's
 * analyte/value/unit/range, narrow enough not to bloat the prompt. */
export const COLUMN_WIDTH = 100

/** Middle of a run's vertical span. Large and small faces on one printed row
 * share a center far more closely than they share an edge. */
function center(word: OcrWord): number {
  return (word.y0 + word.y1) / 2
}

function height(word: OcrWord): number {
  return word.y1 - word.y0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** A row under construction: its runs, and the centers and heights the band is
 * re-derived from as it grows. */
interface Row {
  words: OcrWord[]
  centers: number[]
  heights: number[]
}

/** Whether `word` sits on `row`'s band — see {@link groupLines} for why the
 * distance is scaled by the shorter of the two heights and nothing wider. */
function joinsRow(word: OcrWord, row: Row): boolean {
  const local = Math.min(height(word), median(row.heights))
  return Math.abs(center(word) - median(row.centers)) <= local * BAND_TOLERANCE
}

/**
 * Group positioned runs into lines, top to bottom, each line's runs ordered left
 * to right.
 *
 * A run joins the open row when its vertical center sits within
 * {@link BAND_TOLERANCE} of the row's, where the row's center is the median of
 * its members' and the distance is measured in the shorter of the two glyph
 * heights — the run's own, or the row's typical one. Every part of that is
 * load-bearing:
 *
 *   - Medians, not extremes: a section label in a large face, a scanned table
 *     rule or a logo is several rows tall. Anchoring a row to its tallest member
 *     let such a run stretch the band over every row it crossed and merge them
 *     into one line, which is the cross-row mis-association this module exists to
 *     prevent. A tall run contributes one center and one height among many, so it
 *     can join a row without becoming that row's extent.
 *   - Local heights, never a page statistic: a banner or letterhead says nothing
 *     about how tightly a table further down is set, and scaling the tolerance by
 *     the page's typical glyph height lets big text elsewhere merge that table's
 *     rows. Only the candidate and the row it would join get a say.
 *   - A running median rather than the row's first member: it drifts along with a
 *     skewed row as its cells droop, which is what holds a crooked scan's row
 *     together instead of shredding it into one line per cell.
 */
export function groupLines(words: OcrWord[]): OcrLine[] {
  const usable = words.filter((w) => w.text.trim() !== '')
  if (usable.length === 0) return []

  const sorted = [...usable].sort((a, b) => center(a) - center(b) || a.x0 - b.x0)
  const rows: Row[] = []

  for (const word of sorted) {
    const row = rows.at(-1)
    if (row && joinsRow(word, row)) {
      row.words.push(word)
      row.centers.push(center(word))
      row.heights.push(height(word))
    } else {
      rows.push({ words: [word], centers: [center(word)], heights: [height(word)] })
    }
  }

  return rows.map((row, i) => {
    const ordered = [...row.words].sort((a, b) => a.x0 - b.x0)
    return {
      index: i + 1,
      words: ordered,
      text: lineText(ordered),
      y: Math.min(...ordered.map((w) => w.y0)),
    }
  })
}

/** A line's plain text: runs joined by a single space, internal whitespace
 * collapsed. A run may already carry spaces, so this normalizes rather than
 * blindly concatenating. */
export function lineText(words: OcrWord[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Render lines as column-aligned monospace text, so a table still looks like a
 * table.
 *
 * Each run is placed at the character column its left edge maps to, across the
 * horizontal extent of the whole page — one shared scale, or columns would drift
 * line to line. A run that would land on top of its predecessor is pushed one
 * space right instead of overwriting it: losing alignment on a crowded row is a
 * cosmetic loss, whereas dropping characters would be a factual one.
 */
export function renderColumns(lines: OcrLine[], width = COLUMN_WIDTH): string {
  const all = lines.flatMap((l) => l.words)
  if (all.length === 0) return ''

  const minX = Math.min(...all.map((w) => w.x0))
  const maxX = Math.max(...all.map((w) => w.x1))
  const span = maxX - minX

  return lines
    .map((line) => {
      let out = ''
      for (const word of line.words) {
        const column = span > 0 ? Math.round(((word.x0 - minX) / span) * (width - 1)) : 0
        out += column > out.length ? ' '.repeat(column - out.length) : out.length > 0 ? ' ' : ''
        out += word.text.trim()
      }
      return out.trimEnd()
    })
    .join('\n')
}

/**
 * The numbered line index — `[7] Potassium 4.1 mmol/L 3.5-5.1`.
 *
 * The numbers are the whole point: a coded finding names the line it came from,
 * and that claim can then be checked against the line's actual text.
 */
export function numberedLines(lines: OcrLine[]): string {
  return lines
    .filter((l) => l.text !== '')
    .map((l) => `[${l.index}] ${l.text}`)
    .join('\n')
}

/** Look a line up by its 1-based index — the lookup a source-line check needs. */
export function lineAt(lines: OcrLine[], index: number): OcrLine | undefined {
  return lines.find((l) => l.index === index)
}
