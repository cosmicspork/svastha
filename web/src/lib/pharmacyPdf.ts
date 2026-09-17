// The pharmacy list as a PDF: the file someone hands over at a counter, or
// sends to a pharmacy that wants a copy rather than a link.
//
// Split the way pdf.ts splits its reader: `layoutPharmacyPdf` is pure and takes
// a text measurer, so wrapping, page breaks and ordering are testable without
// a PDF engine at all; `buildPharmacyPdf` is the thin render over `pdf-lib`,
// which is imported lazily so its bytes stay out of the app's first load.
import { buildPharmacyGroups, type PharmacyGroup } from './pharmacy'
import type { SummaryRow } from './summary'

/** Measures a string at a size, in points. Injected so the layout is pure. */
export type MeasureText = (text: string, size: number, bold: boolean) => number

export interface PdfRun {
  x: number
  /** Distance from the top of the page, in points; the renderer flips it. */
  y: number
  size: number
  bold: boolean
  text: string
}

export interface PdfPageLayout {
  runs: PdfRun[]
}

export interface PageMetrics {
  width: number
  height: number
  margin: number
}

/** A4 at 72dpi, with a margin wide enough to survive a printer's unprintable
 * edge. */
export const A4: PageMetrics = { width: 595, height: 842, margin: 48 }

const TITLE_SIZE = 16
const HEADING_SIZE = 12
const NAME_SIZE = 12
const BODY_SIZE = 10
const SMALL_SIZE = 8.5
const LINE_GAP = 3

/** WinAnsi, the encoding pdf-lib's standard (non-embedded) fonts speak. Any
 * other glyph — Devanagari, Han, emoji — makes `drawText` throw, so it is
 * replaced rather than allowed to fail the whole export. Embedding a Unicode
 * font would cost hundreds of kilobytes for a file most people never open. */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

export function winAnsiSafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    // Tab and newline would break a single-line run; everything else below
    // space is a control character.
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' '
    else if (cp < 0x20) continue
    else if (cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp)) out += ch
    else out += '?'
  }
  return out
}

/** Greedy wrap to `width`, never returning an empty array (an empty string
 * wraps to one empty line, so a caller's line accounting stays honest). A word
 * longer than the line stays on its own line rather than being split mid-word
 * — a broken drug name is worse than a long one. */
export function wrapText(
  text: string,
  size: number,
  bold: boolean,
  width: number,
  measure: MeasureText,
): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (line !== '' && measure(candidate, size, bold) > width) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  lines.push(line)
  return lines
}

/**
 * Lay the groups out into pages.
 *
 * A medication never straddles a page break: a pharmacist reading a dose at the
 * foot of one page and its directions at the head of the next is exactly the
 * error this list exists to prevent. A group heading never ends a page alone
 * either — it moves with the row beneath it.
 */
export function layoutPharmacyPdf(
  groups: PharmacyGroup[],
  allergies: string[] | null,
  createdAt: string,
  measure: MeasureText,
  page: PageMetrics = A4,
): PdfPageLayout[] {
  const contentWidth = page.width - page.margin * 2
  const pages: PdfPageLayout[] = []
  let runs: PdfRun[] = []
  let y = page.margin

  const room = (needed: number): boolean => y + needed <= page.height - page.margin

  const newPage = (): void => {
    pages.push({ runs })
    runs = []
    y = page.margin
  }

  /** Measure a block without emitting it, to decide whether it fits. */
  const blockHeight = (lines: { size: number }[]): number =>
    lines.reduce((total, l) => total + l.size + LINE_GAP, 0)

  const emit = (text: string, size: number, bold: boolean, indent = 0): void => {
    for (const line of wrapText(winAnsiSafe(text), size, bold, contentWidth - indent, measure)) {
      runs.push({ x: page.margin + indent, y: y + size, size, bold, text: line })
      y += size + LINE_GAP
    }
  }

  emit('Medication list', TITLE_SIZE, true)
  y += LINE_GAP

  emit('Drug allergies', SMALL_SIZE, true)
  if (allergies === null) {
    emit('Not included in this share. Ask before dispensing.', BODY_SIZE, false)
  } else if (allergies.length === 0) {
    emit('None recorded. An empty record is not the same as none — ask.', BODY_SIZE, false)
  } else {
    emit(allergies.join(' · '), BODY_SIZE, true)
  }
  y += LINE_GAP * 2

  for (const group of groups) {
    // The heading plus its first row, measured together: a heading alone at the
    // foot of a page reads as an empty shelf.
    const firstRow = group.rows[0]
    const headingBlock = [{ size: HEADING_SIZE }, { size: NAME_SIZE }]
    if (firstRow && !room(blockHeight(headingBlock))) newPage()
    emit(group.title, HEADING_SIZE, true)

    for (const row of group.rows) {
      const lines: { size: number }[] = [{ size: NAME_SIZE }]
      if (row.dose) lines.push({ size: BODY_SIZE })
      if (row.sig) lines.push({ size: BODY_SIZE })
      if (row.asNeeded) lines.push({ size: BODY_SIZE })
      lines.push({ size: BODY_SIZE }) // prescriber
      if (row.code) lines.push({ size: SMALL_SIZE })
      if (!room(blockHeight(lines))) newPage()

      emit(`${row.n}. ${row.name}`, NAME_SIZE, true)
      if (row.dose) emit(row.dose, BODY_SIZE, true, 16)
      if (row.sig) emit(row.sig, BODY_SIZE, false, 16)
      if (row.asNeeded) emit('As needed', BODY_SIZE, false, 16)
      emit(`Prescribed by: ${row.prescriber || 'Not recorded'}`, BODY_SIZE, false, 16)
      if (row.code) emit(row.code, SMALL_SIZE, false, 16)
      y += LINE_GAP
    }
    y += LINE_GAP
  }

  if (!room(SMALL_SIZE * 2 + LINE_GAP * 2)) newPage()
  emit(`Exported from Svastha, ${createdAt}.`, SMALL_SIZE, false)
  emit(
    'Doses and directions are as recorded by the patient and their clinicians.',
    SMALL_SIZE,
    false,
  )

  pages.push({ runs })
  return pages
}

/** `svastha-medications-YYYY-MM-DD.pdf`, matching the date-stamped names the
 * plaintext export already writes. */
export function pharmacyPdfFilename(now: Date): string {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  return `svastha-medications-${stamp}.pdf`
}

/**
 * Render the list to PDF bytes.
 *
 * `rows` are the page's own folded medications, so a hidden entry is already
 * gone — this never re-reads the store, and the PDF cannot disagree with the
 * screen it was exported from.
 */
export async function buildPharmacyPdf(
  rows: SummaryRow[],
  allergies: string[] | null,
  createdAt: string,
  page: PageMetrics = A4,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const measure: MeasureText = (text, size, isBold) =>
    (isBold ? bold : regular).widthOfTextAtSize(text, size)

  const layout = layoutPharmacyPdf(buildPharmacyGroups(rows), allergies, createdAt, measure, page)
  const ink = rgb(0, 0, 0)
  for (const pageLayout of layout) {
    const pdfPage = doc.addPage([page.width, page.height])
    for (const run of pageLayout.runs) {
      pdfPage.drawText(run.text, {
        x: run.x,
        // pdf-lib's origin is the bottom-left; the layout measures from the top.
        y: page.height - run.y,
        size: run.size,
        font: run.bold ? bold : regular,
        color: ink,
      })
    }
  }
  return doc.save()
}
