import { describe, expect, it } from 'vitest'
import { groupLines, lineText, renderColumns, numberedLines, lineAt } from '../ocr-layout'
import { pageWords } from '../pdf'
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

/** The same panel with a fraction of a degree of skew: each column droops a
 * little further than the one to its left, as a scan fed in slightly crooked
 * does. Nothing here is ambiguous to a human eye. */
function skewedPanel(): OcrWord[] {
  return [
    w('Potassium', 0, 100),
    w('4.1', 200, 106),
    w('mmol/L', 300, 109),
    w('3.5-5.1', 400, 112),
    w('Sodium', 0, 120),
    w('139', 200, 126),
    w('mmol/L', 300, 129),
    w('135-145', 400, 132),
  ]
}

/** A section label set in a large face beside a three-row table, so the label's
 * box spans all three rows. */
function labelledPanel(): OcrWord[] {
  return [
    w('CHEMISTRY', 0, 100, 90, 44),
    w('Potassium', 100, 100),
    w('4.1', 300, 100),
    w('Sodium', 100, 118),
    w('139', 300, 118),
    w('Chloride', 100, 136),
    w('104', 300, 136),
  ]
}

/** A banner set at twice the body size above a tight two-row table. The banner
 * is nowhere near the table, so nothing about it should say how far apart the
 * table's rows are. */
function bannerAndTable(): OcrWord[] {
  return [
    ...['LABORATORY', 'RESULTS', 'FINAL', 'REPORT', 'PAGE'].map((text, i) =>
      w(text, i * 120, 0, 100, 20),
    ),
    w('Potassium', 0, 50),
    w('4.1', 200, 50),
    w('Sodium', 0, 65),
    w('139', 200, 65),
  ]
}

/** Two rows set solid: the boxes touch at y=110 and share no vertical extent.
 * Tight, but a reader has no trouble, and neither should the grouping. */
function touchingRows(): OcrWord[] {
  return [w('Potassium', 0, 100), w('4.1', 200, 100), w('Sodium', 0, 110), w('139', 200, 110)]
}

/** The line holding a given run, or undefined. */
function lineWith(lines: ReturnType<typeof groupLines>, text: string) {
  return lines.find((l) => l.words.some((word) => word.text === text))
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

  it('joins a short run to the row a taller run sits on', () => {
    // A subscript or small-caps unit shares the row's centre, not its edges.
    const lines = groupLines([w('Haemoglobin', 0, 100, 80, 14), w('g/dL', 200, 104, 30, 6)])
    expect(lines).toHaveLength(1)
  })

  it('does not let a run taller than the page merge the rows it spans', () => {
    // The whole point of the module: a large-face section label, a scanned table
    // rule or a logo is several rows tall, and if it sets its row's band it
    // swallows every row it crosses — pairing 139 with potassium on one line,
    // which a source-line check would then legitimately wave through.
    const lines = groupLines(labelledPanel())
    expect(lines).toHaveLength(3)
    for (const [analyte, value] of [
      ['Potassium', '4.1'],
      ['Sodium', '139'],
      ['Chloride', '104'],
    ]) {
      const line = lineWith(lines, analyte)
      expect(line?.text).toContain(value)
      const others = ['Potassium', 'Sodium', 'Chloride', '4.1', '139', '104'].filter(
        (t) => t !== analyte && t !== value,
      )
      for (const other of others) expect(line?.text).not.toContain(other)
    }
    // The label lands on one row; it never appears on more than one.
    expect(lines.filter((l) => l.text.includes('CHEMISTRY'))).toHaveLength(1)
  })

  it('keeps a mildly skewed row together instead of shredding it into cells', () => {
    const lines = groupLines(skewedPanel())
    expect(lines.map((l) => l.text)).toEqual([
      'Potassium 4.1 mmol/L 3.5-5.1',
      'Sodium 139 mmol/L 135-145',
    ])
  })

  it('does not let larger text elsewhere on the page merge a tight table', () => {
    // A banner, a heading or a letterhead is bigger than the body, and a page
    // statistic carries its size down to a table it has nothing to do with. What
    // decides whether two runs share a row is their own size and their row's.
    const lines = groupLines(bannerAndTable())
    expect(lines.map((l) => l.text)).toEqual([
      'LABORATORY RESULTS FINAL REPORT PAGE',
      'Potassium 4.1',
      'Sodium 139',
    ])
    expect(numberedLines(lines)).toContain('[2] Potassium 4.1\n[3] Sodium 139')
  })

  it('keeps two rows apart when their bands only touch', () => {
    // Set solid, with no leading: the bands share an edge and nothing else. Two
    // printed rows, so two lines — a rule that merges at touching has no margin
    // left for the rows that are merely close.
    const lines = groupLines(touchingRows())
    expect(lines.map((l) => l.text)).toEqual(['Potassium 4.1', 'Sodium 139'])
    const rendered = renderColumns(lines, 60).split('\n')
    expect(rendered).toHaveLength(2)
    expect(rendered[0].indexOf('4.1')).toBe(rendered[1].indexOf('139'))
    expect(rendered[0]).not.toContain('139')
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

  it('keeps analyte and value on the same rendered row through skew', () => {
    const rendered = renderColumns(groupLines(skewedPanel()), 60).split('\n')
    expect(rendered).toHaveLength(2)
    expect(rendered[0].indexOf('4.1')).toBe(rendered[1].indexOf('139'))
    expect(rendered[0]).toContain('Potassium')
    expect(rendered[0]).not.toContain('139')
    expect(rendered[1]).not.toContain('4.1')
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

describe('pageWords', () => {
  // pdf.js reports a bottom-up baseline; every other engine reports top-down.
  // Getting this backwards would silently invert the whole page's line order.
  it('flips pdf.js bottom-up baselines to top-down boxes', () => {
    const item = { str: 'Potassium', width: 60, height: 10, transform: [1, 0, 0, 1, 20, 700] }
    const [word] = pageWords([item], 800)
    expect(word).toEqual({ text: 'Potassium', x0: 20, x1: 80, y0: 90, y1: 100, conf: 1 })
  })

  it('orders a page top-down after the flip', () => {
    const top = { str: 'top', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 700] }
    const bottom = { str: 'bottom', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 100] }
    const lines = groupLines(pageWords([bottom, top], 800))
    expect(lines.map((l) => l.text)).toEqual(['top', 'bottom'])
  })

  it('skips marked-content items and blank runs', () => {
    const items = [
      { type: 'beginMarkedContent' },
      { str: '   ', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 700] },
      { str: 'real', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 600] },
    ]
    expect(pageWords(items, 800).map((x) => x.text)).toEqual(['real'])
  })
})
