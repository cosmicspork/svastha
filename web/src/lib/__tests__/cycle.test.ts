import { describe, expect, it } from 'vitest'
import { deriveCycles, cycleStats, FLOW_GAP_DAYS } from '../cycle'
import type { StoredEvent } from '../events'
import { CYCLE_START, CYCLE_END, CYCLE_FLOW, BP_SYSTOLIC, type Code } from '../codes'

let nextId = 0
/** A minimal cycle observation; only code + effective_at drive derivation. */
function ev(code: Code | null, effective_at: string | null): StoredEvent {
  return {
    event: {
      id: `e${nextId++}`,
      kind: 'observation',
      code,
      effective_at,
      value: null,
      provenance: { source: 'self', source_doc: null },
    },
    author: 'a'.repeat(64),
    signature: 'b'.repeat(128),
  }
}

// Local wall-clock date strings (no offset) so day math reads the date part
// directly, matching how the app dates its facts (see time.ts `toLocalIso`).
const at = (day: string) => `${day}T09:00:00`

describe('deriveCycles: explicit starts', () => {
  it('pairs consecutive starts start-to-start; the last cycle has null length', () => {
    const cycles = deriveCycles([
      ev(CYCLE_START, at('2026-01-01')),
      ev(CYCLE_START, at('2026-01-29')), // +28
      ev(CYCLE_START, at('2026-02-28')), // +30
    ])
    expect(cycles.map((c) => c.startIso.slice(0, 10))).toEqual(['2026-01-01', '2026-01-29', '2026-02-28'])
    expect(cycles.map((c) => c.lengthDays)).toEqual([28, 30, null])
  })

  it('collapses a start and its same-day flow sibling into one cycle (no double count)', () => {
    const cycles = deriveCycles([
      ev(CYCLE_START, at('2026-03-01')),
      ev(CYCLE_FLOW, at('2026-03-01')),
      ev(CYCLE_FLOW, at('2026-03-02')),
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].startIso.slice(0, 10)).toBe('2026-03-01')
  })

  it('ignores undated events', () => {
    const cycles = deriveCycles([ev(CYCLE_START, null), ev(CYCLE_START, at('2026-01-01'))])
    expect(cycles).toHaveLength(1)
  })
})

describe('deriveCycles: end pairing', () => {
  it('pairs the first end at/after a start and before the next start', () => {
    const cycles = deriveCycles([
      ev(CYCLE_START, at('2026-01-01')),
      ev(CYCLE_END, at('2026-01-05')),
      ev(CYCLE_START, at('2026-01-29')),
    ])
    expect(cycles[0].endIso?.slice(0, 10)).toBe('2026-01-05')
    expect(cycles[1].endIso).toBeNull() // no end after the second start
  })

  it('leaves endIso null when a period is never closed', () => {
    const cycles = deriveCycles([ev(CYCLE_START, at('2026-01-01'))])
    expect(cycles[0].endIso).toBeNull()
  })
})

describe('deriveCycles: implicit starts from flow', () => {
  it('starts a new period when consecutive flow observations are ≥7 days apart, with no start marker', () => {
    const cycles = deriveCycles([
      ev(CYCLE_FLOW, at('2026-01-01')),
      ev(CYCLE_FLOW, at('2026-01-02')),
      ev(CYCLE_FLOW, at('2026-01-09')), // exactly FLOW_GAP_DAYS after the previous flow → new period
    ])
    expect(FLOW_GAP_DAYS).toBe(7)
    expect(cycles.map((c) => c.startIso.slice(0, 10))).toEqual(['2026-01-01', '2026-01-09'])
  })

  it('keeps flow within 7 days as a single period (one implicit start)', () => {
    const cycles = deriveCycles([
      ev(CYCLE_FLOW, at('2026-01-01')),
      ev(CYCLE_FLOW, at('2026-01-04')),
      ev(CYCLE_FLOW, at('2026-01-07')), // 6 days after the run start → same period
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].startIso.slice(0, 10)).toBe('2026-01-01')
  })

  it('adds an implicit start for a flow-only period far from any explicit start', () => {
    const cycles = deriveCycles([
      ev(CYCLE_START, at('2026-01-01')),
      ev(CYCLE_FLOW, at('2026-02-01')), // no start marker, 31 days from the explicit start
      ev(CYCLE_FLOW, at('2026-02-02')),
    ])
    expect(cycles.map((c) => c.startIso.slice(0, 10))).toEqual(['2026-01-01', '2026-02-01'])
  })
})

describe('cycleStats', () => {
  it('is null when there are no cycle events at all', () => {
    expect(cycleStats([ev(BP_SYSTOLIC, at('2026-01-01'))])).toBeNull()
  })

  it('reports median/min/max length over ≥2 completed intervals', () => {
    const stats = cycleStats([
      ev(CYCLE_START, at('2026-01-01')),
      ev(CYCLE_START, at('2026-01-29')), // +28
      ev(CYCLE_START, at('2026-02-28')), // +30
    ])!
    expect(stats.cycleCount).toBe(3)
    expect(stats.medianLength).toBe(29)
    expect(stats.minLength).toBe(28)
    expect(stats.maxLength).toBe(30)
  })

  it('computes currentDay as days-since-last-start + 1 (start day = day 1)', () => {
    const now = new Date('2026-07-05T12:00:00').getTime()
    const stats = cycleStats([ev(CYCLE_START, at('2026-07-01'))], now)!
    expect(stats.currentDay).toBe(5)
    expect(stats.lastStartIso?.slice(0, 10)).toBe('2026-07-01')
  })

  it('degrades length stats to null with a single start, keeping the last-start facts', () => {
    const stats = cycleStats([ev(CYCLE_START, at('2026-07-01'))])!
    expect(stats.cycleCount).toBe(1)
    expect(stats.medianLength).toBeNull()
    expect(stats.minLength).toBeNull()
    expect(stats.maxLength).toBeNull()
    expect(stats.lastStartIso?.slice(0, 10)).toBe('2026-07-01')
  })

  it('leaves typicalPeriodDays null when no end is recorded, and computes it inclusively when one is', () => {
    const noEnd = cycleStats([ev(CYCLE_START, at('2026-01-01')), ev(CYCLE_START, at('2026-01-29'))])!
    expect(noEnd.typicalPeriodDays).toBeNull()

    const withEnd = cycleStats([
      ev(CYCLE_START, at('2026-01-01')),
      ev(CYCLE_END, at('2026-01-05')), // start+end inclusive = 5 days
      ev(CYCLE_START, at('2026-01-29')),
    ])!
    expect(withEnd.typicalPeriodDays).toBe(5)
  })
})
