// Local, on-device full-text search across a record. Pure over its inputs so it
// unit-tests without a browser, and it reuses the same label resolution the
// timeline/summary use (a med matches and shows by its resolved name, not a raw
// code). This is the always-available half of the Search screen; the AI half
// (routing a question to a processing node) lives in routes/Search.svelte and
// the node mailbox — deliberately not here.
import type { StoredEvent } from './events'
import { buildCodeNameIndex, resolveDisplay } from './code-names'
import { shortenSystem, type Code } from './codes'
import { categorize, CATEGORY_META } from './category'
import { isoToMillis } from './time'

/** Cap on returned hits — a search box wants the strongest matches, not the
 * whole record; the UI notes when more were elided. */
export const SEARCH_CAP = 50

export interface SearchHit {
  event: StoredEvent
  /** Best display label for the row (resolved name, else the free text, else
   * the category). */
  label: string
  /** Short coding hint, e.g. "RxNorm 313782"; empty when the event has no code. */
  coding: string
  /** Human category label, e.g. "Meds". */
  category: string
}

type Ev = StoredEvent['event']

function codeSearchText(code: Code | null | undefined, index: Map<string, string>): string {
  if (!code) return ''
  const display = code.display ?? resolveDisplay(index, code) ?? ''
  return `${display} ${shortenSystem(code.system)} ${code.code}`
}

function valueSearchText(value: Ev['value'], index: Map<string, string>): string {
  if (!value) return ''
  if ('text' in value) return value.text
  if ('coded' in value) return codeSearchText(value.coded, index)
  if ('quantity' in value) return `${value.quantity.value} ${value.quantity.unit?.code ?? ''}`
  return ''
}

/** Everything about an event a user might search by, lowercased into one blob. */
function haystack(ev: Ev, index: Map<string, string>): string {
  const category = CATEGORY_META[categorize(ev)].label
  return [codeSearchText(ev.code, index), valueSearchText(ev.value, index), ev.kind, category]
    .join(' ')
    .toLowerCase()
}

function labelFor(ev: Ev, index: Map<string, string>): string {
  const resolved = ev.code?.display ?? resolveDisplay(index, ev.code)
  if (resolved) return resolved
  if (ev.value && 'text' in ev.value && ev.value.text.trim()) return ev.value.text
  return CATEGORY_META[categorize(ev)].label
}

/**
 * Case-insensitive, AND-of-terms match over the record. An empty query returns
 * nothing (the screen shows a prompt, not the whole record). Results are newest
 * first (by `effective_at`, undated last) and capped at {@link SEARCH_CAP}; the
 * returned `truncated` says whether more matched than were returned.
 */
export function searchEvents(
  events: StoredEvent[],
  query: string,
): { hits: SearchHit[]; truncated: boolean } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { hits: [], truncated: false }

  const index = buildCodeNameIndex(events)
  const matched: SearchHit[] = []
  for (const e of events) {
    const ev = e.event
    if (!terms.every((t) => haystack(ev, index).includes(t))) continue
    matched.push({
      event: e,
      label: labelFor(ev, index),
      coding: ev.code ? `${shortenSystem(ev.code.system)} ${ev.code.code}` : '',
      category: CATEGORY_META[categorize(ev)].label,
    })
  }

  matched.sort((a, b) => {
    const am = a.event.event.effective_at ? isoToMillis(a.event.event.effective_at) : -Infinity
    const bm = b.event.event.effective_at ? isoToMillis(b.event.event.effective_at) : -Infinity
    return bm - am
  })

  return { hits: matched.slice(0, SEARCH_CAP), truncated: matched.length > SEARCH_CAP }
}
