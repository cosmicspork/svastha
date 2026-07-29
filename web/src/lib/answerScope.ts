// Which of the owner's entries an AI answer is allowed to read.
//
// Retrieval ranks over the whole vault (see `ask.ts`), so without a gate here a
// question about tiredness can put a period log or a mood note into the prompt
// that goes to a configured endpoint — a disclosure the owner never made, about
// the part of the record they are least likely to have meant to share. So the
// categories `CATEGORY_META` already marks `sensitive` (cycle, mind) are
// **excluded from retrieval by default**, and included only per category, only
// where the owner says so.
//
// This deliberately mirrors `doctorShare.ts`'s structure — the sensitive set is
// derived from the same flag, the filter is a pure function over `StoredEvent[]`,
// and the opt-in is an explicit list rather than an absence. Shares solved this
// problem first; answering should not invent a second shape for it, because the
// owner has to be able to carry one rule in their head, not two.
//
// The same choice governs the node: it rides to an enrolled node as an
// `admin_cmd` `set_answer_scope` (see `nodeadmin.ts`), and the node applies it to
// its own retrieval before ranking. What is stored here is the owner's intent;
// the node holds its own copy of that intent for the vaults it serves.
import { get, put } from './db'
import { CATEGORIES, CATEGORY_META, categorize, type Category } from './category'
import type { StoredEvent } from './events'

/** The opt-in categories, in `CATEGORIES` display order. Derived from the
 * `sensitive` flag rather than listed, so marking a new category sensitive
 * closes it to answers and gives it a switch in one edit. */
export const OPT_IN_CATEGORIES: Category[] = CATEGORIES.filter((c) => CATEGORY_META[c].sensitive)

/** `prefs` key for the owner's opt-ins. Device-local: it is a setting, not
 * record content, and it is the same shape the node is told separately. */
const OPT_INS_KEY = 'ai-answer-opt-ins'

/**
 * Drop the events retrieval may not read: an entry in a sensitive category the
 * owner has not opted in. Pure and standalone so `gatherCandidates` applies it
 * in one line, and so a test can pin the exclusion without a vault, a ranker, or
 * an endpoint.
 *
 * Everything not sensitive passes untouched — this narrows the record, it never
 * re-scopes it.
 */
export function filterSensitive(
  events: StoredEvent[],
  optIns: ReadonlySet<Category>,
): StoredEvent[] {
  return events.filter((se) => {
    const category = categorize(se.event)
    return !CATEGORY_META[category].sensitive || optIns.has(category)
  })
}

/** The owner's opt-ins, or an empty set when they have never chosen — which is
 * the default, and the whole point: nothing sensitive is readable until it is
 * turned on. A stored category that is no longer sensitive is dropped, so the
 * stored value can never re-open something the taxonomy has moved. */
export async function loadOptIns(): Promise<Set<Category>> {
  const stored = await get<Category[]>('prefs', OPT_INS_KEY)
  if (!Array.isArray(stored)) return new Set()
  return new Set(stored.filter((c) => OPT_IN_CATEGORIES.includes(c)))
}

/** Persist the owner's opt-ins as an explicit list in {@link OPT_IN_CATEGORIES}
 * order — the same list the node is sent, so the two can be read side by side. */
export async function saveOptIns(optIns: ReadonlySet<Category>): Promise<Category[]> {
  const include = includeList(optIns)
  await put('prefs', include, OPT_INS_KEY)
  return include
}

/** The `include` array for an `admin_cmd` `set_answer_scope`: the whole set of
 * switch positions, in a stable order. Empty means "none of them", which is a
 * meaningful instruction and not a missing one — turning the last category off
 * still has to reach the node. */
export function includeList(optIns: ReadonlySet<Category>): Category[] {
  return OPT_IN_CATEGORIES.filter((c) => optIns.has(c))
}
