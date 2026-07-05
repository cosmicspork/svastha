// Pure query layer over the event log for the Correlate ("Patterns") view:
// no wasm, no storage, no Svelte — everything here takes a plain
// `StoredEvent[]` and returns plain data, so it's fully unit-testable in
// node. Time math goes through time.ts's `isoToMillis`/`addHoursIso` rather
// than lexical ISO-string comparison, which is what keeps this DST-safe (see
// their doc comments).
import type { StoredEvent } from './events'
import { categorize } from './category'
import { isoToMillis, dayKey } from './time'

type Ev = StoredEvent['event']

function labelOf(event: Ev): string | null {
  return event.value && 'text' in event.value ? event.value.text : null
}

function severityOf(event: Ev): number | null {
  if (!event.value || !('quantity' in event.value)) return null
  const n = Number(event.value.quantity.value)
  return Number.isFinite(n) ? n : null
}

// --- lanes ---

export interface SymptomPoint {
  atIso: string
  /** From the event's quantity value (coded symptoms only — a free-text
   * symptom has no severity slot; see drafts.ts's `freeTextSymptomDraft`). */
  severity: number | null
  /** The underlying event, so a tapped dot can open FlarePanel on it. */
  eventId: string
}

export interface SymptomLane {
  /** Grouping key: the code's display name for a coded symptom, or the raw
   * text for a free-text one — the same naming timeline.ts's spine entries
   * use, so "the same symptom" reads identically in both views. */
  name: string
  points: SymptomPoint[]
}

export type InputCategory = 'food' | 'med' | 'exercise'

export interface InputTick {
  atIso: string
  label: string
}

export interface InputLane {
  category: InputCategory
  ticks: InputTick[]
}

export interface Lanes {
  symptoms: SymptomLane[]
  inputs: InputLane[]
}

/** A symptom lane point plus its lane's name — what a tapped/activated dot
 * hands to FlarePanel (Correlate.svelte's selection state). */
export interface FlareSymptom {
  eventId: string
  name: string
  atIso: string
  severity: number | null
}

const INPUT_CATEGORIES: InputCategory[] = ['food', 'med', 'exercise']

/** A day range beyond which per-event symptom points are downsampled to one
 * point per day (see `lanes` below) — a year of daily logging is ~365
 * points per symptom, which is both unreadable at chart width and slow to
 * lay out as individual focusable SVG dots. */
const DOWNSAMPLE_THRESHOLD_DAYS = 90

export function shouldDownsample(fromIso: string, toIso: string): boolean {
  const days = (isoToMillis(toIso) - isoToMillis(fromIso)) / 86_400_000
  return days > DOWNSAMPLE_THRESHOLD_DAYS
}

/** Collapse to one point per calendar day, keeping the day's highest
 * severity (and that point's event, so FlarePanel still opens on a real
 * event) — the peak is what matters for spotting a flare, not every
 * individual log that day. Severity-less (free-text) points are treated as
 * lower priority than any severity so a real reading always wins the day. */
function downsampleToDaily(points: SymptomPoint[]): SymptomPoint[] {
  const byDay = new Map<string, SymptomPoint>()
  for (const point of points) {
    const day = dayKey(point.atIso)
    const existing = byDay.get(day)
    if (!existing || (point.severity ?? -1) > (existing.severity ?? -1)) {
      byDay.set(day, point)
    }
  }
  return [...byDay.values()].sort((a, b) => isoToMillis(a.atIso) - isoToMillis(b.atIso))
}

/**
 * Lay events with `effective_at` in `[fromIso, toIso]` into symptom and
 * input lanes. Callers apply any tag filter / hidden-entry exclusion to
 * `events` before calling this — it's a pure laning step with no opinion
 * about curation.
 */
export function lanes(events: StoredEvent[], fromIso: string, toIso: string): Lanes {
  const from = isoToMillis(fromIso)
  const to = isoToMillis(toIso)

  const symptomGroups = new Map<string, SymptomPoint[]>()
  const inputGroups = new Map<InputCategory, InputTick[]>()

  for (const { event } of events) {
    if (!event.effective_at) continue
    const t = isoToMillis(event.effective_at)
    if (t < from || t > to) continue

    const category = categorize(event)
    if (category === 'symptom') {
      const name = event.code?.display ?? labelOf(event) ?? 'Symptom'
      const points = symptomGroups.get(name) ?? []
      points.push({ atIso: event.effective_at, severity: severityOf(event), eventId: event.id })
      symptomGroups.set(name, points)
    } else if (category === 'food' || category === 'med' || category === 'exercise') {
      const label = labelOf(event)
      if (label === null) continue // e.g. an exercise duration observation, no name of its own
      const ticks = inputGroups.get(category) ?? []
      ticks.push({ atIso: event.effective_at, label })
      inputGroups.set(category, ticks)
    }
  }

  const downsample = shouldDownsample(fromIso, toIso)
  const symptoms: SymptomLane[] = [...symptomGroups.entries()]
    .map(([name, points]) => ({
      name,
      points: (downsample ? downsampleToDaily(points) : points).slice().sort(
        (a, b) => isoToMillis(a.atIso) - isoToMillis(b.atIso),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const inputs: InputLane[] = INPUT_CATEGORIES.filter((c) => inputGroups.has(c)).map((category) => ({
    category,
    ticks: inputGroups.get(category)!.slice().sort((a, b) => isoToMillis(a.atIso) - isoToMillis(b.atIso)),
  }))

  return { symptoms, inputs }
}

// --- preceding ---

export interface PrecedingInput {
  atIso: string
  category: InputCategory
  label: string
  /** Hours before the symptom, always > 0 (the window is half-open on the
   * symptom end — see `preceding` below). */
  deltaHours: number
}

/**
 * Inputs (food/med/exercise, i.e. anything with a text label) in the
 * half-open window `[symptomAtIso - windowHours, symptomAtIso)`: the window
 * start is included, but an input logged at the exact same instant as the
 * symptom is excluded — it can't have preceded a reaction it's simultaneous
 * with. Returned chronologically (earliest, i.e. furthest-before, first).
 */
export function preceding(
  events: StoredEvent[],
  symptomAtIso: string,
  windowHours: number,
): PrecedingInput[] {
  const at = isoToMillis(symptomAtIso)
  const windowStart = at - windowHours * 3_600_000

  const out: PrecedingInput[] = []
  for (const { event } of events) {
    if (!event.effective_at) continue
    const category = categorize(event)
    if (category !== 'food' && category !== 'med' && category !== 'exercise') continue
    const label = labelOf(event)
    if (label === null) continue

    const t = isoToMillis(event.effective_at)
    if (t < windowStart || t >= at) continue

    out.push({ atIso: event.effective_at, category, label, deltaHours: (at - t) / 3_600_000 })
  }
  return out.sort((a, b) => isoToMillis(a.atIso) - isoToMillis(b.atIso))
}
