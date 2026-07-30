// The node admin surface's state: resolving *the owner's* processing node from
// the granted-identity directory, sending it owner-signed `admin_cmd` envelopes,
// and folding its `admin_reply` answers back (design §9; body schemas in
// `spec/README.md`, "Mailbox message envelope"). Pure persistence + directory
// reads only — no wasm, no relay — so it unit-tests under node vitest like
// proposals.ts / chat.ts. The crypto (seal a command to the node, open a reply)
// lives in mailbox.ts.
//
// Trust rule (design §1): these commands administer the node's work on *your*
// vault — set the inference endpoint it uses for your record, ask the status of
// your jobs, tail its log. Node-*global* operations (restart, upgrade) belong to
// the host operator and deliberately have no command here.
import { writable } from 'svelte/store'
import { getAll, get, put } from './db'
import { CATEGORY_META, type Category } from './category'
import { listProposers, type ProposerRecord } from './proposals'
import { getGrantMeta } from './grants'

const STORE = 'admin_log'
const LAST_SEEN_KEY = 'node-last-seen'

/** The owner→node commands (mirrors core's `AdminCommand`, tag `cmd`). The set
 * is exactly the vault-scoped operations; there is intentionally no restart or
 * upgrade. `log_tail`'s `lines` is optional (the node defaults it). */
export type AdminCommand =
  // The endpoint the node runs THIS owner's pages and questions against
  // (crates/node/src/inference.rs) — not the node's, and not anyone else's.
  // `api_key` rides inside the sealed body, which is why it may be here at all:
  // the envelope is sealed to the node before it is signed, so the relay stores
  // ciphertext. Omitted means "no key", never "unchanged".
  | { cmd: 'set_inference_endpoint'; endpoint: string; api_key?: string }
  // A node reads nothing until it is resumed (crates/node/src/ocr_control.rs).
  | { cmd: 'pause_ocr' }
  | { cmd: 'resume_ocr' }
  | { cmd: 'job_status' }
  | { cmd: 'log_tail'; lines?: number }
  // Which opt-in categories the node's answers may read for this vault
  // (crates/node/src/answer_scope.rs). `include` is the whole set of switch
  // positions, not a delta, so `[]` is the meaningful "none" — turning the last
  // category off has to reach the node just as turning one on does.
  | { cmd: 'set_answer_scope'; include: Category[] }

/** The node's answer to one command (mirrors core's `AdminReplyBody`, minus the
 * `in_reply_to` id which becomes this row's key). */
export interface AdminReply {
  ok: boolean
  detail?: string
  receivedAt: string
}

/** One issued command and (once it lands) the node's reply. Keyed by the
 * `admin_cmd` envelope message id, which the reply carries as `in_reply_to`, so
 * a reply folds onto the exact command it answers. */
export interface AdminLogEntry {
  id: string
  command: AdminCommand
  sentAt: string
  reply?: AdminReply
}

// --- pure helpers (unit-tested directly) ---

/** A short human label for a command, for the log row. */
export function describeCommand(command: AdminCommand): string {
  switch (command.cmd) {
    case 'set_inference_endpoint':
      // The endpoint, never the key: this string is rendered into the admin log
      // and read back on a screen anyone looking over a shoulder can see.
      return `Set your inference endpoint → ${command.endpoint}`
    case 'job_status':
      return 'Requested job status'
    case 'log_tail':
      return command.lines ? `Requested log tail (${command.lines} lines)` : 'Requested log tail'
    case 'pause_ocr':
      return 'Paused page reading'
    case 'resume_ocr':
      return 'Resumed page reading'
    case 'set_answer_scope':
      return command.include.length > 0
        ? `Let answers read ${command.include.map((c) => CATEGORY_META[c].label).join(' and ')}`
        : 'Kept opt-in entries out of answers'
  }
}

/** Newest-issued first — the log reads most-recent at the top. */
export function sortNewestFirst(entries: AdminLogEntry[]): AdminLogEntry[] {
  return [...entries].sort((a, b) => b.sentAt.localeCompare(a.sentAt))
}

/**
 * The single source of "which identities are the owner's node": the granted
 * identity directory (`proposers`) filtered to `kind === 'node'`. Both the
 * send-target resolution (`enrolledNode`) and the inbound sender gate
 * (`isEnrolledNode`) go through this one filter, so the gate can never drift
 * from the target — a `chat_msg`/`admin_reply` is only accepted from an identity
 * a question/command could have been sent to.
 */
async function nodeProposers(): Promise<ProposerRecord[]> {
  const proposers = await listProposers()
  // A node proposer carries `kind: 'node'`. Installs that enrolled before that
  // stamp was written (the enroll path omitted it) have a `kind`-less record, so
  // fall back to the grant metadata, which has always recorded the grantee kind.
  // This heals an already-enrolled node at read time — no migration, no re-enrol.
  const meta = await getGrantMeta()
  return proposers.filter((p) => p.kind === 'node' || meta[p.ed]?.kind === 'node')
}

/**
 * The enrolled processing node, or `null` when none is enrolled. Node enrollment
 * (C1) writes the directory. The ask screen and this surface both treat a `null`
 * here as the first-class "no node enrolled" empty state. The design models a
 * single node ("my node"); if several ever carried the marker, the first is used
 * (documented, not a supported multi-node story in v1).
 */
export async function enrolledNode(): Promise<ProposerRecord | null> {
  return (await nodeProposers())[0] ?? null
}

/**
 * The inbound sender gate: is `ed` an enrolled node? Envelope verification only
 * proves the sender *signed* the message — mailbox deposits are open to any
 * authenticated identity (that is how invites work), so a valid signature is not
 * proof the sender is the owner's node. An `answer`/`admin_reply` is rendered as
 * coming from the node only when this holds; anything else is dropped, never
 * shown. Accepting chat from non-node identities, if it is ever wanted, must
 * arrive by deliberate design, not by default-accept.
 */
export async function isEnrolledNode(ed: string): Promise<boolean> {
  return (await nodeProposers()).some((p) => p.ed === ed)
}

/** The admin command/reply log, newest first. A plain `writable` (not a rune
 * module) so it reads under node vitest without the Svelte compiler. */
export const adminLog = writable<AdminLogEntry[]>([])

export function listAdminLog(): Promise<AdminLogEntry[]> {
  return getAll<AdminLogEntry>(STORE)
}

export async function refreshAdminLog(): Promise<void> {
  adminLog.set(sortNewestFirst(await listAdminLog()))
}

/** Record a freshly-sent command (its reply lands later via `applyAdminReply`).
 * Keyed by the command's envelope message id. */
export async function recordCommand(entry: AdminLogEntry): Promise<void> {
  await put(STORE, entry)
  await refreshAdminLog()
}

/**
 * Fold a node reply onto the command it answers (`inReplyTo` = the command's
 * envelope id). A no-op when no such command is on record (a reply to a command
 * this device never issued, or one already garbage-collected) — returns whether
 * it matched. Idempotent: a re-pulled reply overwrites with identical data.
 */
export async function applyAdminReply(
  inReplyTo: string,
  reply: AdminReply,
): Promise<boolean> {
  const entry = await get<AdminLogEntry>(STORE, inReplyTo)
  if (!entry) return false
  entry.reply = reply
  await put(STORE, entry)
  await refreshAdminLog()
  return true
}

// --- node last-seen (most recent envelope from the node) ---
//
// Stored in `prefs` rather than a store of its own: it is a single scalar and
// survives clearing the conversation or the admin log.

export function getNodeLastSeen(): Promise<string | undefined> {
  return get<string>('prefs', LAST_SEEN_KEY)
}

/** Advance last-seen to `iso` when it is newer than what is stored (an envelope
 * arriving out of order never rewinds it). */
export async function noteNodeSeen(iso: string): Promise<void> {
  const current = await getNodeLastSeen()
  if (current && current >= iso) return
  await put('prefs', iso, LAST_SEEN_KEY)
}
