// Band geometry for CycleStats.svelte: turns the derived cycles into plain
// bar/fill/marker numbers so the visualization's proportions are unit-tested,
// not eyeballed in the template. Pure — no Svelte, no wasm — mirroring
// correlate.ts and cycle.ts. Day math goes through the same local date-string
// bucketing (`dayKey`) those modules use, never a lexical ISO comparison, so a
// DST boundary can't shift a bar or a marker by a day.
import type { StoredEvent } from './events'
import { deriveCycles, cycleStats } from './cycle'
import { SNOMED, SYMPTOMS } from './codes'
import { dayKey, isoToMillis } from './time'

/** Most recent cycles shown before collapsing the rest into a "+N earlier"
 * note — a full history would make each bar too thin to read a period fill or a
 * marker on. */
export const MAX_BARS = 6

/** A cycle-relevant symptom plotted on a bar. `offsetPct` is its position along
 * that bar (0 = the cycle's start day, 100 = its far end), clamped so a stray
 * timestamp can't paint outside the bar. */
export interface CycleMarker {
  atIso: string
  label: string
  offsetPct: number
}

/** One bar in the cycle band. Widths are percentages so the template stays
 * unit-free: `widthPct` scales the bar against the longest completed cycle,
 * `fillPct` is the recorded period duration as a share of *this* bar's width. */
export interface CycleBar {
  startIso: string
  /** Start-month abbreviation, the bar's left label. */
  monthLabel: string
  /** The bar's right label: "<n>d" for a completed cycle, "<n>d…" for the open
   * one — the ellipsis is what says "still counting", predicting nothing. */
  rightLabel: string
  /** True for the current cycle (no next start yet): rendered as a dashed
   * outline sized by days elapsed so far, never filled. */
  open: boolean
  widthPct: number
  /** 0 for the open bar and for any completed cycle whose period was never
   * closed with an end marker — nothing is imputed. */
  fillPct: number
  markers: CycleMarker[]
}

export interface CycleBand {
  /** Chronological, capped at {@link MAX_BARS}; the open bar is always last. */
  bars: CycleBar[]
  /** Cycles omitted before the cap (the "+N earlier" note). */
  earlierCount: number
  /** Distinct cycle-relevant symptom labels actually plotted on the shown bars,
   * for the legend — only what's present, no dead legend entries. */
  legendSymptoms: string[]
  /** Cycles with a start-to-start length (i.e. not the open one). The stats
   * line needs ≥2 before a median/range means anything. */
  completedCount: number
}

/** Whole calendar days from a's local date to b's local date (b − a), parsing
 * each at local midnight so the result is an exact integer with no DST drift —
 * the same rule cycle.ts's own (private) `dayDiff` uses. */
function dayDiff(aIso: string, bIso: string): number {
  const a = new Date(`${dayKey(aIso)}T00:00:00`).getTime()
  const b = new Date(`${dayKey(bIso)}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n))
}

const CYCLE_RELEVANT = SYMPTOMS.filter((s) => s.cycleRelevant)
const RELEVANT_LABELS = new Map(CYCLE_RELEVANT.map((s) => [s.snomed.code, s.label]))
const RELEVANT_CODES = new Set(CYCLE_RELEVANT.map((s) => s.snomed.code))

interface Mark {
  atIso: string
  label: string
}

/** Cycle-relevant symptom events (dysmenorrhea, breast tenderness), dated, with
 * a display label — the overlay marks. */
function relevantMarks(events: StoredEvent[]): Mark[] {
  const out: Mark[] = []
  for (const { event } of events) {
    if (!event.effective_at || !event.code) continue
    if (event.code.system !== SNOMED || !RELEVANT_CODES.has(event.code.code)) continue
    // Prefer the app's friendly symptom label ("Menstrual cramps") over the raw
    // SNOMED display ("Dysmenorrhea") for a legibly-labelled overlay legend.
    out.push({ atIso: event.effective_at, label: RELEVANT_LABELS.get(event.code.code) ?? event.code.display ?? 'Symptom' })
  }
  return out
}

/**
 * Bar geometry for the cycle band, or an empty band when the log carries no
 * derivable cycle. The open (current) cycle is sized by days elapsed as of
 * `now` — injectable purely so the geometry is testable without freezing the
 * clock, matching {@link cycleStats}.
 */
export function cycleBand(events: StoredEvent[], now: number = Date.now()): CycleBand {
  const cycles = deriveCycles(events)
  if (cycles.length === 0) {
    return { bars: [], earlierCount: 0, legendSymptoms: [], completedCount: 0 }
  }

  const marks = relevantMarks(events)
  const completedCount = cycles.filter((c) => c.lengthDays !== null).length

  // The open cycle is the last one (no next start yet); its length is days
  // elapsed so far — the same currentDay the headline shows, so bar and headline
  // never disagree.
  const stats = cycleStats(events, now)
  const openElapsed = Math.max(1, stats?.currentDay ?? 1)

  const lengthOf = (i: number): number =>
    cycles[i].lengthDays !== null ? cycles[i].lengthDays! : openElapsed

  // Longest completed cycle anchors the width scale; with no completed cycle yet
  // the lone open bar sets its own scale so it reads full-width rather than
  // vanishing.
  const completedLengths = cycles.filter((c) => c.lengthDays !== null).map((c) => c.lengthDays!)
  const scaleMax = completedLengths.length > 0 ? Math.max(...completedLengths) : openElapsed

  const allBars: CycleBar[] = cycles.map((cycle, i) => {
    const open = cycle.lengthDays === null
    const len = lengthOf(i)
    const nextStartMs = i + 1 < cycles.length ? isoToMillis(cycles[i + 1].startIso) : now
    const startMs = isoToMillis(cycle.startIso)

    // Recorded period duration (start→end inclusive) as a share of this bar; the
    // open bar and any unclosed period get no fill.
    const periodDays = !open && cycle.endIso !== null ? dayDiff(cycle.startIso, cycle.endIso) + 1 : 0
    const fillPct = periodDays > 0 && len > 0 ? clampPct((periodDays / len) * 100) : 0

    const barMarks: CycleMarker[] = marks
      .filter((m) => {
        const t = isoToMillis(m.atIso)
        return t >= startMs && t < nextStartMs
      })
      .map((m) => ({
        atIso: m.atIso,
        label: m.label,
        offsetPct: clampPct(len > 0 ? (dayDiff(cycle.startIso, m.atIso) / len) * 100 : 0),
      }))
      .sort((a, b) => a.offsetPct - b.offsetPct)

    return {
      startIso: cycle.startIso,
      monthLabel: new Date(`${dayKey(cycle.startIso)}T00:00:00`).toLocaleDateString(undefined, { month: 'short' }),
      rightLabel: open ? `${len}d…` : `${len}d`,
      open,
      widthPct: clampPct((len / scaleMax) * 100),
      fillPct,
      markers: barMarks,
    }
  })

  const bars = allBars.slice(-MAX_BARS)
  const legendSymptoms = [...new Set(bars.flatMap((b) => b.markers.map((m) => m.label)))]

  return { bars, earlierCount: allBars.length - bars.length, legendSymptoms, completedCount }
}
