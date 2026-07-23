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
import { pendingInvites, type PendingInvite } from './shared'
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

// --- wiring ---

let client: MailboxClient | null = null
let identity: MailboxIdentity | null = null
let verifyMessage: VerifyMessage | null = null

export function configureMailbox(
  c: MailboxClient,
  id: MailboxIdentity,
  verify: VerifyMessage,
): void {
  client = c
  identity = id
  verifyMessage = verify
}

export function teardownMailbox(): void {
  client = null
  identity = null
  verifyMessage = null
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

// --- pull ---

export interface MailboxPullResult {
  /** Invites surfaced this pull (legacy deposits + key_handoff envelopes). */
  invites: PendingInvite[]
  /** New proposal messages stored (deduped by message id). */
  proposalsAdded: number
  /** Items dropped: a tampered/failed-verification envelope, a from-mismatch,
   * a body that would not open, or unparseable bytes — counted and logged the
   * way the share viewer counts dropped events. */
  dropped: number
  /** Envelopes of a kind this layer does not act on yet (proposal_result,
   * admin_*, chat_msg, unknown) — tolerated and skipped, not dropped. */
  ignored: number
}

/**
 * Scan the mailbox once and route every item. Sets `pendingInvites` wholesale
 * (the invites found this pass, matching the previous invite scanner's
 * replace-each-scan semantics) and upserts any new proposals. Idempotent and
 * safe to call from the sync pull cycle and a screen mount alike.
 */
export async function pullMailbox(): Promise<MailboxPullResult> {
  const result: MailboxPullResult = { invites: [], proposalsAdded: 0, dropped: 0, ignored: 0 }
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
      const invite = legacyInvite(classified.deposit, fetched.from, itemId)
      if (invite) result.invites.push(invite)
      else result.dropped++
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
        const invite = keyHandoffInvite(body, env.from, itemId)
        if (invite) result.invites.push(invite)
        else result.dropped++
        break
      }
      case 'proposal': {
        const added = await handleProposal(env, itemId, body)
        if (added) result.proposalsAdded++
        break
      }
      default:
        // proposal_result, admin_cmd, admin_reply, chat_msg, and any unknown
        // future kind: tolerated and skipped (spec's additive-versioning rule).
        result.ignored++
    }
  }

  pendingInvites.set(result.invites)
  return result
}

/** Validate a legacy deposit into a `PendingInvite` (same checks the previous
 * invite scanner made): the relay's attested depositor must match the payload's
 * `from_ed`, and the wrapped key must actually unwrap to us. */
function legacyInvite(
  deposit: LegacyDeposit,
  relayFrom: string,
  itemId: string,
): PendingInvite | null {
  if (relayFrom !== deposit.from_ed) {
    console.warn(`mailbox item ${itemId}: svastha-from does not match the legacy payload, ignoring`)
    return null
  }
  if (!unwrapsToUs(deposit.wrapped_hex)) {
    console.warn(`mailbox item ${itemId}: legacy wrapped key does not unwrap, ignoring`)
    return null
  }
  return {
    mailboxId: itemId,
    fromEd: deposit.from_ed,
    fromX: deposit.from_x25519,
    label: deposit.label,
    wrappedKeyHex: deposit.wrapped_hex,
  }
}

/** A verified `key_handoff` envelope's body into a `PendingInvite` — equivalent
 * to the legacy deposit, just carried inside the typed, signed envelope. The
 * envelope `from` is already verified; bind the body's `from_ed` to it too. */
function keyHandoffInvite(body: Uint8Array, envelopeFrom: string, itemId: string): PendingInvite | null {
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
  if (!unwrapsToUs(parsed.wrapped_hex)) {
    console.warn(`mailbox item ${itemId}: key_handoff wrapped key does not unwrap, dropping`)
    return null
  }
  return {
    mailboxId: itemId,
    fromEd: parsed.from_ed,
    fromX: parsed.from_x25519,
    label: parsed.label,
    wrappedKeyHex: parsed.wrapped_hex,
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
