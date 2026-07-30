// Answering a question on this device, with no processing node in the loop.
//
// The browser already holds the whole decrypted vault (see sync.ts / db.ts), so
// everything except the model call happens locally: assemble candidates, rank
// them in wasm, build the prompt, send only the retrieved lines to the endpoint,
// then ground the reply back to real event ids.
//
// Three properties this module exists to preserve:
//
//   0. **Opt-in entries are not candidates at all.** Cycle and mind entries are
//      filtered out before ranking (see `answerScope.ts`) unless the owner turned
//      that category on in Settings → AI, so they cannot be scored, rendered, or
//      sent. Scoping after ranking would be too late: an excluded entry would
//      already have shaped the prompt.
//   1. **Only the retrieved lines leave.** Not the vault, not the whole record —
//      the top `MAX_CONTEXT` rendered lines for this one question. What the
//      endpoint sees is bounded by what retrieval selected.
//   2. **A citation can only be an id that was supplied as context.** Grounding
//      runs in wasm against the same items, so a model cannot invent one; and an
//      answer that grounds to zero citations is replaced with the honest
//      can't-answer text rather than shown as uncited prose.
//
// Name resolution is done here rather than in the shared crate on purpose: the
// browser has the in-vault name index and the offline dictionary, so its context
// lines read better than the node's ever can.
import {
  initSvastha,
  rank_context,
  build_context_prompt,
  ground_answer,
  system_prompt,
  cant_answer_text,
} from './svastha'
import { allEvents, type StoredEvent } from './events'
import { allStatuses, allNames, type ConceptStatus } from './curation'
import { buildCodeNameIndex, resolveDisplay } from './code-names'
import { loadDictionaryIndex } from './dictionary'
import { conceptKey } from './summary'
import { loadConfig, chatComplete, endpointHost, InferenceError } from './inference'
import { appendLocalTurn, dropTurn } from './chat'
import { filterSensitive, loadOptIns } from './answerScope'
import type { Code } from './codes'

/** How many ranked items reach the model. Matches the node's `MAX_CONTEXT` so
 * both clients send comparably sized prompts. */
export const MAX_CONTEXT = 12

export interface GroundedAnswer {
  text: string
  /** Event content ids — always a subset of what was sent as context. Empty
   * means the answer could not be grounded, and `text` is the honest refusal. */
  citations: string[]
  /** Set when retrieval had to skip records this build cannot decode, so the
   * answer (or the refusal) was drawn from an incomplete record. Absent when the
   * whole vault was readable. The caller must show it alongside `text`. */
  caveat?: string
}

/** What `rank_context` returns: the items to send, and how many candidates this
 * build could not decode. */
interface Ranked {
  items: unknown[]
  unreadable: number
}

/**
 * What to tell the owner when `n` of their records could not be read.
 *
 * Said plainly and with the count, because the alternative is the app quietly
 * answering from part of the record and sounding as certain as if it had all of
 * it — and the one case that matters most is `n` records skipped and *nothing*
 * retrieved, where an uncaveated refusal reads as "you have none of that".
 */
export function unreadableCaveat(n: number): string {
  const [record, they, them] =
    n === 1 ? ['record', 'it was', 'it'] : ['records', 'they were', 'them']
  return `${n} ${record} on this device couldn't be read by this version of the app, so ${they} left out of this answer. Update the app to include ${them}.`
}

interface Candidate {
  event: StoredEvent['event']
  name: string
  status: ConceptStatus
}

/** The coding that identifies an event's concept: its own `code`, or — for
 * allergies, which import with `code: null` — the substance in `value.coded`.
 * Same rule as `summary.ts`'s `codingFor` and the node's `coding_for`. */
function codingFor(event: StoredEvent['event']): Code | null {
  if (event.code) return event.code
  const value = event.value
  if (value && 'coded' in value) return value.coded
  return null
}

function textOf(event: StoredEvent['event']): string | null {
  const value = event.value
  return value && 'text' in value ? value.text : null
}

/**
 * Resolve the display name for one event: the owner's `name:` override first,
 * then the code's own display, then a name borrowed from elsewhere in the vault
 * or the offline dictionary, then the event's free text, then the bare kind.
 *
 * Mirrors the node's `render_name` chain with the two layers the node lacks
 * (vault name index, dictionary) slotted in where they belong.
 */
export function resolveName(
  event: StoredEvent['event'],
  concept: string,
  names: Map<string, string>,
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): string {
  const override = names.get(concept)
  if (override) return override

  const coding = codingFor(event)
  if (coding) {
    if (coding.display?.trim()) return coding.display
    const resolved = resolveDisplay(nameIndex, coding, dictionary)
    if (resolved) return resolved
    return `${coding.system} ${coding.code}`
  }

  const text = textOf(event)
  if (text) return text
  return event.kind
}

/** Build the candidate list the ranker scores. Exported for tests. */
export function buildCandidates(
  events: StoredEvent[],
  statuses: Map<string, ConceptStatus>,
  names: Map<string, string>,
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): Candidate[] {
  return events.map((stored) => {
    const concept = conceptKey(stored.event)
    return {
      event: stored.event,
      name: resolveName(stored.event, concept, names, nameIndex, dictionary),
      status: statuses.get(concept) ?? 'active',
    }
  })
}

/** Everything retrieval needs, read once per question. */
async function gatherCandidates(): Promise<Candidate[]> {
  const [events, statuses, names] = await Promise.all([allEvents(), allStatuses(), allNames()])
  // The dictionary is optional and may not be downloaded; an empty map just
  // means codes fall through to the layers above it.
  const dictionary = await loadDictionaryIndex().catch(() => new Map<string, string>())
  // Scope before ranking, never after: an entry the owner has not opted in must
  // not be scored, rendered, or sent.
  //
  // And every index built alongside the candidates is derived from `inScope`
  // too, not from `events` — filtering only the candidate list is not enough.
  // `buildCodeNameIndex` keys on `system|code` *without* the kind, so a vault-
  // wide index will lend an excluded mind entry's `display` to an in-scope
  // event carrying the same code: the excluded entry never appears as a
  // candidate, and its label narrates the answer regardless. An excluded entry
  // has to be absent from everything the prompt is built from, not merely from
  // the list of things that can be cited.
  //
  // `statuses` and `names` need no such filtering, and the reason is worth
  // stating: both are keyed by `conceptKey`, which includes the event *kind*
  // alongside the coding, and two events sharing a concept key therefore share
  // the kind and coding that decide their category. Same key implies same
  // sensitivity, so a lookup by an in-scope candidate's key can never return a
  // record belonging to an excluded one. `buildCodeNameIndex` is the odd one
  // out precisely because it drops the kind from its key.
  const inScope = filterSensitive(events, await loadOptIns())
  return buildCandidates(inScope, statuses, names, buildCodeNameIndex(inScope), dictionary)
}

/**
 * Whether this device can answer without a node, and the host it would send to.
 *
 * Read together on purpose: the UI labels an answer with the host, and a label
 * derived from a second, later read could name an endpoint that is not the one
 * the answer actually went to.
 */
export async function localAnswerer(): Promise<{ ready: boolean; host: string }> {
  const config = await loadConfig()
  return {
    ready: !!config?.endpoint && !!config.model,
    host: endpointHost(config?.endpoint ?? ''),
  }
}

/** Whether this device can answer without a node. */
export async function canAnswerLocally(): Promise<boolean> {
  return (await localAnswerer()).ready
}

/**
 * Answer `question` from this device's own record.
 *
 * Retrieval returning nothing is answered honestly *without* calling the model —
 * there is no context to reason from, so a call could only produce ungrounded
 * prose. The same applies when a reply grounds to zero citations.
 *
 * Throws {@link InferenceError} only when the endpoint itself is unusable, so
 * the caller can distinguish "your setup is broken" from "your record doesn't
 * say".
 */
export async function askLocally(question: string): Promise<GroundedAnswer> {
  const config = await loadConfig()
  if (!config?.endpoint || !config.model) {
    throw new InferenceError('No inference endpoint is configured on this device.')
  }

  await initSvastha()
  const candidates = await gatherCandidates()
  const ranked = JSON.parse(
    rank_context(JSON.stringify(candidates), question, MAX_CONTEXT),
  ) as Ranked
  // Rides every return below, including the refusals: a record that could not be
  // read is a record missing from the answer, and "nothing found" over a partial
  // vault is the most misleading thing this screen can say.
  const caveat = ranked.unreadable > 0 ? { caveat: unreadableCaveat(ranked.unreadable) } : {}

  // The prompt and the grounding both read the items, not the wrapper.
  const contextJson = JSON.stringify(ranked.items)
  if (ranked.items.length === 0) {
    return { text: cant_answer_text(), citations: [], ...caveat }
  }

  const raw = await chatComplete(
    config,
    system_prompt(),
    build_context_prompt(question, contextJson),
  )

  const grounded = JSON.parse(ground_answer(raw, contextJson)) as {
    answer: string
    citations: string[]
  } | null

  // Uncited prose is never forwarded, however fluent — the whole point of the
  // citation contract is that an answer points at records you can open.
  if (!grounded || grounded.citations.length === 0) {
    return { text: cant_answer_text(), citations: [], ...caveat }
  }
  return { text: grounded.answer, citations: grounded.citations, ...caveat }
}

/**
 * Answer on this device and record both halves of the exchange.
 *
 * The question is written before the model is called so the transcript shows it
 * while the endpoint works. A failure takes it back out again, and that is the
 * whole point of doing this here: `conversationState` reads a trailing `user`
 * turn as `waiting`, so a question left behind by a failed answer greets every
 * later mount with "Reading your record…" for a reply that is never coming, and
 * the error that explains it is long gone. The caller re-offers the question in
 * the composer instead, where "Try again" can reach it.
 *
 * Rethrows whatever {@link askLocally} threw, so the caller still shows why.
 */
export async function askAndRecord(question: string): Promise<void> {
  const asked = await appendLocalTurn('user', question)
  try {
    const answer = await askLocally(question)
    // The caveat goes into the turn itself, not a transient banner: the
    // transcript is what gets re-read later, and an answer recorded without the
    // note that records were missing from it reads as complete forever.
    const body = answer.caveat ? `${answer.text}\n\n${answer.caveat}` : answer.text
    await appendLocalTurn('node', body, answer.citations)
  } catch (err) {
    await dropTurn(asked.id)
    throw err
  }
}
