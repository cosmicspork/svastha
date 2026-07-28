// Answering a question on this device, with no processing node in the loop.
//
// The browser already holds the whole decrypted vault (see sync.ts / db.ts), so
// everything except the model call happens locally: assemble candidates, rank
// them in wasm, build the prompt, send only the retrieved lines to the endpoint,
// then ground the reply back to real event ids.
//
// Two properties this module exists to preserve:
//
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
import { loadConfig, chatComplete, InferenceError } from './inference'
import type { Code } from './codes'

/** How many ranked items reach the model. Matches the node's `MAX_CONTEXT` so
 * both clients send comparably sized prompts. */
export const MAX_CONTEXT = 12

export interface GroundedAnswer {
  text: string
  /** Event content ids — always a subset of what was sent as context. Empty
   * means the answer could not be grounded, and `text` is the honest refusal. */
  citations: string[]
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
  return buildCandidates(events, statuses, names, buildCodeNameIndex(events), dictionary)
}

/** Whether this device can answer without a node. */
export async function canAnswerLocally(): Promise<boolean> {
  const config = await loadConfig()
  return !!config?.endpoint && !!config.model
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
  const contextJson = rank_context(JSON.stringify(candidates), question, MAX_CONTEXT)
  const context = JSON.parse(contextJson) as unknown[]
  if (context.length === 0) {
    return { text: cant_answer_text(), citations: [] }
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
    return { text: cant_answer_text(), citations: [] }
  }
  return { text: grounded.answer, citations: grounded.citations }
}
