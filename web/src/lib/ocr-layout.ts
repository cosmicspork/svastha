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

/** Fraction of the shorter run's height that two runs must overlap vertically to
 * count as the same line. Half is forgiving enough for the baseline jitter in a
 * scan, tight enough that a table's rows stay separate. */
const LINE_OVERLAP = 0.5

/** Character width of a rendered column block. Wide enough for a lab panel's
 * analyte/value/unit/range, narrow enough not to bloat the prompt. */
export const COLUMN_WIDTH = 100

/** How much two vertical spans overlap, as a fraction of the shorter one. */
function overlapRatio(a: OcrWord, b: OcrWord): number {
  const top = Math.max(a.y0, b.y0)
  const bottom = Math.min(a.y1, b.y1)
  const shorter = Math.min(a.y1 - a.y0, b.y1 - b.y0)
  if (shorter <= 0) return 0
  return Math.max(0, bottom - top) / shorter
}

/**
 * Group positioned runs into lines by vertical overlap, top to bottom, each
 * line's runs ordered left to right.
 *
 * Overlap rather than equal baselines: a scan's baselines wobble, and a run set
 * in a larger face sits on the same visual row without sharing a y. Each run is
 * compared against the line it would join rather than against a running average,
 * so one tall run cannot drag a line's band across its neighbours.
 */
export function groupLines(words: OcrWord[]): OcrLine[] {
  const usable = words.filter((w) => w.text.trim() !== '')
  if (usable.length === 0) return []

  const sorted = [...usable].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const rows: OcrWord[][] = []

  for (const word of sorted) {
    const row = rows.at(-1)
    // Compare against the row's tallest member: the run most likely to define
    // the visual band, so a short subscript joins rather than starting a row.
    const anchor = row?.reduce((tallest, w) =>
      w.y1 - w.y0 > tallest.y1 - tallest.y0 ? w : tallest,
    )
    if (anchor && overlapRatio(anchor, word) >= LINE_OVERLAP) {
      row!.push(word)
    } else {
      rows.push([word])
    }
  }

  return rows.map((row, i) => {
    const ordered = [...row].sort((a, b) => a.x0 - b.x0)
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
