import { describe, expect, it } from 'vitest'
import { cycleBand, MAX_BARS } from '../cycleBand'
import type { StoredEvent } from '../events'
import { CYCLE_START, CYCLE_END, CYCLE_FLOW, SYMPTOMS, SNOMED, type Code } from '../codes'

let nextId = 0
function ev(code: Code | null, effective_at: string | null, value: StoredEvent['event']['value'] = null): StoredEvent {
  return {
    event: {
      id: `e${nextId++}`,
      kind: 'observation',
      code,
      effective_at,
      value,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'a'.repeat(64),
    signature: 'b'.repeat(128),
  }
}

// Local wall-clock date strings (no offset), matching cycle.ts's own tests.
const at = (day: string) => `${day}T09:00:00`

const CRAMPS = SYMPTOMS.find((s) => s.key === 'menstrual-cramps')!.snomed
function crampsEvent(day: string): StoredEvent {
  return ev({ system: SNOMED, code: CRAMPS.code, display: CRAMPS.display }, at(day))
}

describe('cycleBand', () => {
  it('is empty when no cycle can be derived', () => {
    const band = cycleBand([])
    expect(band).toEqual({ bars: [], earlierCount: 0, legendSymptoms: [], completedCount: 0 })
  })

  it('scales bar widths against the longest completed cycle (longest = 100%)', () => {
    // Starts on Jan 1 (+28), Jan 29 (+30), Feb 28 (open). Longest completed = 30.
    const now = new Date('2026-03-05T12:00:00').getTime()
    const band = cycleBand(
      [ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_START, at('2026-01-29')), ev(CYCLE_START, at('2026-02-28'))],
      now,
    )
    expect(band.completedCount).toBe(2)
    expect(band.bars).toHaveLength(3)
    expect(band.bars[0].widthPct).toBeCloseTo((28 / 30) * 100, 5)
    expect(band.bars[1].widthPct).toBe(100)
    expect(band.bars[0].rightLabel).toBe('28d')
    expect(band.bars[1].rightLabel).toBe('30d')
  })

  it('renders the current cycle as an open bar sized by days elapsed, labelled with an ellipsis', () => {
    const now = new Date('2026-02-05T12:00:00').getTime() // day 5 of the Feb 1 cycle
    const band = cycleBand([ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_START, at('2026-02-01'))], now)
    const open = band.bars[band.bars.length - 1]
    expect(open.open).toBe(true)
    expect(open.rightLabel).toBe('5d…')
    expect(open.fillPct).toBe(0) // the open bar predicts nothing
  })

  it('fills a completed bar by recorded period duration (start→end inclusive), as a share of the bar', () => {
    // Jan 1 start, Jan 5 end (5 inclusive days), Jan 29 next start (length 28).
    const now = new Date('2026-02-10T12:00:00').getTime()
    const band = cycleBand(
      [ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_END, at('2026-01-05')), ev(CYCLE_START, at('2026-01-29'))],
      now,
    )
    expect(band.bars[0].fillPct).toBeCloseTo((5 / 28) * 100, 5)
  })

  it('leaves fill at 0 for a completed cycle whose period was never closed', () => {
    const now = new Date('2026-02-10T12:00:00').getTime()
    const band = cycleBand([ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_START, at('2026-01-29'))], now)
    expect(band.bars[0].fillPct).toBe(0)
  })

  it('places a cycle-relevant symptom marker at its day-position within the bar', () => {
    // Jan 1 start, cramps on Jan 8 (offset 7), Jan 29 next start (length 28).
    const now = new Date('2026-02-10T12:00:00').getTime()
    const band = cycleBand(
      [ev(CYCLE_START, at('2026-01-01')), crampsEvent('2026-01-08'), ev(CYCLE_START, at('2026-01-29'))],
      now,
    )
    expect(band.bars[0].markers).toHaveLength(1)
    expect(band.bars[0].markers[0].offsetPct).toBeCloseTo((7 / 28) * 100, 5)
    expect(band.legendSymptoms).toEqual(['Menstrual cramps'])
  })

  it('gives the marker to the cycle whose date range contains it, and none to a bar with no symptom', () => {
    const now = new Date('2026-02-10T12:00:00').getTime()
    const band = cycleBand(
      [ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_START, at('2026-01-29')), crampsEvent('2026-02-02')],
      now,
    )
    expect(band.bars[0].markers).toHaveLength(0)
    expect(band.bars[1].markers).toHaveLength(1) // Feb 2 falls in the Jan 29 cycle
  })

  it('caps at MAX_BARS most-recent cycles, reporting the rest as earlierCount', () => {
    // Eight monthly starts → 7 completed + 1 open.
    const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']
    const band = cycleBand(
      months.map((m) => ev(CYCLE_START, at(m))),
      new Date('2026-08-10T12:00:00').getTime(),
    )
    expect(band.bars).toHaveLength(MAX_BARS)
    expect(band.earlierCount).toBe(months.length - MAX_BARS)
    // The open (most recent) cycle survives the cap.
    expect(band.bars[band.bars.length - 1].open).toBe(true)
  })

  it('leaves the lone open bar full-width when there is no completed cycle to scale against', () => {
    const now = new Date('2026-01-05T12:00:00').getTime()
    const band = cycleBand([ev(CYCLE_START, at('2026-01-01'))], now)
    expect(band.completedCount).toBe(0)
    expect(band.bars).toHaveLength(1)
    expect(band.bars[0].open).toBe(true)
    expect(band.bars[0].widthPct).toBe(100)
  })
})
