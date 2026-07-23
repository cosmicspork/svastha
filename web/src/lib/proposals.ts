// The proposal inbox: draft events a granted identity (a processing node today,
// a human caregiver later) deposited into the owner's mailbox for review. The
// owner approves / edits-then-approves / rejects each; approved drafts are
// signed by the owner's own device (stamping `proposed` provenance) and appended
// to the log, and the decision is echoed back to the proposer as a
// `proposal_result` envelope.
//
// This module is the pure persistence + decision layer: IndexedDB and plain
// stores only, no wasm and no relay, so it unit-tests under node vitest the same
// way notifications.ts / drafts.ts do. The crypto (verify/open the incoming
// envelope, seal the reply) lives in mailbox.ts, which owns the configured
// client and identity; the UI (routes/Proposals.svelte) drives the per-draft
// actions and the owner's signing.
import { writable } from 'svelte/store'
import { getAll, getAllFromIndex, get, put, del } from './db'
import type { EventKind, EventValue } from './drafts'
import type { Code } from './codes'

/** The core `Event` JSON a proposal draft carries: schema-valid and
 * content-addressed, but unsigned until the owner approves. Mirrors
 * `StoredEvent['event']` minus the (owner-stamped-on-approval) `proposed`. */
export interface DraftEvent {
  id: string
  kind: EventKind
  code: Code | null
  effective_at: string | null
  value: EventValue | null
  provenance: { source: string; source_doc: string | null }
}

export type DraftStatus = 'pending' | 'approved' | 'rejected'

/** One proposed event with its extraction provenance and the owner's decision.
 * `source_blob`/`method`/`model` are the proposer's extraction context (spec's
 * `DraftProposal`); they ride onto the approved event's `proposed` field. */
export interface ProposalDraft {
  event: DraftEvent
  source_blob?: string
  method?: string
  model?: string
  status: DraftStatus
}

/** One received proposal *message*, keyed by the envelope message id — the
 * spec's dedupe identity (see `spec/README.md`, "Message id and signing"), so a
 * re-pull of the same mailbox item never re-processes an already-seen batch. */
export interface ProposalRecord {
  /** Envelope message id (hex). Dedupe key and the `proposal_id` echoed back. */
  id: string
  /** The proposer's Ed25519 identity (hex), verified equal to the relay's
   * `svastha-from` attestation before this record was ever written. */
  fromEd: string
  /** The relay mailbox item id the envelope was fetched under, so the item can
   * be deleted once the whole proposal is resolved. Distinct from `id` (the
   * depositor chooses the item id; `id` is the signed content id inside). */
  mailboxItemId: string
  /** Envelope `sent_at` (Unix ms) — informational, never trusted for ordering. */
  sentAt: number
  /** ISO instant this device first stored the record. */
  receivedAt: string
  drafts: ProposalDraft[]
  /** Every draft decided (none still `pending`). */
  resolved: boolean
  /** The `proposal_result` was deposited back to the proposer's mailbox. */
  resultSent: boolean
}

/** The proposer identity directory: the label and — crucially — the X25519 key
 * needed to seal a `proposal_result` back to a proposer. Populated by node
 * enrollment (the granted identity's `svastha1:` code carries both keys); read
 * here. The incoming `proposal` envelope carries only the proposer's Ed25519
 * (`from`), so the reply key must come from this out-of-band record. */
export interface ProposerRecord {
  ed: string
  x25519: string
  label: string
  /** What this granted identity is, when enrollment knows: a processing `node`
   * (the ask screen + node admin surface act on it) or a human `caregiver`.
   * Optional and additive — a record written before this field, or by an
   * enrollment path that doesn't set it, reads back `undefined`, which the node
   * accessor (see nodeadmin.ts) treats as "not a node". Node enrollment (C1)
   * stamps `'node'`; until it does, no node resolves and the ask screen shows
   * its no-node empty state, which is the honest default. */
  kind?: 'node' | 'caregiver'
}

// --- pure helpers (unit-tested directly) ---

/** Build a fresh record from a verified, opened proposal envelope. Every draft
 * starts `pending`. */
export function buildProposalRecord(input: {
  id: string
  fromEd: string
  mailboxItemId: string
  sentAt: number
  drafts: { event: DraftEvent; source_blob?: string; method?: string; model?: string }[]
  receivedAt?: string
}): ProposalRecord {
  return {
    id: input.id,
    fromEd: input.fromEd,
    mailboxItemId: input.mailboxItemId,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    drafts: input.drafts.map((d) => ({ ...d, status: 'pending' as const })),
    resolved: false,
    resultSent: false,
  }
}

/** Records with at least one still-pending draft, oldest first (received
 * order) — the inbox works through them top to bottom. */
export function pendingRecords(records: ProposalRecord[]): ProposalRecord[] {
  return records
    .filter((r) => r.drafts.some((d) => d.status === 'pending'))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

/** Group records by proposer (Ed25519), preserving each group's received
 * order — the inbox lists one section per identity, with batch-approve across
 * all of that proposer's pending drafts. */
export function groupByProposer(records: ProposalRecord[]): Map<string, ProposalRecord[]> {
  const out = new Map<string, ProposalRecord[]>()
  for (const r of records) {
    const list = out.get(r.fromEd) ?? []
    list.push(r)
    out.set(r.fromEd, list)
  }
  return out
}

/** The `proposal_result` body for a resolved record: the proposer's own
 * proposal id, plus the *event content ids* it accepted and rejected (spec's
 * `ProposalResultBody`). */
export function resultBodyFor(record: ProposalRecord): {
  proposal_id: string
  accepted: string[]
  rejected: string[]
} {
  return {
    proposal_id: record.id,
    accepted: record.drafts.filter((d) => d.status === 'approved').map((d) => d.event.id),
    rejected: record.drafts.filter((d) => d.status === 'rejected').map((d) => d.event.id),
  }
}

export function isResolved(record: ProposalRecord): boolean {
  return record.drafts.every((d) => d.status !== 'pending')
}

/** Total still-pending drafts across records — the badge/notification count. */
export function pendingDraftCount(records: ProposalRecord[]): number {
  return records.reduce((n, r) => n + r.drafts.filter((d) => d.status === 'pending').length, 0)
}

// --- store ---

/** All records with pending drafts, mirrored for the badge and the inbox
 * screen. Hydrated on unlock and after every action; a plain `writable` (not a
 * rune module) so notifications.ts / node tests can read it without the Svelte
 * compiler. */
export const pendingProposals = writable<ProposalRecord[]>([])

// --- IndexedDB-backed ops ---

const STORE = 'proposals'

export function listProposals(): Promise<ProposalRecord[]> {
  return getAll<ProposalRecord>(STORE)
}

export function getProposal(id: string): Promise<ProposalRecord | undefined> {
  return get<ProposalRecord>(STORE, id)
}

/** Reload the `pendingProposals` store from IndexedDB. Called after any change. */
export async function refreshPendingProposals(): Promise<void> {
  pendingProposals.set(pendingRecords(await listProposals()))
}

/**
 * Store a freshly-received proposal, deduped by message id: if a record with
 * this id already exists it is left untouched (its decisions survive a re-pull),
 * and this returns `false`. A genuinely new record is written and returns
 * `true`. This is the "aren't re-processed on re-pull" guarantee.
 */
export async function upsertProposal(record: ProposalRecord): Promise<boolean> {
  if ((await getProposal(record.id)) !== undefined) return false
  await put(STORE, record)
  await refreshPendingProposals()
  return true
}

/** Set one draft's decision (by its event content id, stable across reloads).
 * Recomputes `resolved`. Persists and refreshes the store. Returns the updated
 * record (or undefined if the id/draft is unknown). */
export async function setDraftStatus(
  proposalId: string,
  eventId: string,
  status: DraftStatus,
): Promise<ProposalRecord | undefined> {
  const record = await getProposal(proposalId)
  if (!record) return undefined
  const draft = record.drafts.find((d) => d.event.id === eventId)
  if (!draft) return undefined
  draft.status = status
  record.resolved = isResolved(record)
  await put(STORE, record)
  await refreshPendingProposals()
  return record
}

/** Mark a resolved record's reply as sent (or record that the send failed). */
export async function markResultSent(proposalId: string, sent: boolean): Promise<void> {
  const record = await getProposal(proposalId)
  if (!record) return
  record.resultSent = sent
  await put(STORE, record)
  await refreshPendingProposals()
}

/** Forget a resolved proposal locally (e.g. after the reply is sent and the
 * mailbox item cleaned up). The inbox keeps only live work. */
export async function removeProposal(proposalId: string): Promise<void> {
  await del(STORE, proposalId)
  await refreshPendingProposals()
}

export function proposalsFrom(fromEd: string): Promise<ProposalRecord[]> {
  return getAllFromIndex<ProposalRecord>(STORE, 'from', IDBKeyRange.only(fromEd))
}

// --- proposer directory ---

export function getProposer(ed: string): Promise<ProposerRecord | undefined> {
  return get<ProposerRecord>('proposers', ed)
}

/** Every granted identity in the directory (nodes and caregivers alike). The
 * ask screen / node admin surface filter this for `kind === 'node'`. */
export function listProposers(): Promise<ProposerRecord[]> {
  return getAll<ProposerRecord>('proposers')
}

export function putProposer(record: ProposerRecord): Promise<void> {
  return put('proposers', record)
}
