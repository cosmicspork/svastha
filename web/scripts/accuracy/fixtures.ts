// The fixture pages the accuracy harness scores, as data.
//
// One spec produces both halves of a fixture — the rendered PNG and the
// `.truth.json` beside it — so the answer key cannot drift away from the page
// it answers for. Editing a value here changes the pixels and the ground truth
// in the same commit or not at all.
//
// Everything here is invented. Synthetic names, synthetic values, synthetic
// labs; see `fixtures/README.md` for why that rule has no exceptions.

/** One printed result row: the analyte, what it measured, and the reference
 * range printed beside it. `range` is deliberately *not* ground truth — it is
 * there to be mis-read, since picking a range bound instead of the result is
 * one of the two failures this harness measures. */
export interface Row {
  analyte: string
  value: string
  unit: string
  range: string
}

/** A titled group of rows. The header is what makes the tight-rows fixture
 * hazardous: it is set several times the row height, and a line-grouper that
 * anchors a row to its tallest member will swallow the rows under it. */
export interface Section {
  header: string
  rows: Row[]
}

export interface FixtureSpec {
  /** Basename for both artefacts: `<name>.png` and `<name>.truth.json`. */
  name: string
  /** Printed at the top of the page. */
  lab: string
  /** One line for the README table and the truth file's `note`. */
  note: string
  /** What layout hazard this page exists to exercise. */
  hazard: string
  collected: string
  sections: Section[]
  /** Rotation applied to the whole page body, in degrees. */
  skewDeg?: number
  /** Set the rows solid — no leading at all between them. */
  tight?: boolean
  /** Render in a cursive face with per-glyph jitter. See `render.ts`. */
  hand?: boolean
}

const CMP_ROWS: Row[] = [
  { analyte: 'Sodium', value: '139', unit: 'mmol/L', range: '135-145' },
  { analyte: 'Potassium', value: '4.1', unit: 'mmol/L', range: '3.5-5.1' },
  { analyte: 'Chloride', value: '104', unit: 'mmol/L', range: '98-107' },
  { analyte: 'Glucose', value: '105', unit: 'mg/dL', range: '70-99' },
  { analyte: 'Creatinine', value: '0.9', unit: 'mg/dL', range: '0.6-1.2' },
]

export const FIXTURES: FixtureSpec[] = [
  {
    name: 'cmp-panel',
    lab: 'Springfield Community Laboratory',
    note: 'The existing cmp-panel transcript, typeset as a page.',
    hazard:
      'None deliberately — the control. Same rows as cmp-panel.lines.json, so a reader that scores badly here scores badly on the easiest page there is.',
    collected: '2026-01-14',
    sections: [{ header: 'Comprehensive Metabolic Panel', rows: CMP_ROWS }],
  },
  {
    name: 'tight-rows-panel',
    lab: 'Springfield Community Laboratory',
    note: 'Tight rows under tall section headers.',
    hazard:
      'Rows set solid (no leading) beneath a section header several times their height. A line-grouper that anchors a row band to its tallest member stretches that header over the rows below and merges them, which is how a value from one row ends up beside the analyte from another.',
    collected: '2026-02-03',
    tight: true,
    sections: [
      { header: 'CHEMISTRY', rows: CMP_ROWS },
      {
        header: 'HEMATOLOGY',
        rows: [
          { analyte: 'Hemoglobin', value: '13.8', unit: 'g/dL', range: '12.0-15.5' },
          { analyte: 'Hematocrit', value: '41', unit: '%', range: '36-46' },
          { analyte: 'Platelets', value: '244', unit: 'K/uL', range: '150-400' },
          { analyte: 'Leukocytes', value: '6.2', unit: 'K/uL', range: '4.0-11.0' },
        ],
      },
    ],
  },
  {
    name: 'skewed-panel',
    lab: 'Springfield Community Laboratory',
    note: 'The same panel, photographed crooked (~2 degrees).',
    hazard:
      'Two degrees of rotation across a wide panel droops a row by more than its own height from the first cell to the last, so a grouper that fixes a row band from its first member shreds each row into separate lines — and a numbered transcript of shredded rows no longer has the analyte and its value on one line.',
    collected: '2026-01-14',
    skewDeg: 2,
    sections: [{ header: 'Comprehensive Metabolic Panel', rows: CMP_ROWS }],
  },
  {
    name: 'handwritten-vitals',
    lab: 'Springfield Family Practice',
    note: 'SYNTHETIC HAND-STYLE — a cursive face with per-glyph jitter, not real handwriting.',
    hazard:
      'Cursive glyphs with connected strokes and an irregular baseline. Both shipped readers are trained on typeset text; this page exists to put a number on how they fail, not to be passed.',
    collected: '2026-03-11',
    hand: true,
    sections: [
      {
        header: 'Vitals',
        rows: [
          { analyte: 'Weight', value: '172', unit: 'lb', range: '' },
          { analyte: 'Pulse', value: '68', unit: 'bpm', range: '' },
          { analyte: 'Temperature', value: '98.4', unit: 'F', range: '' },
          { analyte: 'Respirations', value: '14', unit: '/min', range: '' },
        ],
      },
    ],
  },
  {
    name: 'handwritten-meds',
    lab: 'Springfield Family Practice',
    note: 'SYNTHETIC HAND-STYLE — a cursive face with per-glyph jitter, not real handwriting.',
    hazard:
      'The same hand-style rendering over medication names and doses, where a mis-read digit is a dosing error rather than a wrong lab value. Scored the same way; the analyte column is the drug and the value column is the dose.',
    collected: '2026-03-11',
    hand: true,
    sections: [
      {
        header: 'Current Medications',
        rows: [
          { analyte: 'Metformin', value: '500', unit: 'mg', range: '' },
          { analyte: 'Lisinopril', value: '10', unit: 'mg', range: '' },
          { analyte: 'Atorvastatin', value: '20', unit: 'mg', range: '' },
        ],
      },
    ],
  },
]
