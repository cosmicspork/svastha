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

/** `prefs` key for {@link AnswerScopeRecord}. Device-local: a setting, not
 * record content. */
const SCOPE_KEY = 'ai-answer-scope'

/** The two-key shape an earlier build of this branch wrote; read once, for
 * migration, and never written again. See {@link loadAnswerScope}. */
const LEGACY_OPT_INS_KEY = 'ai-answer-opt-ins'

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
  const record = await loadAnswerScope()
  if (!record) return new Set()
  return new Set(record.include.filter((c) => OPT_IN_CATEGORIES.includes(c)))
}

/** The `include` array for an `admin_cmd` `set_answer_scope`: the whole set of
 * switch positions, in a stable order. Empty means "none of them", which is a
 * meaningful instruction and not a missing one — turning the last category off
 * still has to reach the node. */
export function includeList(optIns: ReadonlySet<Category>): Category[] {
  return OPT_IN_CATEGORIES.filter((c) => optIns.has(c))
}

// --- did the node actually apply it? ----------------------------------------
//
// Depositing a command on the relay is not the node applying it, and the gap is
// not hypothetical: a node older than this feature cannot deserialize the
// command at all, a node whose state file will not write answers `ok: false` and
// keeps its previous scope, and a node that is simply offline has not seen it.
// In every one of those cases the owner has turned Cycle off here while the node
// may still be reading it there.
//
// This device cannot make a remote node comply, so the honest thing — and the
// only thing — is to never claim it did. The command's `admin_reply` is the
// only evidence that exists, so it is tracked, and everything short of a
// confirming reply is shown as exactly that.

// ## Why this is ONE record and not two
//
// The desired scope and the command tracking it used to be two `prefs` keys,
// written one after the other. Each `put` is its own IndexedDB transaction, so
// the pair could land half-written — and the half that mattered was the second:
// an opt-out could save `[]`, fail to reach the relay, and fail to overwrite the
// *previous* command's record, leaving that command's id (and its `ok: true`
// reply) still matchable. The screen then said "Your node has applied this"
// about a node that was still reading Cycle. A false reassurance about the exact
// disclosure the owner had just tried to stop, which is worse than no reassurance
// at all. With no earlier command the same swallowed write degraded to `idle`,
// which is silent in a different way.
//
// So the desired scope and the tracking are one value under one key, written in
// a single `put`. Committing a new scope *is* invalidating the old confirmation;
// there is no window in which one has happened and the other has not. The id is
// filled in by a second, best-effort write after delivery — and if that one
// fails, what stays durable is `unsent`, which under-claims. Every partial
// failure has to land on the side of "your node may not have this yet".

/** How long to wait for a node's `admin_reply` before calling it unconfirmed.
 * Generous next to the node's reconcile cadence: the point is to stop waiting
 * silently, not to time the node. */
export const CONFIRM_WINDOW_MS = 90_000

/** The last scope command this device issued, kept so a reload can still tell
 * the owner whether the node ever confirmed it. `id` is the `admin_cmd`
 * envelope message id the reply carries as `in_reply_to`, or null when the
 * command never left this device at all.
 *
 * `include` is the set *this command carried*. It is stored even though the
 * record's own `include` is written alongside it: a reply only counts as
 * confirming the current desire if the command it answers asked for the current
 * desire, and comparing the two is what enforces that rather than assuming it.
 */
export interface PendingScopeCommand {
  id: string | null
  include: Category[]
  sentAt: string
}

/** The whole of this device's answer-scope state, written as one value. See the
 * note above on why it is not two. */
export interface AnswerScopeRecord {
  /** What the owner wants — the set `ask.ts` filters by. */
  include: Category[]
  /** The last command issued about it. Always present once anything has been
   * chosen, so "chosen but never tracked" is not a representable state. */
  pending: PendingScopeCommand
}

/** What this device knows about the node's agreement with the local choice. */
export type NodeScopeState =
  /** No node is enrolled — the local choice is the whole story. */
  | { state: 'no-node' }
  /** Nothing has been sent, because nothing has been chosen since enrolment. */
  | { state: 'idle' }
  /** Deposited; no reply yet, still inside {@link CONFIRM_WINDOW_MS}. */
  | { state: 'pending' }
  /** The node replied `ok` — this is the only state that claims agreement. */
  | { state: 'confirmed' }
  /** The node replied, and refused. */
  | { state: 'refused'; detail?: string }
  /** Deposited, but no reply came in time: offline, or a node too old to know
   * the command (it cannot parse it, so it never replies). */
  | { state: 'unconfirmed' }
  /** Never left this device (locked vault, no relay). */
  | { state: 'unsent' }

/** The reply-bearing shape {@link resolveNodeScopeState} reads from the admin
 * log. Structurally satisfied by `nodeadmin.ts`'s `AdminLogEntry`, taken as a
 * parameter rather than imported so this module stays free of that dependency
 * and unit-tests as a pure function. */
export interface ScopeReplyLookup {
  id: string
  reply?: { ok: boolean; detail?: string }
}

/**
 * Resolve what this device can honestly say about the node, from its own scope
 * record and the admin log's replies. Pure — the caller supplies `now` — so
 * every branch is directly testable.
 *
 * Two things are deliberately absent. There is no "assume it worked" branch: a
 * missing reply resolves to `unconfirmed`, never `confirmed`. And a reply only
 * confirms when the command it answers carried **the set the owner currently
 * wants** — a reply to a superseded command says nothing about the current one,
 * so the tracked `include` must match the record's before any confirmation is
 * honoured.
 */
export function resolveNodeScopeState(
  record: AnswerScopeRecord | undefined,
  log: ScopeReplyLookup[],
  hasNode: boolean,
  now: number,
): NodeScopeState {
  if (!hasNode) return { state: 'no-node' }
  // Nothing has ever been chosen. Once anything has, `pending` is written with
  // it in the same put, so this cannot be reached by a half-written choice.
  if (!record) return { state: 'idle' }

  const { include, pending } = record
  if (pending.id === null) return { state: 'unsent' }
  // Belt and braces over the atomic write: if the tracked command is for some
  // other set, it is not evidence about this one.
  if (!sameInclude(pending.include, include)) return { state: 'unsent' }

  const reply = log.find((e) => e.id === pending.id)?.reply
  if (reply) return reply.ok ? { state: 'confirmed' } : { state: 'refused', detail: reply.detail }
  const age = now - new Date(pending.sentAt).getTime()
  return age < CONFIRM_WINDOW_MS ? { state: 'pending' } : { state: 'unconfirmed' }
}

/** Both lists are built by {@link includeList}, so they are already in a stable
 * order; compared element-wise rather than by identity. */
function sameInclude(a: Category[], b: Category[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

/**
 * Read the record, migrating the two-key shape an earlier build of this branch
 * wrote. A legacy value carries no trustworthy tracking, so it is read as
 * `unsent` — the node may or may not have been told, and `unsent` is the reading
 * that does not over-claim.
 */
export async function loadAnswerScope(): Promise<AnswerScopeRecord | undefined> {
  const record = await get<AnswerScopeRecord>('prefs', SCOPE_KEY)
  if (record && Array.isArray(record.include) && record.pending) return record

  const legacy = await get<Category[]>('prefs', LEGACY_OPT_INS_KEY)
  if (!Array.isArray(legacy)) return undefined
  const include = legacy.filter((c) => OPT_IN_CATEGORIES.includes(c))
  return { include, pending: { id: null, include, sentAt: new Date(0).toISOString() } }
}

/** Write the record — the single put that is the commit point. Never wrapped by
 * callers committing a choice: a failure here means nothing changed. */
export async function saveAnswerScope(record: AnswerScopeRecord): Promise<void> {
  await put('prefs', record, SCOPE_KEY)
}

/**
 * Commit `optIns` as the desired scope **and** invalidate any previous
 * confirmation, in one write.
 *
 * This is the commit point in both senses: after it, `ask.ts` filters by the new
 * set, and no earlier command's reply can be mistaken for agreement with it.
 * Returns the record so the caller can fill in the command id after delivery
 * without re-reading.
 */
export async function commitScopeLocally(
  optIns: ReadonlySet<Category>,
): Promise<AnswerScopeRecord> {
  const include = includeList(optIns)
  const record: AnswerScopeRecord = {
    include,
    pending: { id: null, include, sentAt: new Date().toISOString() },
  }
  await saveAnswerScope(record)
  return record
}

/** Record that `record`'s command reached the relay under `id`. Best-effort by
 * design: the caller treats a failure as `unsent`, which is the state already
 * durably on disk, so a failure here costs the owner a needless retry and never
 * a false confirmation. Returns whether it landed. */
export async function trackScopeDelivery(
  record: AnswerScopeRecord,
  id: string,
): Promise<boolean> {
  try {
    await saveAnswerScope({ ...record, pending: { ...record.pending, id } })
    return true
  } catch {
    return false
  }
}
