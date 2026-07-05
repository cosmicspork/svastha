// Shapes stored events into the spine's day/entry structure. Grouping key is
// (effective_at, category): that is what re-pairs a BP reading's two
// observations and a meal's per-item events into one visual entry, since the
// builders deliberately stamp them with one shared timestamp.
import { VITALS, BP_SYSTOLIC, BP_DIASTOLIC, EXERCISE_DURATION } from './codes'
import { categorize, type Category } from './category'
import type { StoredEvent } from './events'
import { dayKey, formatDay } from './time'

export interface TimelineEntry {
  effective_at: string
  category: Category
  label: string
  /** Formatted measurement, rendered in --font-data; '' when the label says it
   * all (a note, a meal). */
  value: string
  /** Symptom severity >= 7 — the amber correlation marker. */
  flare: boolean
}

export interface TimelineDay {
  day: string
  label: string
  entries: TimelineEntry[]
}

type Ev = StoredEvent['event']

function quantityOf(e: Ev): { value: string; unit: string } | null {
  if (e.value && 'quantity' in e.value) {
    return { value: e.value.quantity.value, unit: e.value.quantity.unit?.code ?? '' }
  }
  return null
}

function textOf(e: Ev): string | null {
  return e.value && 'text' in e.value ? e.value.text : null
}

const VITAL_LABELS = new Map(VITALS.map((v) => [v.loinc.code, v.label]))

function formatVitals(events: Ev[]): { label: string; value: string } {
  const systolic = events.find((e) => e.code?.code === BP_SYSTOLIC.code)
  const diastolic = events.find((e) => e.code?.code === BP_DIASTOLIC.code)
  const parts: { label: string; value: string }[] = []

  if (systolic && diastolic) {
    const s = quantityOf(systolic)
    const d = quantityOf(diastolic)
    if (s && d) parts.push({ label: 'Blood pressure', value: `${s.value}/${d.value} ${s.unit}`.trim() })
  }
  for (const e of events) {
    if (e === systolic || e === diastolic) continue
    const q = quantityOf(e)
    if (!q) continue
    parts.push({
      label: VITAL_LABELS.get(e.code?.code ?? '') ?? e.code?.display ?? 'Vital',
      value: `${q.value} ${q.unit}`.trim(),
    })
  }
  if (parts.length === 0) return { label: 'Vitals', value: '' }
  if (parts.length === 1) return parts[0]
  return { label: 'Vitals', value: parts.map((p) => `${p.label} ${p.value}`).join(' · ') }
}

function formatSymptoms(events: Ev[]): { label: string; value: string; flare: boolean } {
  const names: string[] = []
  let maxSeverity: number | null = null
  for (const e of events) {
    names.push(e.code?.display ?? textOf(e) ?? 'Symptom')
    const q = quantityOf(e)
    if (q) {
      const n = Number(q.value)
      if (Number.isFinite(n)) maxSeverity = Math.max(maxSeverity ?? 0, n)
    }
  }
  return {
    label: names.join(', '),
    value: maxSeverity === null ? '' : `${maxSeverity}/10`,
    flare: maxSeverity !== null && maxSeverity >= 7,
  }
}

function formatExercise(events: Ev[]): { label: string; value: string } {
  const activity = events.map(textOf).find((t) => t !== null)
  const duration = events.find((e) => e.code?.code === EXERCISE_DURATION.code)
  const q = duration ? quantityOf(duration) : null
  return { label: activity ?? 'Exercise', value: q ? `${q.value} ${q.unit}`.trim() : '' }
}

function formatGroup(category: Category, events: Ev[]): Omit<TimelineEntry, 'effective_at' | 'category'> {
  switch (category) {
    case 'vital':
      return { ...formatVitals(events), flare: false }
    case 'symptom':
      return formatSymptoms(events)
    case 'exercise':
      return { ...formatExercise(events), flare: false }
    case 'med':
    case 'food':
    case 'note': {
      // Per-item events carry no sequence (the store returns id order, i.e.
      // hash order), so sort for a stable join rather than a shuffling one.
      const texts = events
        .map(textOf)
        .filter((t): t is string => t !== null)
        .sort((a, b) => a.localeCompare(b))
      return { label: texts.join(', '), value: '', flare: false }
    }
    default: {
      const first = events[0]
      const coded = first.value && 'coded' in first.value ? first.value.coded : null
      return {
        label: first.code?.display ?? coded?.display ?? first.kind.replace(/_/g, ' '),
        value: textOf(first) ?? '',
        flare: false,
      }
    }
  }
}

/** Group, sort (days desc, entries desc within a day), and format. Undated
 * events can't be placed on a timeline and are skipped. */
export function buildTimeline(events: StoredEvent[], filter: Category | 'all'): TimelineDay[] {
  const groups = new Map<string, { effective_at: string; category: Category; events: Ev[] }>()
  for (const { event } of events) {
    if (!event.effective_at) continue
    const category = categorize(event)
    if (filter !== 'all' && category !== filter) continue
    const key = `${event.effective_at}|${category}`
    const group = groups.get(key) ?? { effective_at: event.effective_at, category, events: [] }
    group.events.push(event)
    groups.set(key, group)
  }

  const days = new Map<string, TimelineDay>()
  const sorted = [...groups.values()].sort((a, b) => b.effective_at.localeCompare(a.effective_at))
  for (const group of sorted) {
    const key = dayKey(group.effective_at)
    const day = days.get(key) ?? { day: key, label: formatDay(key), entries: [] }
    day.entries.push({
      effective_at: group.effective_at,
      category: group.category,
      ...formatGroup(group.category, group.events),
    })
    days.set(key, day)
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day))
}

/** Which categories have any data — drives the filter chip row. */
export function categoriesPresent(events: StoredEvent[]): Category[] {
  const present = new Set<Category>()
  for (const { event } of events) {
    if (event.effective_at) present.add(categorize(event))
  }
  return [...present]
}
