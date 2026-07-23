// The one mailbox-consumption layer. Every deposit in the owner's mailbox is a
// typed, sealed, signed envelope (see `spec/README.md`, "Mailbox message
// envelope") — or a grandfathered bare wrapped-key deposit from before the
// envelope existed. This module lists the mailbox once per pull, verifies each
// item (verify-or-drop, dropping and counting a tampered one exactly as the
// share viewer drops a tampered event), opens it, and routes it by kind:
//
//   key_handoff / legacy deposit -> a household-share invite (shared.ts)
//   proposal                      -> the proposal inbox (proposals.ts)
//   anything else (proposal_result, admin_cmd/reply, chat_msg, unknown future
//                  kinds)          -> ignored, per the spec's additive-versioning
//                                     "unknown kinds are tolerated" rule
//
// C3 (ask screen, node admin) extends this by registering handlers for
// chat_msg / admin_* against the same dispatch table — it does not add a second
// mailbox scanner. C2 deliberately implements only the two live kinds plus the
// ignore path; it does not speculatively handle chat/admin bodies.
//
// Like sync.ts / shared.ts, this module never imports the rune-based session
// runtime: the relay client, the identity, and the wasm `verify_message` are
// injected via `configureMailbox`, wired from vault.ts. That injection is also
// what keeps the classification and dispatch unit-testable under node vitest
// with fakes, no wasm and no browser.
import { fromHex } from './hex'
import {
  pendingInvites,
  type PendingInvite,
  type KeyHandoffInfo,
  type KeyHandoffOutcome,
} from './shared'
import {
  buildProposalRecord,
  upsertProposal,
  getProposal,
  markResultSent,
  removeProposal,
  resultBodyFor,
  getProposer,
  type DraftEvent,
} from './proposals'
import { appendTurn, type ChatTurn } from './chat'
import {
  applyAdminReply,
  recordCommand,
  noteNodeSeen,
  isEnrolledNode,
  type AdminCommand,
} from './nodeadmin'

/** The mailbox surface this layer needs. `RelayClient` satisfies it
 * structurally (mirrors shared.ts's `SharingClient`). */
export interface MailboxClient {
  listMailbox(): Promise<{ id: string; from: string }[]>
  getMailbox(id: string): Promise<{ blob: Uint8Array; from: string } | null>
  deleteMailbox(id: string): Promise<boolean>
  putMailbox(recipientHex: string, id: string, blob: Uint8Array): Promise<void>
}

/** The identity operations this layer needs. `WasmIdentity` satisfies it
 * structurally. `unwrap_key` is used only to validate that a handed-off key
 * actually unwraps to us before surfacing an invite (mirrors shared.ts). */
export interface MailboxIdentity {
  open_message(envelopeJson: string): Uint8Array
  seal_message(recipientX25519: Uint8Array, kind: string, sentAt: number, body: Uint8Array): string
  unwrap_key(wrapped: Uint8Array): unknown
  readonly ed25519_public_hex: string
  readonly x25519_public_hex: string
}

/** The verify-or-drop gate: the wasm `verify_message` (recomputes the id and
 * checks the signature against `from`). Injected so tests supply a fake. */
export type VerifyMessage = (envelopeJson: string) => boolean

/** Decides what an incoming, already-verified key handoff (or legacy bare-key
 * deposit) is: a fresh share to surface as an invite, a re-keying to merge into an
 * existing share, or nothing for us. Injected from vault.ts (see shared.ts's
 * `handleIncomingKeyHandoff`); absent, the layer falls back to today's
 * unwrap-and-invite behavior — which is all the unit tests exercise. */
export type KeyHandoffHandler = (info: KeyHandoffInfo) => Promise<KeyHandoffOutcome>

// --- wiring ---

let client: MailboxClient | null = null
let identity: MailboxIdentity | null = null
let verifyMessage: VerifyMessage | null = null
let keyHandoffHandler: KeyHandoffHandler | null = null

export function configureMailbox(
  c: MailboxClient,
  id: MailboxIdentity,
  verify: VerifyMessage,
  keyHandoff?: KeyHandoffHandler,
): void {
  client = c
  identity = id
  verifyMessage = verify
  keyHandoffHandler = keyHandoff ?? null
}

export function teardownMailbox(): void {
  client = null
  identity = null
  verifyMessage = null
  keyHandoffHandler = null
}

// --- pure classification (unit-tested directly) ---

/** The flat typed-envelope wire shape (see spec). Byte fields are hex. */
export interface Envelope {
  v: number
  kind: string
  from: string
  sent_at: number
  id: string
  body: string
  signature: string
}

/** The grandfathered bare wrapped-key deposit (pre-envelope): a small unsigned
 * JSON blob. Still parses within the contract major. */
export interface LegacyDeposit {
  v: number
  from_ed: string
  from_x25519: string
  label: string
  wrapped_hex: string
}

export type Classified =
  | { type: 'envelope'; envelope: Envelope }
  | { type: 'legacy'; deposit: LegacyDeposit }
  | { type: 'unparseable' }

/**
 * Classify a raw mailbox item's bytes, the same unambiguous split
 * `core::mailbox::parse_mailbox_item` makes: a typed envelope requires
 * `kind`/`from`/`id`/`body`/`signature`; a legacy deposit requires
 * `from_ed`/`from_x25519`/`wrapped_hex`; neither parses as the other. Anything
 * else is unparseable (dropped by the caller). Pure — no crypto, no I/O.
 */
export function classifyMailboxItem(text: string): Classified {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { type: 'unparseable' }
  }
  if (!json || typeof json !== 'object') return { type: 'unparseable' }
  const o = json as Record<string, unknown>

  const hasEnvelopeShape =
    typeof o.kind === 'string' &&
    typeof o.from === 'string' &&
    typeof o.id === 'string' &&
    typeof o.body === 'string' &&
    typeof o.signature === 'string'
  if (hasEnvelopeShape) {
    return {
      type: 'envelope',
      envelope: {
        v: Number(o.v ?? 0),
        kind: o.kind as string,
        from: o.from as string,
        sent_at: Number(o.sent_at ?? 0),
        id: o.id as string,
        body: o.body as string,
        signature: o.signature as string,
      },
    }
  }

  const hasLegacyShape =
    typeof o.from_ed === 'string' &&
    typeof o.from_x25519 === 'string' &&
    typeof o.wrapped_hex === 'string'
  if (hasLegacyShape) {
    return {
      type: 'legacy',
      deposit: {
        v: Number(o.v ?? 1),
        from_ed: o.from_ed as string,
        from_x25519: o.from_x25519 as string,
        label: typeof o.label === 'string' ? o.label : '',
        wrapped_hex: o.wrapped_hex as string,
      },
    }
  }

  return { type: 'unparseable' }
}

/** The kind-specific proposal body (spec's `ProposalBody`). */
interface ProposalBody {
  proposals: { event: DraftEvent; source_blob?: string; method?: string; model?: string }[]
}

/** The kind-specific key-handoff body (spec's `KeyHandoffBody`). */
interface KeyHandoffBody {
  from_ed: string
  from_x25519: string
  label: string
  wrapped_hex: string
}

/** The kind-specific chat body (spec's `ChatMsgBody`). The owner deposits
 * `question` turns; the node deposits `answer` turns carrying `citations`. */
interface ChatMsgBody {
  role: 'question' | 'answer'
  text: string
  citations?: string[]
}

/** The kind-specific admin-reply body (spec's `AdminReplyBody`). `in_reply_to`
 * is the owner's `admin_cmd` message id, so a reply folds onto its command. */
interface AdminReplyBody {
  in_reply_to: string
  ok: boolean
  detail?: string
}

// --- pull ---

export interface MailboxPullResult {
  /** Invites surfaced this pull (legacy deposits + key_handoff envelopes). */
  invites: PendingInvite[]
  /** New proposal messages stored (deduped by message id). */
  proposalsAdded: number
  /** Re-keying handoffs merged into an existing share (post-rotation), rather
   * than surfaced as a fresh invite. */
  merged: number
  /** Items dropped: a tampered/failed-verification envelope, a from-mismatch,
   * a body that would not open, or unparseable bytes — counted and logged the
   * way the share viewer counts dropped events. */
  dropped: number
  /** Node answers stored this pull (verified `chat_msg` answer turns, deduped by
   * message id). */
  chatAnswers: number
  /** Node `admin_reply` bodies folded onto their issued command this pull. */
  adminReplies: number
  /** Envelopes of a kind this layer does not act on (proposal_result, admin_cmd,
   * a chat question echoed back, an orphan reply, unknown future kinds) —
   * tolerated and skipped, not dropped. */
  ignored: number
}

/**
 * Scan the mailbox once and route every item. Sets `pendingInvites` wholesale
 * (the invites found this pass, matching the previous invite scanner's
 * replace-each-scan semantics) and upserts any new proposals. Idempotent and
 * safe to call from the sync pull cycle and a screen mount alike.
 */
export async function pullMailbox(): Promise<MailboxPullResult> {
  const result: MailboxPullResult = {
    invites: [],
    proposalsAdded: 0,
    merged: 0,
    dropped: 0,
    chatAnswers: 0,
    adminReplies: 0,
    ignored: 0,
  }
  if (!client || !identity || !verifyMessage) return result

  const items = await client.listMailbox()
  for (const { id: itemId } of items) {
    const fetched = await client.getMailbox(itemId)
    if (!fetched) continue

    const text = new TextDecoder().decode(fetched.blob)
    const classified = classifyMailboxItem(text)

    if (classified.type === 'unparseable') {
      console.warn(`mailbox item ${itemId}: unparseable, dropping`)
      result.dropped++
      continue
    }

    if (classified.type === 'legacy') {
      const d = classified.deposit
      if (fetched.from !== d.from_ed) {
        console.warn(`mailbox item ${itemId}: svastha-from does not match the legacy payload, ignoring`)
        result.dropped++
        continue
      }
      await routeKeyHandoff(
        { fromEd: d.from_ed, fromX: d.from_x25519, label: d.label, wrappedHex: d.wrapped_hex, itemId },
        result,
      )
      continue
    }

    // Typed envelope: verify-or-drop BEFORE opening (the sealed-then-signed
    // posture — the signature commits to the sealed body via the id).
    const env = classified.envelope
    if (!verifyMessage(text)) {
      console.warn(`mailbox item ${itemId}: envelope failed verification, dropping`)
      result.dropped++
      continue
    }
    // Bind the relay's `svastha-from` attestation to the signed `from`: the
    // signature already proves `from` authored the envelope, and this proves
    // the depositor the relay authenticated is that same identity.
    if (fetched.from !== env.from) {
      console.warn(`mailbox item ${itemId}: svastha-from does not match envelope from, dropping`)
      result.dropped++
      continue
    }

    let body: Uint8Array
    try {
      body = identity.open_message(text)
    } catch {
      // verify passed but the body would not open (sealed to someone else, or
      // corrupt) — drop, don't crash the rest of the scan.
      console.warn(`mailbox item ${itemId}: body did not open, dropping`)
      result.dropped++
      continue
    }

    switch (env.kind) {
      case 'key_handoff': {
        const info = keyHandoffInfo(body, env.from, itemId)
        if (info) await routeKeyHandoff(info, result)
        else result.dropped++
        break
      }
      case 'proposal': {
        const added = await handleProposal(env, itemId, body)
        if (added) result.proposalsAdded++
        break
      }
      case 'chat_msg': {
        const outcome = await handleChatMsg(env, itemId, body)
        if (outcome === 'stored') result.chatAnswers++
        else if (outcome === 'dropped') result.dropped++
        else result.ignored++
        break
      }
      case 'admin_reply': {
        const outcome = await handleAdminReply(env, itemId, body)
        if (outcome === 'applied') result.adminReplies++
        else if (outcome === 'dropped') result.dropped++
        else result.ignored++
        break
      }
      default:
        // proposal_result (echoed to a proposer, not received here), admin_cmd
        // (owner→node, never received here), and any unknown future kind:
        // tolerated and skipped (spec's additive-versioning rule).
        result.ignored++
    }
  }

  pendingInvites.set(result.invites)
  return result
}

/**
 * Route one incoming key handoff (a re-keyed keyring, or a grandfathered bare
 * wrapped key) through the injected decision handler: `invite` surfaces a fresh
 * share invite, `merged` folds a re-keying into an existing share (the item is
 * consumed and deleted), `drop` is nothing for us. Absent a handler (the unit-test
 * path), fall back to today's unwrap-and-invite behavior.
 */
async function routeKeyHandoff(info: KeyHandoffInfo, result: MailboxPullResult): Promise<void> {
  if (!keyHandoffHandler) {
    if (unwrapsToUs(info.wrappedHex)) {
      result.invites.push({
        mailboxId: info.itemId,
        fromEd: info.fromEd,
        fromX: info.fromX,
        label: info.label,
        wrappedKeyHex: info.wrappedHex,
      })
    } else {
      console.warn(`mailbox item ${info.itemId}: wrapped key does not unwrap, ignoring`)
      result.dropped++
    }
    return
  }

  const outcome = await keyHandoffHandler(info)
  if (outcome === 'invite') {
    result.invites.push({
      mailboxId: info.itemId,
      fromEd: info.fromEd,
      fromX: info.fromX,
      label: info.label,
      wrappedKeyHex: info.wrappedHex,
    })
  } else if (outcome === 'merged') {
    // The re-keying is now folded into the existing share; consume the item.
    await client?.deleteMailbox(info.itemId)
    result.merged++
  } else {
    result.dropped++
  }
}

/** Parse a verified `key_handoff` envelope's body into a `KeyHandoffInfo`. The
 * envelope `from` is already verified; bind the body's `from_ed` to it too. */
function keyHandoffInfo(body: Uint8Array, envelopeFrom: string, itemId: string): KeyHandoffInfo | null {
  let parsed: KeyHandoffBody
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as KeyHandoffBody
  } catch {
    console.warn(`mailbox item ${itemId}: key_handoff body not valid JSON, dropping`)
    return null
  }
  if (parsed.from_ed !== envelopeFrom) {
    console.warn(`mailbox item ${itemId}: key_handoff body from_ed does not match envelope from, dropping`)
    return null
  }
  return {
    fromEd: parsed.from_ed,
    fromX: parsed.from_x25519,
    label: parsed.label,
    wrappedHex: parsed.wrapped_hex,
    itemId,
  }
}

function unwrapsToUs(wrappedHex: string): boolean {
  if (!identity) return false
  try {
    identity.unwrap_key(fromHex(wrappedHex))
    return true
  } catch {
    return false
  }
}

/** Persist a verified proposal batch, deduped by envelope message id. Returns
 * whether it was newly stored. */
async function handleProposal(env: Envelope, itemId: string, body: Uint8Array): Promise<boolean> {
  let parsed: ProposalBody
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as ProposalBody
  } catch {
    console.warn(`mailbox item ${itemId}: proposal body not valid JSON, dropping`)
    return false
  }
  if (!Array.isArray(parsed.proposals) || parsed.proposals.length === 0) return false

  const record = buildProposalRecord({
    id: env.id,
    fromEd: env.from,
    mailboxItemId: itemId,
    sentAt: env.sent_at,
    drafts: parsed.proposals.map((p) => ({
      event: p.event,
      source_blob: p.source_blob,
      method: p.method,
      model: p.model,
    })),
  })
  return upsertProposal(record)
}

/** A verified inbound node message's fate: rendered, refused, or tolerated. */
type NodeMsgOutcome = 'stored' | 'applied' | 'dropped' | 'ignored'

/**
 * Store a verified `chat_msg` **answer** as a node turn, deduped by envelope
 * message id, and advance the node's last-seen. **Sender-gated:** the envelope
 * signature proves who signed, not that the signer is the owner's node — mailbox
 * deposits are open to any authenticated identity — so an answer from an
 * identity that is not an enrolled node is `dropped` (never stored, never
 * rendered as if it came from the node), not merely ignored. Only an `answer`
 * role is stored (the owner never receives its own `question`); a node's
 * non-answer is tolerated (`ignored`). The item is deleted once handled by the
 * node: an answer is terminal, unlike a proposal the owner acts on later.
 */
async function handleChatMsg(env: Envelope, itemId: string, body: Uint8Array): Promise<NodeMsgOutcome> {
  if (!(await isEnrolledNode(env.from))) return 'dropped'

  let parsed: ChatMsgBody
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as ChatMsgBody
  } catch {
    return 'ignored'
  }
  if (parsed.role !== 'answer') return 'ignored'

  const turn: ChatTurn = {
    id: env.id,
    role: 'node',
    text: parsed.text ?? '',
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    createdAt: new Date().toISOString(),
  }
  const added = await appendTurn(turn)
  await noteNodeSeen(turn.createdAt)
  if (client) await client.deleteMailbox(itemId)
  return added ? 'stored' : 'ignored'
}

/**
 * Fold a verified `admin_reply` onto the `admin_cmd` it answers, advance
 * last-seen, and delete the item. **Sender-gated** identically to
 * `handleChatMsg`: a reply from an identity that is not an enrolled node is
 * `dropped`. Beyond the gate, `in_reply_to` must match a command this device
 * actually issued — commands only ever go to the enrolled node, so the two
 * together mean a reply is accepted only from the node the command was sent to;
 * an orphan reply (no such command) is tolerated (`ignored`).
 */
async function handleAdminReply(env: Envelope, itemId: string, body: Uint8Array): Promise<NodeMsgOutcome> {
  if (!(await isEnrolledNode(env.from))) return 'dropped'

  let parsed: AdminReplyBody
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as AdminReplyBody
  } catch {
    return 'ignored'
  }
  if (typeof parsed.in_reply_to !== 'string' || parsed.in_reply_to === '') return 'ignored'

  const applied = await applyAdminReply(parsed.in_reply_to, {
    ok: parsed.ok === true,
    detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
    receivedAt: new Date().toISOString(),
  })
  await noteNodeSeen(new Date().toISOString())
  if (client) await client.deleteMailbox(itemId)
  return applied ? 'applied' : 'ignored'
}

// --- outbound: seal owner→node chat questions and admin commands ---
//
// The ask screen and node admin surface call these; they own the sealing (to
// the node's X25519, from the proposer directory) and deposit, then record the
// local turn / command, mirroring how `resolveProposalIfDone` below seals and
// deposits a reply. The medical content in a question is sealed here and never
// logged.

/** The minimum a send needs from the node directory: where to deposit (Ed25519)
 * and what to seal to (X25519). `ProposerRecord` satisfies it structurally. */
export interface NodeTarget {
  ed: string
  x25519: string
}

/** The message id the relay and every client dedupe on lives inside the sealed
 * envelope JSON (see spec's "Message id"); read it back so the local turn keys
 * on the exact same id an eventual reply/echo will reference. */
function messageIdOf(envelopeJson: string): string {
  return (JSON.parse(envelopeJson) as { id: string }).id
}

/**
 * Seal a `chat_msg` question to the node and deposit it, then store the local
 * `user` turn keyed by the envelope message id. Returns the stored turn, or
 * `null` if the mailbox layer is not configured. Never logs `text` (it is
 * medical content).
 */
export async function sendChatMessage(node: NodeTarget, text: string): Promise<ChatTurn | null> {
  if (!client || !identity) return null
  const body = new TextEncoder().encode(JSON.stringify({ role: 'question', text, citations: [] }))
  const envelope = identity.seal_message(fromHex(node.x25519), 'chat_msg', Date.now(), body)
  const id = messageIdOf(envelope)
  await client.putMailbox(node.ed, `chat-${id}`, new TextEncoder().encode(envelope))
  const turn: ChatTurn = { id, role: 'user', text, citations: [], createdAt: new Date().toISOString() }
  await appendTurn(turn)
  return turn
}

/**
 * Seal an `admin_cmd` to the node and deposit it, then record the local command
 * keyed by the envelope message id (so the node's `admin_reply`, which carries
 * that id as `in_reply_to`, folds back onto it). Returns whether it was sent.
 */
export async function sendAdminCommand(node: NodeTarget, command: AdminCommand): Promise<boolean> {
  if (!client || !identity) return false
  const body = new TextEncoder().encode(JSON.stringify({ command }))
  const envelope = identity.seal_message(fromHex(node.x25519), 'admin_cmd', Date.now(), body)
  const id = messageIdOf(envelope)
  await client.putMailbox(node.ed, `admin-${id}`, new TextEncoder().encode(envelope))
  await recordCommand({ id, command, sentAt: new Date().toISOString() })
  return true
}

// --- resolution: echo the decision back to the proposer ---

/**
 * Once every draft in a proposal is decided, seal a `proposal_result` back to
 * the proposer's mailbox, delete the now-handled incoming item, and forget the
 * proposal locally. A no-op while any draft is still pending.
 *
 * The reply is sealed to the proposer's **X25519** key, which the incoming
 * `proposal` envelope does not carry (it carries only the proposer's Ed25519
 * `from`). We resolve it from the `proposers` directory (node enrollment writes
 * it; see proposals.ts). If it is unknown, the local resolution still stands —
 * approved events were already signed and synced — but the reply is deferred
 * and `resultSent` stays false, so a later pass (once enrollment is known) can
 * complete it. Returns whether the reply was sent.
 */
export async function resolveProposalIfDone(proposalId: string): Promise<boolean> {
  if (!client || !identity) return false
  const record = await getProposal(proposalId)
  if (!record || !record.resolved || record.resultSent) return false

  const proposer = await getProposer(record.fromEd)
  if (!proposer) {
    // Can't seal the reply without the proposer's X25519 key. Leave the item in
    // the mailbox and the record unsent; approvals already landed regardless.
    console.warn(`proposal ${proposalId}: proposer ${record.fromEd} not in directory — reply deferred`)
    await markResultSent(proposalId, false)
    return false
  }

  try {
    const bodyJson = JSON.stringify(resultBodyFor(record))
    const envelope = identity.seal_message(
      fromHex(proposer.x25519),
      'proposal_result',
      Date.now(),
      new TextEncoder().encode(bodyJson),
    )
    // Deposit into the proposer's own mailbox under a fresh, unique item id.
    const replyId = `proposal-result-${record.id.slice(0, 32)}`
    await client.putMailbox(proposer.ed, replyId, new TextEncoder().encode(envelope))
    await client.deleteMailbox(record.mailboxItemId)
    await removeProposal(proposalId)
    return true
  } catch (err) {
    console.warn(`proposal ${proposalId}: sending proposal_result failed:`, err)
    await markResultSent(proposalId, false)
    return false
  }
}
