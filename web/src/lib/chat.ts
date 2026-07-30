// The ask screen's conversation state: retrieval-augmented Q&A turns, ridden
// over the mailbox as `chat_msg` envelopes (design §9; body schema
// `{ role, text, citations }` in `spec/README.md`).
//
// Kept to IndexedDB and a plain `svelte/store` — no wasm and no relay — so it
// unit-tests under node vitest. The crypto (seal a question to the node, open an
// incoming answer) lives in mailbox.ts, which owns the configured client and
// identity.
import { writable } from 'svelte/store'
import { getAll, get, put, del, clear } from './db'

const STORE = 'chat'

/** One conversation turn. `user` turns are the owner's questions (stored the
 * moment they are sealed to the node); `node` turns are answers routed in from
 * the mailbox. Keyed by the mailbox envelope message id so a re-pulled answer
 * (or a re-sent question) never doubles — the spec's dedupe identity. */
export interface ChatTurn {
  id: string
  role: 'user' | 'node'
  text: string
  /** Event content ids an answer cited (always empty on a `user` turn). */
  citations: string[]
  /** Endpoint host that generated this local answer. Kept with the turn so a
   * later Settings change cannot rewrite where a recorded answer came from. */
  sourceHost?: string
  /** ISO instant this turn was recorded on this device. Drives order. */
  createdAt: string
}

/** Where the conversation stands. Purely a function of the turns, so a pending
 * state always reflects a question that is genuinely unanswered rather than a
 * spinner the UI resolves on its own. */
export type ConversationState = 'empty' | 'waiting' | 'answered'

/** Oldest-first, the order a transcript reads. Ties (same millisecond) break by
 * id so the order is stable across reloads. */
export function sortChronological(turns: ChatTurn[]): ChatTurn[] {
  return [...turns].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

export function conversationState(turns: ChatTurn[]): ConversationState {
  if (turns.length === 0) return 'empty'
  const newest = sortChronological(turns).at(-1)!
  return newest.role === 'user' ? 'waiting' : 'answered'
}

/** The whole conversation, chronological. A plain `writable` (not a rune
 * module) so it reads under node vitest without the Svelte compiler. */
export const chatTurns = writable<ChatTurn[]>([])

export function listChatTurns(): Promise<ChatTurn[]> {
  return getAll<ChatTurn>(STORE)
}

/** Hydrate the store from IndexedDB. Call on the ask screen mount. */
export async function refreshChat(): Promise<void> {
  chatTurns.set(sortChronological(await listChatTurns()))
}

/**
 * Persist a turn, deduped by id: a turn already stored under this id is left
 * untouched (returns `false`), so a re-pulled answer never re-appends. A new
 * turn is written and returns `true`.
 */
export async function appendTurn(turn: ChatTurn): Promise<boolean> {
  if ((await get<ChatTurn>(STORE, turn.id)) !== undefined) return false
  await put(STORE, turn)
  await refreshChat()
  return true
}

/**
 * Record a turn produced on this device rather than routed from the mailbox.
 *
 * Node turns key on the mailbox envelope's message id, which is the dedupe
 * identity for something that can be re-pulled. A local turn is never re-pulled,
 * so it just needs an id that cannot collide with an envelope id or with another
 * local turn — hence the `local-` prefix.
 */
export async function appendLocalTurn(
  role: ChatTurn['role'],
  text: string,
  citations: string[] = [],
  sourceHost?: string,
): Promise<ChatTurn> {
  const turn: ChatTurn = {
    id: `local-${crypto.randomUUID()}`,
    role,
    text,
    citations,
    ...(sourceHost ? { sourceHost } : {}),
    createdAt: new Date().toISOString(),
  }
  await appendTurn(turn)
  return turn
}

/**
 * Forget one turn.
 *
 * For a question whose answer failed outright: the transcript is a record of
 * exchanges, and a question with no reply and no reply coming is not one — it is
 * what `conversationState` would read as `waiting` forever. Not an undo, and not
 * offered to the owner: nothing deletes an answered turn.
 */
export async function dropTurn(id: string): Promise<void> {
  await del(STORE, id)
  await refreshChat()
}

/** Forget the whole conversation (store + IndexedDB). Used by lock/teardown and
 * an explicit "clear" affordance. */
export async function clearChat(): Promise<void> {
  chatTurns.set([])
  await clear(STORE)
}
