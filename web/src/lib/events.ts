// Signing and persistence for quick-log drafts, plus the event queries the
// timeline and recents chips read. Depends on the unlocked session (wasm
// identity) — the pure builders live in ./drafts.ts.
import { put, getAll, getAllFromIndex } from './db'
import { session } from './session.svelte'
import type { Code } from './codes'
import type { Draft, DraftTemplate, EventKind, EventValue } from './drafts'
import { categorize, type Category } from './category'

/** The JSON form of core's `SignedEvent`, as stored in the `events` store
 * (keyed on `event.id`). */
export interface StoredEvent {
  event: {
    id: string
    kind: EventKind
    code: Code | null
    effective_at: string | null
    value: EventValue | null
    provenance: { source: string; source_doc: string | null }
  }
  author: string
  signature: string
}

/** Called after every successful `logEvent` with the freshly stored events.
 * A no-op today, reassigned via `setOnEventsLogged` when sync arrives (push to
 * the relay) — a mutable hook keeps this module from depending on code that
 * doesn't exist yet. */
export let onEventsLogged: (events: StoredEvent[]) => void = () => {}

export function setOnEventsLogged(hook: (events: StoredEvent[]) => void): void {
  onEventsLogged = hook
}

/** Sign each draft with the session identity and store it. Ids are
 * content-addressed, so re-saving an identical draft is an idempotent `put`,
 * not a duplicate. */
export async function logEvent(drafts: Draft[]): Promise<StoredEvent[]> {
  const identity = session.identity
  if (!identity) throw new Error('Session is locked — cannot sign events.')

  const stored: StoredEvent[] = []
  for (const draft of drafts) {
    const content = {
      kind: draft.kind,
      code: draft.code ?? null,
      effective_at: draft.effective_at,
      value: draft.value,
      provenance: { source: 'self', source_doc: null },
    }
    const signed = JSON.parse(identity.sign_event(JSON.stringify(content))) as StoredEvent
    await put('events', signed)
    stored.push(signed)
  }
  onEventsLogged(stored)
  return stored
}

export function allEvents(): Promise<StoredEvent[]> {
  return getAll<StoredEvent>('events')
}

/** Events with `fromIso <= effective_at <= toIso`, via the effective_at index.
 * Undated events have no index entry and are correctly excluded. */
export function eventsBetween(fromIso: string, toIso: string): Promise<StoredEvent[]> {
  return getAllFromIndex<StoredEvent>('events', 'effective_at', IDBKeyRange.bound(fromIso, toIso))
}

/** A human label for a template chip: prefer the code's display, fall back to
 * the text value. */
export function templateLabel(template: DraftTemplate): string {
  if (template.code?.display) return template.code.display
  if ('text' in template.value) return template.value.text
  return template.code?.code ?? template.kind
}

function templateKey(t: DraftTemplate): string {
  // Recents dedupe on what a chip would re-log: the code identifies coded
  // entries regardless of the measured value; text entries ARE their value.
  if (t.code) return `${t.kind}|${t.code.system}|${t.code.code}`
  return `${t.kind}|${'text' in t.value ? t.value.text.toLowerCase() : JSON.stringify(t.value)}`
}

/** Per-category event counts over the last `days` days — the bloom's
 * frequency ordering reads this so petals reflect recent habits, not
 * once-off history from months ago. */
export async function categoryLogCounts(days = 90): Promise<Partial<Record<Category, number>>> {
  const events = await allEvents()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  const counts: Partial<Record<Category, number>> = {}
  for (const { event } of events) {
    if (!event.effective_at || new Date(event.effective_at).getTime() < cutoff) continue
    const category = categorize(event)
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
}

/** Distinct recently-logged combos in a category, newest first — the source of
 * the recents chips. */
export async function recentDrafts(category: Category, limit: number): Promise<DraftTemplate[]> {
  const events = await allEvents()
  events.sort((a, b) => (b.event.effective_at ?? '').localeCompare(a.event.effective_at ?? ''))

  const seen = new Set<string>()
  const out: DraftTemplate[] = []
  for (const { event } of events) {
    if (event.value === null || categorize(event) !== category) continue
    const template: DraftTemplate = {
      kind: event.kind,
      ...(event.code ? { code: event.code } : {}),
      value: event.value,
    }
    const key = templateKey(template)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(template)
    if (out.length >= limit) break
  }
  return out
}
