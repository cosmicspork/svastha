import { describe, expect, it } from 'vitest'
import {
  A4,
  buildPharmacyPdf,
  layoutPharmacyPdf,
  pharmacyPdfFilename,
  winAnsiSafe,
  wrapText,
  type MeasureText,
} from '../pharmacyPdf'
import { buildPharmacyGroups } from '../pharmacy'
import { buildSummary } from '../summary'
import type { StoredEvent } from '../events'
import type { ConceptStatus, Regimen } from '../curation'
import { RXNORM, type Code } from '../codes'

// A fixed-width measurer: every glyph is 0.5 × the size. The layout's wrapping
// and page breaks are then exactly predictable, which is the point of taking a
// measurer rather than reaching for a font.
const measure: MeasureText = (text, size) => text.length * size * 0.5

const NOW = Date.parse('2026-01-15T12:00:00+00:00')
const CREATED = '2026-01-15T12:00:00.000Z'

let nextId = 0
function med(code: Code): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: 'medication_statement',
      code,
      value: null,
      effective_at: '2024-01-01T00:00:00+00:00',
    },
  } as unknown as StoredEvent
}

const LISI: Code = { system: RXNORM, code: '29046', display: 'Lisinopril' }
const METF: Code = { system: RXNORM, code: '6809', display: 'Metformin' }
const AMOX: Code = { system: RXNORM, code: '723', display: 'Amoxicillin' }
const key = (code: Code) => `medication_statement|${code.system}|${code.code}`

function rowsFor(
  codes: Code[],
  opts: {
    regimen?: Map<string, Regimen>
    status?: Map<string, ConceptStatus>
    hiddenIds?: Set<string>
  } = {},
) {
  return buildSummary(codes.map(med), { now: NOW, ...opts }).medications
}

const groupsFor = (...args: Parameters<typeof rowsFor>) => buildPharmacyGroups(rowsFor(...args))

const textOf = (layout: ReturnType<typeof layoutPharmacyPdf>): string[] =>
  layout.flatMap((p) => p.runs.map((r) => r.text))

describe('winAnsiSafe', () => {
  it('keeps the accented Latin and symbols the standard fonts encode', () => {
    expect(winAnsiSafe('naïve café 500 µg — "quoted"')).toBe('naïve café 500 µg — "quoted"')
    expect(winAnsiSafe('twice a day · with food')).toBe('twice a day · with food')
  })

  // Adversarial: a drug name or instruction in a script the standard fonts
  // cannot encode would otherwise make drawText throw and lose the whole file.
  it.each([
    ['Devanagari', 'मेटफॉर्मिन'],
    ['Han', '二甲双胍'],
  ])('replaces %s rather than failing the export', (_label, input) => {
    // One '?' per code point, so the replacement never changes the line count.
    expect(winAnsiSafe(input)).toBe('?'.repeat([...input].length))
  })

  it('replaces an emoji but keeps the words around it', () => {
    expect(winAnsiSafe('take 💊')).toBe('take ?')
  })

  it('flattens the whitespace that would break a single-line run', () => {
    expect(winAnsiSafe('one\ttwo\nthree')).toBe('one two three')
    expect(winAnsiSafe('bellhere')).toBe('bellhere')
  })
})

describe('wrapText', () => {
  it('wraps greedily at the width', () => {
    // 10pt at 0.5 width/char = 5pt a character, so 100pt holds 20 characters.
    expect(wrapText('aaaa bbbb cccc dddd', 10, false, 100, measure)).toEqual([
      'aaaa bbbb cccc dddd',
    ])
    expect(wrapText('aaaa bbbb cccc ddddde', 10, false, 100, measure)).toEqual([
      'aaaa bbbb cccc',
      'ddddde',
    ])
  })

  it('keeps a word longer than the line intact rather than splitting it', () => {
    expect(wrapText('Hydrochlorothiazidexyz', 10, false, 40, measure)).toEqual([
      'Hydrochlorothiazidexyz',
    ])
  })

  it('returns one empty line for empty text', () => {
    expect(wrapText('', 10, false, 100, measure)).toEqual([''])
  })
})

describe('layoutPharmacyPdf', () => {
  it('emits the rows in list order, numbered', () => {
    const regimen = new Map<string, Regimen>([[key(LISI), { route: 'mouth' }]])
    const status = new Map<string, ConceptStatus>([[key(AMOX), 'inactive']])
    const layout = layoutPharmacyPdf(
      groupsFor([METF, LISI, AMOX], { regimen, status }),
      [],
      CREATED,
      measure,
    )
    const numbered = textOf(layout).filter((t) => /^\d+\. /.test(t))
    expect(numbered).toEqual(['1. Metformin', '2. Lisinopril', '3. Amoxicillin'])
  })

  it('puts the Past group after every route group', () => {
    const regimen = new Map<string, Regimen>([[key(LISI), { route: 'mouth' }]])
    const status = new Map<string, ConceptStatus>([[key(AMOX), 'inactive']])
    const lines = textOf(
      layoutPharmacyPdf(groupsFor([LISI, AMOX], { regimen, status }), [], CREATED, measure),
    )
    expect(lines.indexOf('Past')).toBeGreaterThan(lines.indexOf('By mouth'))
  })

  it('never splits one medication across a page break', () => {
    // A page short enough that the breaks land inside the list.
    const page = { width: 595, height: 260, margin: 24 }
    const regimen = new Map<string, Regimen>(
      [LISI, METF, AMOX].map((c) => [
        key(c),
        { route: 'mouth' as const, dose: '10 mg tablet', schedule: 'once daily', prescriber: 'Dr. Rao' },
      ]),
    )
    const layout = layoutPharmacyPdf(
      groupsFor([LISI, METF, AMOX], { regimen }),
      [],
      CREATED,
      measure,
      page,
    )
    expect(layout.length).toBeGreaterThan(1)

    // Every page that starts a medication must also carry that medication's
    // dose line: a dose stranded from its name is the error this prevents.
    for (const p of layout) {
      const texts = p.runs.map((r) => r.text)
      const names = texts.filter((t) => /^\d+\. /.test(t))
      for (const name of names) {
        const at = texts.indexOf(name)
        expect(texts.slice(at + 1, at + 4)).toContain('10 mg tablet')
      }
    }
  })

  it('keeps every run inside the page margins', () => {
    // Long prose, which wraps. (A single unbreakable word is the documented
    // exception — see wrapText's "keeps a word longer than the line intact".)
    const page = { width: 595, height: 300, margin: 24 }
    const regimen = new Map<string, Regimen>([
      [key(LISI), { route: 'mouth', schedule: 'one tablet '.repeat(40) }],
    ])
    const layout = layoutPharmacyPdf(groupsFor([LISI], { regimen }), [], CREATED, measure, page)
    for (const p of layout) {
      for (const run of p.runs) {
        expect(run.x).toBeGreaterThanOrEqual(page.margin)
        expect(run.y).toBeLessThanOrEqual(page.height - page.margin + run.size)
        expect(measure(run.text, run.size, run.bold)).toBeLessThanOrEqual(
          page.width - page.margin * 2,
        )
      }
    }
  })

  it.each([
    ['absent', null, 'Not included in this share. Ask before dispensing.'],
    ['empty', [], 'None recorded. An empty record is not the same as none — ask.'],
  ] as [string, string[] | null, string][])(
    'says what %s allergies mean, never conflating the two',
    (_label, allergies, expected) => {
      const lines = textOf(layoutPharmacyPdf(groupsFor([LISI]), allergies, CREATED, measure))
      expect(lines).toContain(expected)
    },
  )

  it('lists recorded allergies', () => {
    const lines = textOf(
      layoutPharmacyPdf(groupsFor([LISI]), ['Penicillin', 'Sulfonamides'], CREATED, measure),
    )
    expect(lines).toContain('Penicillin · Sulfonamides')
  })

  it('says a prescriber is not recorded rather than leaving a blank', () => {
    const lines = textOf(layoutPharmacyPdf(groupsFor([LISI]), [], CREATED, measure))
    expect(lines).toContain('Prescribed by: Not recorded')
  })
})

describe('buildPharmacyPdf', () => {
  it('renders a PDF whose page count matches the layout', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const page = { width: 595, height: 260, margin: 24 }
    const regimen = new Map<string, Regimen>(
      [LISI, METF, AMOX].map((c) => [key(c), { route: 'mouth' as const, dose: '10 mg tablet' }]),
    )
    const rows = rowsFor([LISI, METF, AMOX], { regimen })
    const bytes = await buildPharmacyPdf(rows, [], CREATED, page)

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')

    const probe = await PDFDocument.create()
    const font = await probe.embedFont(StandardFonts.Helvetica)
    const expected = layoutPharmacyPdf(
      buildPharmacyGroups(rows),
      [],
      CREATED,
      (t, s) => font.widthOfTextAtSize(t, s),
      page,
    ).length
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBe(expected)
  })

})

// The runs are literally the strings drawn onto the page (buildPharmacyPdf
// walks them into drawText), so asserting on the layout asserts on the file's
// words — and unlike the saved bytes, which pdf-lib compresses, they can be
// read without a PDF parser.
describe('the exported words', () => {
  it('leave a hidden medication out', () => {
    // The guarantee the page makes, carried into the export: the PDF folds the
    // rows the screen folded, so what the owner hid cannot reappear in a file
    // they hand to a pharmacist.
    const all = [LISI, METF].map(med)
    const rows = buildSummary(all, {
      now: NOW,
      hiddenIds: new Set([all[1].event.id]),
    }).medications
    expect(rows.map((r) => r.label)).toEqual(['Lisinopril'])

    const lines = textOf(layoutPharmacyPdf(buildPharmacyGroups(rows), [], CREATED, measure))
    expect(lines).toContain('1. Lisinopril')
    expect(lines.join('\n')).not.toContain('Metformin')
  })

  it('keep a concept whose other event is hidden', () => {
    // Adversarial counterpart: hiding one of two events of the SAME concept
    // must not remove the row — the medication is still on record.
    const first = med(LISI)
    const second = med(LISI)
    const rows = buildSummary([first, second], {
      now: NOW,
      hiddenIds: new Set([second.event.id]),
    }).medications
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)

    const lines = textOf(layoutPharmacyPdf(buildPharmacyGroups(rows), [], CREATED, measure))
    expect(lines).toContain('1. Lisinopril')
  })
})

describe('pharmacyPdfFilename', () => {
  it('date-stamps the name', () => {
    expect(pharmacyPdfFilename(new Date(2026, 8, 4))).toBe('svastha-medications-2026-09-04.pdf')
  })
})

describe('A4', () => {
  it('is the page the layout defaults to', () => {
    expect(A4).toEqual({ width: 595, height: 842, margin: 48 })
  })
})
