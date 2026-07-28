import { describe, expect, it } from 'vitest'
import { groupLines, lineText, renderColumns, numberedLines, lineAt } from '../ocr-layout'
import type { OcrWord } from '../ocr'

/** A run box. y grows downward, matching every engine's convention. */
function w(text: string, x0: number, y0: number, width = 40, height = 10): OcrWord {
  return { text, x0, x1: x0 + width, y0, y1: y0 + height, conf: 1 }
}

/** A two-column lab panel — the layout that makes mis-association a safety
 * problem rather than a cosmetic one. */
function labPanel(): OcrWord[] {
  return [
    w('Potassium', 0, 100),
    w('4.1', 200, 100),
    w('mmol/L', 300, 100),
    w('3.5-5.1', 400, 100),
    w('Sodium', 0, 120),
    w('139', 200, 120),
    w('mmol/L', 300, 120),
    w('135-145', 400, 120),
  ]
}

describe('groupLines', () => {
  it('groups runs sharing a band and orders them left to right', () => {
    const lines = groupLines([w('4.1', 200, 100), w('Potassium', 0, 100)])
    expect(lines).toHaveLength(1)
    expect(lines[0].words.map((x) => x.text)).toEqual(['Potassium', '4.1'])
    expect(lines[0].index).toBe(1)
  })

  it('keeps table rows separate and numbers them top to bottom', () => {
    const lines = groupLines(labPanel())
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('Potassium 4.1 mmol/L 3.5-5.1')
    expect(lines[1].text).toBe('Sodium 139 mmol/L 135-145')
    expect(lines.map((l) => l.index)).toEqual([1, 2])
  })

  it('tolerates baseline jitter within a row', () => {
    // A scan's baselines wobble; a couple of units must not split a row.
    const lines = groupLines([w('Potassium', 0, 100), w('4.1', 200, 103)])
    expect(lines).toHaveLength(1)
  })

  it('joins a short run to the row its tallest member defines', () => {
    // A subscript or small-caps unit sits inside a taller run's band.
    const lines = groupLines([w('Haemoglobin', 0, 100, 80, 14), w('g/dL', 200, 104, 30, 6)])
    expect(lines).toHaveLength(1)
  })

  it('drops whitespace-only runs and returns nothing for an empty page', () => {
    expect(groupLines([w('  ', 0, 100)])).toEqual([])
    expect(groupLines([])).toEqual([])
  })

  it('reads back a line by its index', () => {
    const lines = groupLines(labPanel())
    expect(lineAt(lines, 2)?.text).toBe('Sodium 139 mmol/L 135-145')
    expect(lineAt(lines, 9)).toBeUndefined()
  })
})

describe('lineText', () => {
  it('collapses whitespace a run may already carry', () => {
    expect(lineText([w('Total  protein', 0, 0), w(' 7.1 ', 100, 0)])).toBe('Total protein 7.1')
  })
})

describe('renderColumns', () => {
  it('aligns the same field across rows so a table still reads as one', () => {
    const rendered = renderColumns(groupLines(labPanel()), 60).split('\n')
    expect(rendered).toHaveLength(2)
    // The value column starts at the same offset on both rows — which is what
    // stops a model pairing 139 with potassium.
    expect(rendered[0].indexOf('4.1')).toBe(rendered[1].indexOf('139'))
    expect(rendered[0].indexOf('3.5-5.1')).toBe(rendered[1].indexOf('135-145'))
  })

  it('never drops characters when runs would collide', () => {
    // Two runs mapping to the same column: alignment gives way, text does not.
    const crowded = groupLines([w('aaaaaaaaaa', 0, 0, 5), w('bbbb', 1, 0, 5)])
    const out = renderColumns(crowded, 20)
    expect(out).toContain('aaaaaaaaaa')
    expect(out).toContain('bbbb')
  })

  it('handles a single run and an empty page without dividing by zero', () => {
    expect(renderColumns(groupLines([w('alone', 10, 10)]), 40)).toBe('alone')
    expect(renderColumns([], 40)).toBe('')
  })
})

describe('numberedLines', () => {
  it('numbers every row so a finding can cite one', () => {
    expect(numberedLines(groupLines(labPanel()))).toBe(
      '[1] Potassium 4.1 mmol/L 3.5-5.1\n[2] Sodium 139 mmol/L 135-145',
    )
  })
})
