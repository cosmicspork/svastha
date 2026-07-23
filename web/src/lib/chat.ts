// The ask screen's conversation state: retrieval-augmented Q&A turns with the
// owner's processing node, ridden over the mailbox as `chat_msg` envelopes
// (design §9; body schema `{ role, text, citations }` in `spec/README.md`). This
// module is the pure persistence + state layer — IndexedDB and a plain
// `svelte/store` only, no wasm and no relay — so it unit-tests under node vitest
// exactly like proposals.ts / notifications.ts. The crypto (seal a question to
// the node, open an incoming answer) lives in mailbox.ts, which owns the
// configured client and identity; the UI (routes/Ask.svelte) drives sending and
// renders answers with their citations.
//
// Nothing produces answers in production yet — the node's RAG is a later PR
// (D3) — so a sent question stays in the `waiting` state until a fixture (tests)
// or the real node deposits an answer. That waiting state is deliberate and
// honest, never a fake spinner that resolves itself.
import { writable } from 'svelte/store'
import { getAll, get, put, clear } from './db'

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
  /** ISO instant this turn was recorded on this device. Drives order. */
  createdAt: string
}

/** Where the conversation stands, for the honest pending UI:
 * - `empty` — no turns yet.
 * - `waiting` — the newest turn is the owner's question; no answer has arrived.
 * - `answered` — the newest turn is an answer.
 * Purely a function of the turns, so the UI never invents a resolving spinner. */
export type ConversationState = 'empty' | 'waiting' | 'answered'

// --- pure helpers (unit-tested directly) ---

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

// --- store ---

/** The whole conversation, chronological. A plain `writable` (not a rune
 * module) so it reads under node vitest without the Svelte compiler. */
export const chatTurns = writable<ChatTurn[]>([])

// --- IndexedDB-backed ops ---

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

/** Forget the whole conversation (store + IndexedDB). Used by lock/teardown and
 * an explicit "clear" affordance. */
export async function clearChat(): Promise<void> {
  chatTurns.set([])
  await clear(STORE)
}
