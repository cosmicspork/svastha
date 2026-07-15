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
import { buildCodeNameIndex, resolveDisplay } from './code-names'
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

/** A note (a document+text event) carried by an entry: an imported visit
 * note's section title + prose, or a standalone personal note's own text. An
 * office-visit encounter folds its visit notes here (decision C2) instead of
 * their standing as separate spine rows; a standalone note carries its own
 * single ref. `eventIds` is the note event's id, for its own curation. */
export interface NoteRef {
  label: string
  text: string
  eventIds: string[]
}

/** A captured page referenced by a paper-record entry: its content address and
 * type, enough for the viewer to load and render it. */
export interface AttachmentRef {
  sha256: string
  mime: string
}

export interface TimelineEntry {
  effective_at: string
  category: Category
  label: string
  /** Present (and non-empty) when this entry is a captured paper record: the
   * pages, sha-sorted for a stable order (per-item events carry no sequence).
   * Drives the camera hint and, on tap, the full-screen viewer. */
  attachments?: AttachmentRef[]
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
  /** Notes this entry carries: an office-visit encounter's folded visit notes
   * (decision C2), or a standalone note's own single ref. Empty for every
   * other row. Rendered as titled prose (with a read-more) in the detail
   * panel; an encounter with notes also shows a "N notes" hint. */
  notes: NoteRef[]
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

/** The attachment pages in a group, sha-sorted so page order is stable (the
 * per-item events share an effective_at but carry no sequence). */
function attachmentRefs(events: Ev[]): AttachmentRef[] {
  return events
    .flatMap((e) => (e.value && 'attachment' in e.value ? [e.value.attachment] : []))
    .map((a) => ({ sha256: a.sha256, mime: a.mime }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256))
}

const VITAL_LABELS = new Map(VITALS.map((v) => [v.loinc.code, v.label]))

function formatVitals(
  events: Ev[],
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): { label: string; value: string } {
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
      label:
        VITAL_LABELS.get(e.code?.code ?? '') ??
        e.code?.display ??
        resolveDisplay(nameIndex, e.code, dictionary) ??
        'Vital',
      value: renderQuantity(q),
    })
  }
  if (parts.length === 0) return { label: 'Vitals', value: '' }
  if (parts.length === 1) return parts[0]
  return { label: 'Vitals', value: parts.map((p) => `${p.label} ${p.value}`).join(' · ') }
}

function formatSymptoms(
  events: Ev[],
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): { label: string; value: string; flare: boolean } {
  const names: string[] = []
  let maxSeverity: number | null = null
  for (const e of events) {
    names.push(e.code?.display ?? resolveDisplay(nameIndex, e.code, dictionary) ?? textOf(e) ?? 'Symptom')
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
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): Omit<TimelineEntry, 'effective_at' | 'category' | 'eventIds' | 'detail' | 'notes'> {
  switch (category) {
    case 'vital':
      return { ...formatVitals(events, nameIndex, dictionary), flare: false }
    case 'symptom':
      return formatSymptoms(events, nameIndex, dictionary)
    case 'exercise':
      return { ...formatExercise(events), flare: false }
    case 'mind':
      return { ...formatMind(events), flare: false }
    case 'med':
    case 'food': {
      // Per-item events carry no sequence (the store returns id order, i.e.
      // hash order), so sort for a stable join rather than a shuffling one.
      const texts = events
        .map(textOf)
        .filter((t): t is string => t !== null)
        .sort((a, b) => a.localeCompare(b))
      if (texts.length > 0) return { label: texts.join(', '), value: '', flare: false }

      // Quick-log always writes a text value, but imported medications carry
      // the name in code.display (and sometimes the dose as a quantity), so
      // without this fallback an imported med renders as a blank row.
      const first = events[0]
      const label =
        first.code?.display ?? resolveDisplay(nameIndex, first.code, dictionary) ?? first.kind.replace(/_/g, ' ')
      const q = quantityOf(first)
      const coding = first.code ? `${shortenSystem(first.code.system)} ${first.code.code}` : null
      const hint = coding && coding !== label ? coding : undefined
      return { label, value: q ? renderQuantity(q) : '', hint, flare: false }
    }
    default: {
      // Encounters, conditions, immunizations, procedures, and uncoded
      // observations. The source often sends no display name, so the label can
      // degrade to the bare kind word — the hint then carries the coding or
      // provenance the label dropped.
      const first = events[0]
      const coded = first.value && 'coded' in first.value ? first.value.coded : null
      const humanKind = first.kind.replace(/_/g, ' ')
      const resolved =
        resolveDisplay(nameIndex, first.code, dictionary) ?? resolveDisplay(nameIndex, coded, dictionary)
      const label = first.code?.display ?? coded?.display ?? resolved ?? humanKind
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

/** Longest first-line preview shown on a note row before eliding; the full
 * prose lives in the detail panel. */
const NOTE_PREVIEW_MAX = 90

function firstLinePreview(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  return firstLine.length > NOTE_PREVIEW_MAX
    ? `${firstLine.slice(0, NOTE_PREVIEW_MAX).trimEnd()}…`
    : firstLine
}

/** One `NoteRef` per text-bearing event in a note group — a visit note commonly
 * has several narrative sections (plan of care, assessment, ...) sharing the
 * visit date, so they land in one group but stay individually titled. */
function noteRefsOf(events: Ev[]): NoteRef[] {
  return events
    .map((e): NoteRef | null => {
      const text = textOf(e)
      if (text === null) return null
      return { label: e.code?.display ?? 'Note', text, eventIds: [e.id] }
    })
    .filter((n): n is NoteRef => n !== null)
}

/** A note row: a first-line preview label (full prose lives in the detail
 * panel via the entry's `notes`), no measurement value. */
function formatNote(
  events: Ev[],
  notes: NoteRef[],
): Omit<TimelineEntry, 'effective_at' | 'category' | 'eventIds' | 'detail' | 'notes'> {
  const preview = notes.length > 0 ? firstLinePreview(notes[0].text) : events[0].kind.replace(/_/g, ' ')
  return { label: preview, value: '', hint: undefined, flare: false }
}

/** A captured paper record: N photo events (attachment values) plus an
 * optional caption sibling (a text document). The caption is the label; the
 * camera hint carries the page count and the presence of `attachments` is
 * what opens the viewer on tap. */
function formatPaperRecord(
  events: Ev[],
  attachments: AttachmentRef[],
): Omit<TimelineEntry, 'effective_at' | 'category' | 'eventIds' | 'detail' | 'notes'> {
  const caption = events
    .map(textOf)
    .filter((t): t is string => t !== null)
    .join(', ')
  const pages = attachments.length
  return {
    label: caption || 'Paper record',
    value: '',
    hint: `📷 ${pages} ${pages === 1 ? 'page' : 'pages'}`,
    attachments,
    flare: false,
  }
}

/** An entry plus the scratch a nesting pass needs; the `entry` is what ships. */
interface Built {
  entry: TimelineEntry
  isEncounter: boolean
  sourceDoc: string | null
  nested: boolean
}

/** Decision C2: fold each note into an office-visit encounter when one clearly
 * owns it — same source document (a per-encounter Summary of Care carries the
 * encounter and its notes together), else the sole encounter on the note's
 * day. A note no encounter owns stands alone. */
function nestNotesUnderEncounters(built: Built[]): void {
  const encounters = built.filter((b) => b.isEncounter)
  if (encounters.length === 0) return

  for (const b of built) {
    if (b.entry.category !== 'note') continue
    // A paper record (or any note with no prose to carry over) keeps its own
    // row: folding it would hide the tap target that opens the photo viewer.
    if (b.entry.notes.length === 0 || (b.entry.attachments?.length ?? 0) > 0) continue
    const target = pickEncounterForNote(b, encounters)
    if (!target) continue
    target.entry.notes.push(...b.entry.notes)
    b.nested = true
  }

  // A subtle hint that the encounter row carries notes; occupies the muted
  // hint slot (overriding any coding/source hint — the note count is the more
  // useful anchor here).
  for (const enc of encounters) {
    const n = enc.entry.notes.length
    if (n > 0) enc.entry.hint = `${n} note${n === 1 ? '' : 's'}`
  }
}

function pickEncounterForNote(note: Built, encounters: Built[]): Built | undefined {
  const day = dayKey(note.entry.effective_at)
  // (a) same source document AND same day. Day agreement is required even on a
  // doc match: a longitudinal summary can hold dozens of encounters, and its
  // narrative dated to none of them belongs to no single visit — filing it
  // under an arbitrary one would move it off its own date. Unowned notes
  // stand alone instead.
  if (note.sourceDoc) {
    const owned = encounters.find(
      (e) => e.sourceDoc === note.sourceDoc && dayKey(e.entry.effective_at) === day,
    )
    if (owned) return owned
  }
  // (b) else: nest only when exactly one encounter shares the note's day.
  const sameDay = encounters.filter((e) => dayKey(e.entry.effective_at) === day)
  return sameDay.length === 1 ? sameDay[0] : undefined
}

/** Group, nest visit notes under their encounter (decision C2), then sort
 * (days desc, entries desc within a day) and format. Undated events can't be
 * placed on a timeline and are skipped. */
export function buildTimeline(
  events: StoredEvent[],
  filter: Category | 'all',
  // The offline code dictionary (see dictionary.ts), hydrated once per session
  // and passed in — never rebuilt here. Empty by default (feature off), which
  // reduces resolveDisplay's dictionary layer to a no-op.
  dictionary: Map<string, string> = new Map(),
): TimelineDay[] {
  // Built once from the full event set passed in, before filtering — a code's
  // display can live on an event of a different category or date than the row
  // rendering it (e.g. a lab named once at import, repeated undisplayed
  // afterward).
  const nameIndex = buildCodeNameIndex(events)
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

  const built: Built[] = []
  for (const group of groups.values()) {
    const first = group.events[0]
    const attachments = group.category === 'note' ? attachmentRefs(group.events) : []
    // A paper record's caption text event is its label, not detail-panel
    // prose, so an attachment group carries no NoteRefs.
    const notes = group.category === 'note' && attachments.length === 0 ? noteRefsOf(group.events) : []
    const formatted =
      group.category === 'note'
        ? attachments.length > 0
          ? formatPaperRecord(group.events, attachments)
          : formatNote(group.events, notes)
        : formatGroup(group.category, group.events, nameIndex, dictionary)
    built.push({
      entry: {
        effective_at: group.effective_at,
        category: group.category,
        eventIds: group.events.map((e) => e.id),
        detail: {
          kind: first.kind,
          code: first.code,
          source: first.provenance.source,
          sourceDoc: first.provenance.source_doc,
        },
        notes,
        ...formatted,
      },
      isEncounter: group.events.some((e) => e.kind === 'encounter'),
      sourceDoc: first.provenance.source_doc,
      nested: false,
    })
  }

  nestNotesUnderEncounters(built)

  const days = new Map<string, TimelineDay>()
  const visible = built
    .filter((b) => !b.nested)
    .map((b) => b.entry)
    .sort((a, b) => b.effective_at.localeCompare(a.effective_at))
  for (const entry of visible) {
    const key = dayKey(entry.effective_at)
    const day = days.get(key) ?? { day: key, label: formatDay(key), entries: [] }
    day.entries.push(entry)
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
