// Shapes stored events into the spine's day/entry structure. Grouping key is
// (effective_at, category): that is what re-pairs a BP reading's two
// observations and a meal's per-item events into one visual entry, since the
// builders deliberately stamp them with one shared timestamp.
import {
  VITALS,
  BP_SYSTOLIC,
  BP_DIASTOLIC,
  EXERCISE_DURATION,
  MOOD,
  MOOD_NOTE,
  shortenSystem,
  type Code,
} from './codes'
import { categorize, type Category } from './category'
import type { EventKind } from './drafts'
import type { StoredEvent } from './events'
import { dayKey, formatDay } from './time'

/** The first event's raw provenance/coding, carried through for the spine
 * row's inline detail panel (SpineEntry). A group can fold several events
 * (a BP pair, a multi-item meal); the panel shows the shared fields of the
 * first, so only the first event's metadata travels here. */
export interface EntryDetail {
  kind: EventKind
  code: Code | null
  source: string
  sourceDoc: string | null
}

export interface TimelineEntry {
  effective_at: string
  category: Category
  label: string
  /** Formatted measurement, rendered in --font-data; '' when the label says it
   * all (a note, a meal). */
  value: string
  /** A single muted secondary slot for the coded/clinical rows whose label
   * degraded to the bare kind word, or that carry context the label can't
   * (a shortened coding, or the provenance source). Undefined when the label
   * already says everything. */
  hint?: string
  /** First-event provenance/coding for the inline detail panel. */
  detail: EntryDetail
  /** Symptom severity >= 7 — the amber correlation marker. */
  flare: boolean
  /** Every raw event id folded into this entry (a BP pair, a multi-item meal,
   * or — the common case — just one). The curation overlay (tags, hide) is
   * keyed per event id, not per presentational group; the spine simplifies by
   * reading/writing curation against `eventIds[0]` only (see SpineEntry) —
   * correct for the single-event groups curation is actually used on today
   * (a symptom, a note) and a documented simplification for the multi-event
   * ones. */
  eventIds: string[]
}

export interface TimelineDay {
  day: string
  label: string
  entries: TimelineEntry[]
}

type Ev = StoredEvent['event']

/** Pull a Quantity's value/unit out of an event, or null for a non-quantity.
 * Exported so summary.ts formats measurements exactly as the spine does rather
 * than re-deriving the shape. */
export function quantityOf(e: Ev): { value: string; unit: string } | null {
  if (e.value && 'quantity' in e.value) {
    return { value: e.value.quantity.value, unit: e.value.quantity.unit?.code ?? '' }
  }
  return null
}

/** `value unit`, unit-optional — the one place a Quantity becomes a string, so
 * vitals and the clinical/other rows render measurements identically. Exported
 * for summary.ts, which renders the same measurements in the clinician view. */
export function renderQuantity(q: { value: string; unit: string }): string {
  return `${q.value} ${q.unit}`.trim()
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
      value: renderQuantity(q),
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
  return { label: activity ?? 'Exercise', value: q ? renderQuantity(q) : '' }
}

/** Ordinal mood score -> the mockup's waxing-moon word. Single source: the
 * form's button labels, its favorite label, and this timeline formatting all
 * read off the same mapping. */
export const MOOD_WORDS: Record<number, string> = {
  1: 'rough',
  2: 'low',
  3: 'even',
  4: 'good',
  5: 'bright',
}

function formatMind(events: Ev[]): { label: string; value: string } {
  const mood = events.find((e) => e.code?.code === MOOD.code)
  if (mood) {
    const q = quantityOf(mood)
    const score = q ? Number(q.value) : NaN
    const word = MOOD_WORDS[score] ?? q?.value ?? ''
    const note = events.find((e) => e.code?.code === MOOD_NOTE.code)
    const noteText = note ? textOf(note) : null
    return { label: 'Mood', value: noteText ? `${word} — ${noteText}` : word }
  }
  // No mood observation in the group means it's a gratitude entry — every
  // gratitude item shares an effective_at, same as a multi-item meal.
  const items = events.map(textOf).filter((t): t is string => t !== null)
  return { label: 'Gratitude', value: items.join(' · ') }
}

function formatGroup(
  category: Category,
  events: Ev[],
): Omit<TimelineEntry, 'effective_at' | 'category' | 'eventIds' | 'detail'> {
  switch (category) {
    case 'vital':
      return { ...formatVitals(events), flare: false }
    case 'symptom':
      return formatSymptoms(events)
    case 'exercise':
      return { ...formatExercise(events), flare: false }
    case 'mind':
      return { ...formatMind(events), flare: false }
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
      // Encounters, conditions, immunizations, procedures, and uncoded
      // observations. The source often sends no display name, so the label can
      // degrade to the bare kind word — the hint then carries the coding or
      // provenance the label dropped.
      const first = events[0]
      const coded = first.value && 'coded' in first.value ? first.value.coded : null
      const humanKind = first.kind.replace(/_/g, ' ')
      const label = first.code?.display ?? coded?.display ?? humanKind
      const q = quantityOf(first)
      const value = textOf(first) ?? (q ? renderQuantity(q) : '')

      // First match wins: a shortened coding is the more precise anchor; the
      // provenance source is the fallback when the event carries no code.
      const coding = first.code ? `${shortenSystem(first.code.system)} ${first.code.code}` : null
      const source = first.provenance.source
      let hint: string | undefined
      if (coding && coding !== label) hint = coding
      else if (source && source !== 'self' && source !== label) hint = source

      return { label, value, hint, flare: false }
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
    const first = group.events[0]
    day.entries.push({
      effective_at: group.effective_at,
      category: group.category,
      eventIds: group.events.map((e) => e.id),
      detail: {
        kind: first.kind,
        code: first.code,
        source: first.provenance.source,
        sourceDoc: first.provenance.source_doc,
      },
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
