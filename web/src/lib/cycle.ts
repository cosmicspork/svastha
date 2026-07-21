// Pure cycle derivation over the event log: no wasm, no storage, no Svelte —
// takes a plain `StoredEvent[]` and returns plain data, so it's fully
// unit-testable in node, mirroring correlate.ts and summary.ts. Day math goes
// through the same local date-string bucketing those modules use (`dayKey`),
// never a lexical ISO comparison, so a DST boundary can't add or drop a day.
import type { StoredEvent } from './events'
import { SVASTHA, CYCLE_START, CYCLE_END, CYCLE_FLOW, CYCLE_CODES } from './codes'
import { isoToMillis, dayKey, toLocalIso } from './time'

type Ev = StoredEvent['event']

/** A ≥7-day gap between flow observations separates two periods; below that
 * they belong to the same period. This is what lets a period logged with flow
 * alone (no explicit start marker) still begin a cycle: the first flow of a run
 * is an implicit start. */
export const FLOW_GAP_DAYS = 7

/** One derived cycle. `endIso` is null when the period was never closed with an
 * end marker; `lengthDays` (start-to-start) is null for the most recent cycle,
 * which has no next start yet. */
export interface Cycle {
  startIso: string
  endIso: string | null
  lengthDays: number | null
}

/** Aggregate cycle statistics for the clinician summary. Every field degrades
 * to null rather than impute a value it can't support: length stats need ≥2
 * starts, period duration needs at least one recorded end. */
export interface CycleStats {
  /** Days since the last start, inclusive of the start day (day 1 = the start
   * day itself). Null when no start is on record. */
  currentDay: number | null
  lastStartIso: string | null
  medianLength: number | null
  minLength: number | null
  maxLength: number | null
  typicalPeriodDays: number | null
  cycleCount: number
}

function isCode(e: Ev, code: string): boolean {
  return e.code?.system === SVASTHA && e.code.code === code
}

/** Whole calendar days from a's local date to b's local date (b − a). Reads the
 * date part of each local ISO string directly (as `dayKey` does) and parses at
 * local midnight, so the result is an exact integer day count with no DST
 * drift. */
function dayDiff(aIso: string, bIso: string): number {
  const a = new Date(`${dayKey(aIso)}T00:00:00`).getTime()
  const b = new Date(`${dayKey(bIso)}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

/**
 * Ordered cycles derived from the event log. A cycle begins at each period
 * start — every explicit `cycle-start` marker, plus an implicit start at the
 * first flow of any flow run (a run break being a ≥{@link FLOW_GAP_DAYS}-day gap
 * in flow observations) that no explicit start already accounts for within
 * {@link FLOW_GAP_DAYS}. Undated events are ignored. `endIso` pairs the first
 * `cycle-end` at or after a start and before the next start.
 */
export function deriveCycles(events: StoredEvent[]): Cycle[] {
  const dated = events.map((se) => se.event).filter((e) => e.effective_at)
  const byTime = (a: Ev, b: Ev) => isoToMillis(a.effective_at!) - isoToMillis(b.effective_at!)

  const explicitStarts = dated.filter((e) => isCode(e, CYCLE_START.code)).sort(byTime)
  const flows = dated.filter((e) => isCode(e, CYCLE_FLOW.code)).sort(byTime)
  const ends = dated.filter((e) => isCode(e, CYCLE_END.code)).sort(byTime)

  const startIsos: string[] = explicitStarts.map((e) => e.effective_at!)
  let prevFlowIso: string | null = null
  for (const f of flows) {
    const iso = f.effective_at!
    const runStart = prevFlowIso === null || dayDiff(prevFlowIso, iso) >= FLOW_GAP_DAYS
    prevFlowIso = iso
    if (!runStart) continue
    // Only promote a flow-run start to an implicit period start when no explicit
    // marker already sits within a period's reach of it — a start logged with a
    // same-day flow sibling must not double-count.
    const coveredByStart = explicitStarts.some(
      (s) => Math.abs(dayDiff(s.effective_at!, iso)) < FLOW_GAP_DAYS,
    )
    if (!coveredByStart) startIsos.push(iso)
  }

  // Collapse to one start per calendar day, chronological — a start marker and
  // an implicit flow start on the same day are the same period beginning.
  const byDay = new Map<string, string>()
  for (const iso of startIsos.sort((a, b) => isoToMillis(a) - isoToMillis(b))) {
    const key = dayKey(iso)
    if (!byDay.has(key)) byDay.set(key, iso)
  }
  const starts = [...byDay.values()]

  return starts.map((startIso, i) => {
    const nextIso = i + 1 < starts.length ? starts[i + 1] : null
    const nextMs = nextIso ? isoToMillis(nextIso) : Infinity
    const startMs = isoToMillis(startIso)
    const end = ends.find((e) => {
      const ms = isoToMillis(e.effective_at!)
      return ms >= startMs && ms < nextMs
    })
    return {
      startIso,
      endIso: end ? end.effective_at! : null,
      lengthDays: nextIso ? dayDiff(startIso, nextIso) : null,
    }
  })
}

/**
 * Cycle statistics for the clinician summary, or null when the record carries
 * no cycle events at all (so a summary over a share that didn't opt cycle in
 * simply has no cycle section). `now` is injectable purely so `currentDay` is
 * testable without freezing the clock.
 */
export function cycleStats(events: StoredEvent[], now: number = Date.now()): CycleStats | null {
  const hasCycleEvents = events.some(
    (se) => se.event.code?.system === SVASTHA && CYCLE_CODES.has(se.event.code.code),
  )
  if (!hasCycleEvents) return null

  const cycles = deriveCycles(events)
  const lengths = cycles.map((c) => c.lengthDays).filter((n): n is number => n !== null)
  // Inclusive day span of each recorded period (start and end day both counted),
  // so a period that starts and ends the same day reads as 1 day.
  const durations = cycles
    .filter((c) => c.endIso !== null)
    .map((c) => dayDiff(c.startIso, c.endIso!) + 1)

  const lastStartIso = cycles.length > 0 ? cycles[cycles.length - 1].startIso : null
  const currentDay = lastStartIso ? dayDiff(lastStartIso, toLocalIso(new Date(now))) + 1 : null

  return {
    currentDay,
    lastStartIso,
    medianLength: lengths.length > 0 ? Math.round(median(lengths)) : null,
    minLength: lengths.length > 0 ? Math.min(...lengths) : null,
    maxLength: lengths.length > 0 ? Math.max(...lengths) : null,
    typicalPeriodDays: durations.length > 0 ? Math.round(median(durations)) : null,
    cycleCount: cycles.length,
  }
}
