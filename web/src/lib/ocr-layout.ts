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
 * page's typical glyph height. A full height means the two bands merely touch:
 * forgiving enough for the baseline wobble in a scan and the droop a fraction of
 * a degree of skew accumulates across a wide panel, short of the leading that
 * separates two printed rows. */
const BAND_TOLERANCE = 1

/** Character width of a rendered column block. Wide enough for a lab panel's
 * analyte/value/unit/range, narrow enough not to bloat the prompt. */
export const COLUMN_WIDTH = 100

/** Middle of a run's vertical span. Large and small faces on one printed row
 * share a center far more closely than they share an edge. */
function center(word: OcrWord): number {
  return (word.y0 + word.y1) / 2
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Group positioned runs into lines, top to bottom, each line's runs ordered left
 * to right.
 *
 * A row's band is the median of its members' vertical centers, and the tolerance
 * around it comes from the median glyph height of the whole page. Both medians
 * are load-bearing:
 *
 *   - Against the row: a section label in a large face, a scanned table rule or a
 *     logo is several rows tall. Anchoring a row to its tallest member let such a
 *     run stretch the band over every row it crossed and merge them into one
 *     line, which is the cross-row mis-association this module exists to prevent.
 *     A tall run contributes one center like any other, so it can join a row but
 *     cannot become that row's extent.
 *   - Against the page: a row's own heights say nothing about how far apart the
 *     page's rows are, so the tolerance is a page statistic, immune to whatever
 *     outsized runs happen to land in one row.
 *
 * The median also drifts along with a skewed row as its cells droop, which is
 * what keeps a crooked scan's row together rather than shredding it into one
 * line per cell.
 */
export function groupLines(words: OcrWord[]): OcrLine[] {
  const usable = words.filter((w) => w.text.trim() !== '')
  if (usable.length === 0) return []

  const tolerance = median(usable.map((w) => w.y1 - w.y0)) * BAND_TOLERANCE
  const sorted = [...usable].sort((a, b) => center(a) - center(b) || a.x0 - b.x0)
  const rows: { words: OcrWord[]; centers: number[] }[] = []

  for (const word of sorted) {
    const row = rows.at(-1)
    if (row && Math.abs(center(word) - median(row.centers)) <= tolerance) {
      row.words.push(word)
      row.centers.push(center(word))
    } else {
      rows.push({ words: [word], centers: [center(word)] })
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
