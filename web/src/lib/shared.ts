// Spousal sharing: accepted shares, the read-only event cache pulled from
// each, and the mailbox invite flow that creates them. Kept separate from
// sync.ts (which owns *this* device's own event log) because a share is a
// different trust boundary — read-only, someone else's vault key, someone
// else's signing identity — even though the wire mechanics (list, diff,
// fetch, open) are the same shape. See docs/ARCHITECTURE.md, "Vaults and
// grants".
//
// Like sync.ts, this module avoids importing session.svelte.ts's rune-based
// runtime directly: the relay/mailbox client and the unwrapping identity are
// passed in explicitly via `configureSharing`, wired from vault.ts (which
// already holds the session) rather than read from it here.
import { get, put, del, getAll, getAllFromIndex } from './db'
import { verify_event } from './svastha'
import { fromHex } from './hex'
import { base64ToBytes } from './base64'
import { writable } from 'svelte/store'
import type { StoredEvent } from './events'

/** Local lowercase-hex SHA-256, duplicated (like sync.ts's own) to keep this
 * module free of an import cycle. Used to check a pulled `att-` blob's bytes
 * against the content hash its blob id claims. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The relay surface sharing needs — narrower than `RelayClient` so tests can
 * supply an in-memory fake, same reasoning as sync.ts's `BlobClient`. */
export interface SharingClient {
  listShared(): Promise<string[]>
  listSharedBlobs(ownerHex: string): Promise<string[] | null>
  getSharedBlob(ownerHex: string, id: string): Promise<Uint8Array | null>
  listMailbox(): Promise<{ id: string; from: string }[]>
  getMailbox(id: string): Promise<{ blob: Uint8Array; from: string } | null>
  deleteMailbox(id: string): Promise<boolean>
}

/** Opens ciphertext sealed under a vault key — `WasmDataKey` satisfies this
 * structurally (mirrors sync.ts's `SealKey`, read-only since a share is). */
export interface OpenKey {
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array
}

/** Unwraps a vault key that was wrapped to this device's own identity — this
 * device's `WasmIdentity` satisfies this structurally. */
export interface UnwrapIdentity {
  unwrap_key(wrapped: Uint8Array): OpenKey
}

/** One accepted share: someone else's vault, read-only. */
export interface Share {
  ownerEd: string
  ownerX: string
  label: string
  wrappedKeyHex: string
  hue: 'a' | 'b'
  acceptedAt: string
  /** Set once a pull finds the grant gone (`listSharedBlobs` 404s) — cleared
   * again if a later pull succeeds. The record and its cached events are kept
   * either way; only the UI (person screen, Home chip) reads this to say
   * "no longer shared with you" instead of silently going stale. */
  stale?: boolean
}

/** One event pulled from a share, keyed `[ownerEd, id]` in `shared_events` —
 * an id is only unique within one owner's log. */
interface SharedEventRow {
  ownerEd: string
  id: string
  event: StoredEvent
}

export function listShares(): Promise<Share[]> {
  return getAll<Share>('shares')
}

export function getShare(ownerEd: string): Promise<Share | undefined> {
  return get<Share>('shares', ownerEd)
}

export function putShare(share: Share): Promise<void> {
  return put('shares', share)
}

/** Forget a share on this device only. Does not touch the relay grant — the
 * owner revokes that from their own Share screen; this just stops this
 * device from showing or pulling it. */
export async function removeShare(ownerEd: string): Promise<void> {
  await del('shares', ownerEd)
  unwrappedKeys.delete(ownerEd)
}

/** This owner's cached events, newest-diff-agnostic (callers sort/group as
 * needed — same contract as `events.ts`'s `allEvents`). */
export async function sharedEventsFor(ownerEd: string): Promise<StoredEvent[]> {
  const rows = await getAllFromIndex<SharedEventRow>(
    'shared_events',
    'by-owner',
    IDBKeyRange.only(ownerEd),
  )
  return rows.map((r) => r.event)
}

// --- wiring ---

let sharingClient: SharingClient | null = null
let unwrapIdentity: UnwrapIdentity | null = null

/** Cached unwrapped owner vault keys, one DH unwrap per share per session
 * rather than per pull. Cleared on `teardownSharing`. */
const unwrappedKeys = new Map<string, OpenKey>()

export function configureSharing(client: SharingClient, identity: UnwrapIdentity): void {
  sharingClient = client
  unwrapIdentity = identity
}

export function teardownSharing(): void {
  sharingClient = null
  unwrapIdentity = null
  unwrappedKeys.clear()
  pendingInvites.set([])
}

// --- mailbox invites ---

/** A `vaultkey-*` mailbox item, verified but not yet accepted or declined.
 * Lives only in memory — nothing is written locally until the user decides. */
export interface PendingInvite {
  mailboxId: string
  fromEd: string
  fromX: string
  label: string
  wrappedKeyHex: string
}

export const pendingInvites = writable<PendingInvite[]>([])

// The mailbox scan that surfaces these invites lives in mailbox.ts (the one
// mailbox-consumption layer): it verifies each item, routes a key_handoff or a
// grandfathered bare wrapped-key deposit to an invite, and sets `pendingInvites`
// wholesale. This module keeps only the invite *state* and the accept/decline
// actions, since a household share has its own trust boundary and lifecycle
// (`putShare`, `pullShared`) distinct from the envelope plumbing.

/** Accept: store the share, forget the mailbox item, and pull their vault. */
export async function acceptInvite(invite: PendingInvite, hue: 'a' | 'b'): Promise<void> {
  await putShare({
    ownerEd: invite.fromEd,
    ownerX: invite.fromX,
    label: invite.label,
    wrappedKeyHex: invite.wrappedKeyHex,
    hue,
    acceptedAt: new Date().toISOString(),
  })
  await sharingClient?.deleteMailbox(invite.mailboxId)
  pendingInvites.update((all) => all.filter((i) => i.mailboxId !== invite.mailboxId))
  await pullShared()
}

/** Decline: forget the mailbox item only — nothing is ever stored locally. */
export async function declineInvite(invite: PendingInvite): Promise<void> {
  await sharingClient?.deleteMailbox(invite.mailboxId)
  pendingInvites.update((all) => all.filter((i) => i.mailboxId !== invite.mailboxId))
}

// --- shared pull ---

/** AAD binding, identical in shape to sync.ts's own: the blob id itself, so a
 * malicious relay cannot swap ciphertext between two blob ids undetected. */
function aad(blobId: string): Uint8Array {
  return new TextEncoder().encode(blobId)
}

/**
 * Pull every accepted share's new events. Mirrors sync.ts's own-vault pull
 * (list, diff, fetch, open, verify) against someone else's vault key, plus an
 * author check: a shared vault is single-writer by contract, so an event
 * whose signature verifies but whose author isn't the vault owner must still
 * be rejected — the relay could otherwise splice in a foreign-signed event
 * without breaking the crypto.
 *
 * State tracking deliberately has no separate "sync" bookkeeping: the known
 * set for each owner is read straight from `shared_events`' `by-owner` index,
 * which already IS the diff state (an id present there has been pulled). A
 * prefixed `sync`-store entry per share would track the same fact twice.
 */
export async function pullShared(): Promise<void> {
  if (!sharingClient || !unwrapIdentity) return

  for (const share of await listShares()) {
    try {
      let key = unwrappedKeys.get(share.ownerEd)
      if (!key) {
        key = unwrapIdentity.unwrap_key(fromHex(share.wrappedKeyHex))
        unwrappedKeys.set(share.ownerEd, key)
      }

      const ids = await sharingClient.listSharedBlobs(share.ownerEd)
      if (ids === null) {
        if (!share.stale) await putShare({ ...share, stale: true })
        continue
      }
      if (share.stale) await putShare({ ...share, stale: false })

      const known = new Set(
        (
          await getAllFromIndex<SharedEventRow>(
            'shared_events',
            'by-owner',
            IDBKeyRange.only(share.ownerEd),
          )
        ).map((r) => r.id),
      )

      for (const blobId of ids) {
        // Captured paper records: mirror the owner's `att-` blobs into the same
        // content-addressed `attachments` store the owner's own device uses, so
        // the read-only spine's viewer loads them the same way (see Spine.svelte).
        // A household share carries the owner's vault key, so these open under
        // the same key their events do. Content-addressed, so once-and-done.
        if (blobId.startsWith('att-')) {
          const sha256 = blobId.slice('att-'.length)
          if ((await get('attachments', sha256)) !== undefined) continue
          const sealed = await sharingClient.getSharedBlob(share.ownerEd, blobId)
          if (!sealed) continue
          const { mime, bytes: b64 } = JSON.parse(
            new TextDecoder().decode(key.open(sealed, aad(blobId))),
          ) as { mime: string; bytes: string }
          const bytes = base64ToBytes(b64)
          if ((await sha256Hex(bytes)) !== sha256) {
            throw new Error(`shared blob ${blobId}: content hash does not match the blob id`)
          }
          await put('attachments', { sha256, mime, size: bytes.length, bytes, capturedAt: new Date().toISOString() })
          continue
        }
        if (!blobId.startsWith('ev-')) continue
        const eventId = blobId.slice('ev-'.length)
        if (known.has(eventId)) continue

        const sealed = await sharingClient.getSharedBlob(share.ownerEd, blobId)
        if (!sealed) continue
        const plaintext = key.open(sealed, aad(blobId))
        const json = new TextDecoder().decode(plaintext)
        if (!verify_event(json)) throw new Error(`shared blob ${blobId}: signature does not verify`)
        const signed = JSON.parse(json) as StoredEvent
        if (signed.event.id !== eventId) throw new Error(`shared blob ${blobId}: embedded id mismatch`)
        if (signed.author !== share.ownerEd) {
          throw new Error(`shared blob ${blobId}: author is not the vault owner`)
        }
        await put('shared_events', { ownerEd: share.ownerEd, id: eventId, event: signed })
      }
    } catch (err) {
      // Left for the next pull rather than aborting every other share.
      console.warn(`shared pull for ${share.ownerEd} failed:`, err)
    }
  }
}
