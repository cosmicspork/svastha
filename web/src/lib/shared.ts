// Spousal / caregiver / node sharing: accepted shares, the read-only event cache
// pulled from each, and the mailbox invite flow that creates them. Kept separate
// from sync.ts (which owns *this* device's own event log) because a share is a
// different trust boundary — read-only, someone else's vault keyring, someone
// else's signing identity — even though the wire mechanics (list, diff, fetch,
// open) are the same shape. See docs/ARCHITECTURE.md, "Vaults and grants".
//
// Like sync.ts, this module avoids importing session.svelte.ts's rune-based
// runtime directly: the relay/mailbox client and the identity are passed in
// explicitly via `configureSharing`, wired from vault.ts (which already holds the
// session) rather than read from it here.
import { get, put, del, getAll, getAllFromIndex } from './db'
import { verify_event, WasmKeyring } from './svastha'
import type { WasmIdentity } from './svastha'
import { KeyringBlobKey, mergeWrappedKeyrings, keyringUnwrapsTo } from './keyring'
import { fromHex } from './hex'
import { base64ToBytes } from './base64'
import { writable } from 'svelte/store'
import type { StoredEvent } from './events'
import { BATCH_PULL_THRESHOLD, type BlobBodyPage } from './blob-batch'

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

/** The optional batched-listing surface (`?include=body`), mirroring sync.ts's
 * own `BatchListClient`. Kept out of `SharingClient` on purpose: widening that
 * interface would force every in-memory test fake to grow a method it has no
 * use for, so this is probed for instead and the per-blob path stands in when
 * it is absent. */
interface BatchSharedListClient {
  listSharedBlobsWithBodies(
    ownerHex: string,
    cursor: string | null,
    limit?: number,
  ): Promise<BlobBodyPage | null>
}

function supportsBatchSharedList(
  client: SharingClient,
): client is SharingClient & BatchSharedListClient {
  return typeof (client as Partial<BatchSharedListClient>).listSharedBlobsWithBodies === 'function'
}

/** Opens ciphertext sealed under a vault keyring — `KeyringBlobKey` satisfies this
 * (read-only here, since a share is). */
export interface OpenKey {
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array
}

/** One accepted share: someone else's vault, read-only. */
export interface Share {
  ownerEd: string
  ownerX: string
  label: string
  /** The owner's vault **keyring** re-wrapped to us (a legacy bare wrapped key
   * still reads as a genesis ring). A re-keying `key_handoff` after the owner
   * rotates is merged into this by union (see `handleIncomingKeyHandoff`), so it
   * always opens every epoch the owner has handed us. */
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
  openKeys.delete(ownerEd)
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
let identity: WasmIdentity | null = null

/** Cached per-owner keyring open-keys, one keyring parse per share per session
 * rather than per pull. Invalidated when a re-keying handoff merges a new epoch
 * in (see `handleIncomingKeyHandoff`) and cleared on `teardownSharing`. */
const openKeys = new Map<string, OpenKey>()

export function configureSharing(client: SharingClient, id: WasmIdentity): void {
  sharingClient = client
  identity = id
}

export function teardownSharing(): void {
  sharingClient = null
  identity = null
  openKeys.clear()
  pendingInvites.set([])
}

/** Build (and cache) the keyring open-key for a share: the owner's keyring
 * re-wrapped to us, opened with our own identity. */
function openKeyFor(share: Share): OpenKey {
  let key = openKeys.get(share.ownerEd)
  if (!key) {
    key = new KeyringBlobKey(WasmKeyring.from_bytes(fromHex(share.wrappedKeyHex)), identity!)
    openKeys.set(share.ownerEd, key)
  }
  return key
}

// --- mailbox invites ---

/** A `key_handoff` (or grandfathered bare-key) mailbox item, verified but not yet
 * accepted or declined. Lives only in memory — nothing is written locally until
 * the user decides. */
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
// grandfathered bare wrapped-key deposit through `handleIncomingKeyHandoff`
// below, and sets `pendingInvites` wholesale. This module keeps the invite
// *state*, the accept/decline actions, and the merge-or-invite decision, since a
// household share has its own trust boundary and lifecycle (`putShare`,
// `pullShared`) distinct from the envelope plumbing.

/** The outcome the mailbox layer acts on for one incoming key handoff. */
export type KeyHandoffOutcome = 'invite' | 'merged' | 'drop'

export interface KeyHandoffInfo {
  fromEd: string
  fromX: string
  label: string
  wrappedHex: string
  itemId: string
}

/**
 * Decide what to do with an incoming, already-verified `key_handoff` (or a
 * grandfathered bare-key deposit):
 *
 * - **From our own identity** → `drop`. Same-identity key material propagates to
 *   the owner's other devices through the `vault.key` reconcile (vault.ts), not
 *   as a share invite; surfacing it would read as "you shared with yourself".
 * - **Does not unwrap to us** → `drop` (sealed to someone else, or corrupt).
 * - **A share from this owner already exists** → `merged`: this is a re-keying
 *   after the owner rotated. Merge the new wrapped keyring into the existing one
 *   by union of epochs (every epoch key kept), update the share silently, and
 *   invalidate the cached open-key. No duplicate invite.
 * - **Otherwise** → `invite`: a fresh share the user must accept/decline.
 */
export async function handleIncomingKeyHandoff(info: KeyHandoffInfo): Promise<KeyHandoffOutcome> {
  if (!identity) return 'drop'
  if (info.fromEd === identity.ed25519_public_hex) return 'drop'
  if (!keyringUnwrapsTo(info.wrappedHex, identity)) return 'drop'

  const existing = await getShare(info.fromEd)
  if (existing) {
    const merged = mergeWrappedKeyrings(existing.wrappedKeyHex, info.wrappedHex)
    await putShare({ ...existing, wrappedKeyHex: merged, stale: false })
    openKeys.delete(info.fromEd)
    return 'merged'
  }
  return 'invite'
}

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

/** AAD binding, identical in shape to sync.ts's own: the blob id itself. The
 * keyring open-key adds the epoch marker internally when a blob was sealed under a
 * rotated epoch, so a pre- and post-rotation blob both open. */
function aad(blobId: string): Uint8Array {
  return new TextEncoder().encode(blobId)
}

/**
 * Verify and store one sealed blob from a share — the single open/verify/store
 * path behind both the per-blob fetch loop and the batched walk below. Throws
 * on any integrity failure (content-hash mismatch, bad signature, embedded-id
 * mismatch, an author who is not the vault owner), which aborts the current
 * share's pull exactly as these checks did inline. A prefix outside
 * `att-`/`ev-` is a no-op.
 *
 * The cheap "already have it" checks stay at the call sites, where they can
 * skip the fetch (or drop the frame) before any of this work starts.
 */
async function applySharedSealed(
  share: Share,
  known: Set<string>,
  blobId: string,
  sealed: Uint8Array,
): Promise<void> {
  // Captured paper records: mirror the owner's `att-` blobs into the same
  // content-addressed `attachments` store the owner's own device uses, so the
  // read-only spine's viewer loads them the same way (see Spine.svelte). A
  // household share carries the owner's keyring, so these open under the same
  // epoch their events do. Content-addressed, so once-and-done.
  if (blobId.startsWith('att-')) {
    const sha256 = blobId.slice('att-'.length)
    const { mime, bytes: b64 } = JSON.parse(
      new TextDecoder().decode(openKeyFor(share).open(sealed, aad(blobId))),
    ) as { mime: string; bytes: string }
    const bytes = base64ToBytes(b64)
    if ((await sha256Hex(bytes)) !== sha256) {
      throw new Error(`shared blob ${blobId}: content hash does not match the blob id`)
    }
    await put('attachments', { sha256, mime, size: bytes.length, bytes, capturedAt: new Date().toISOString() })
    return
  }
  if (!blobId.startsWith('ev-')) return

  const eventId = blobId.slice('ev-'.length)
  const plaintext = openKeyFor(share).open(sealed, aad(blobId))
  const json = new TextDecoder().decode(plaintext)
  if (!verify_event(json)) throw new Error(`shared blob ${blobId}: signature does not verify`)
  const signed = JSON.parse(json) as StoredEvent
  if (signed.event.id !== eventId) throw new Error(`shared blob ${blobId}: embedded id mismatch`)
  if (signed.author !== share.ownerEd) {
    throw new Error(`shared blob ${blobId}: author is not the vault owner`)
  }
  await put('shared_events', { ownerEd: share.ownerEd, id: eventId, event: signed })
  // Keep the caller's diff set true for the rest of this pull, so an id seen
  // twice (a relay listing a duplicate, or a re-walked page) isn't reopened.
  known.add(eventId)
}

/**
 * Batched walk of one share's blobs (`?include=body`), applying each frame as
 * it streams. Returns `false` when the relay doesn't support batching, so the
 * caller falls back to its per-blob loop; `true` when this share is finished
 * for this pull — either the walk completed, or the grant vanished mid-walk
 * and the share was marked stale, as a null listing does.
 *
 * Integrity errors propagate to `pullShared`'s per-share catch, aborting this
 * share and leaving the rest for the next pull — today's semantics for an
 * inline throw.
 */
async function batchPullShare(
  client: SharingClient & BatchSharedListClient,
  share: Share,
  known: Set<string>,
): Promise<boolean> {
  let cursor: string | null = null
  for (;;) {
    const page = await client.listSharedBlobsWithBodies(share.ownerEd, cursor)
    if (page === null) {
      // Revoked between the listing and now. Written unconditionally because
      // the caller may have just cleared `stale`, so this in-memory copy of the
      // share can't be trusted to report the stored value.
      await putShare({ ...share, stale: true })
      return true
    }
    if (page.kind === 'unsupported') return false

    for await (const { id, blob } of page.blobs) {
      // The same pre-checks the per-blob loop makes before fetching; here they
      // drop the frame instead, before it is ever opened.
      if (id.startsWith('ev-')) {
        if (known.has(id.slice('ev-'.length))) continue
      } else if (id.startsWith('att-')) {
        if ((await get('attachments', id.slice('att-'.length))) !== undefined) continue
      } else {
        continue
      }
      await applySharedSealed(share, known, id, blob)
    }

    // Same non-advancing-cursor guard as sync.ts's own walk: a buggy relay
    // must not spin this loop forever.
    if (page.next === null || page.next === cursor) return true
    cursor = page.next
  }
}

/**
 * Pull every accepted share's new events. Mirrors sync.ts's own-vault pull
 * (list, diff, fetch, open, verify) against the owner's keyring, plus an author
 * check: a shared vault is single-writer by contract, so an event whose signature
 * verifies but whose author isn't the vault owner must still be rejected — the
 * relay could otherwise splice in a foreign-signed event without breaking the
 * crypto.
 *
 * State tracking deliberately has no separate "sync" bookkeeping: the known set
 * for each owner is read straight from `shared_events`' `by-owner` index, which
 * already IS the diff state (an id present there has been pulled).
 */
export async function pullShared(): Promise<void> {
  if (!sharingClient || !identity) return

  for (const share of await listShares()) {
    try {
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

      // The blobs this pull is actually missing — how many there are is what
      // picks between the two paths below, and the `att-` lookups are the same
      // IDB reads the per-blob loop would have made on its way past them.
      const toFetch: string[] = []
      for (const blobId of ids) {
        if (blobId.startsWith('ev-')) {
          if (!known.has(blobId.slice('ev-'.length))) toFetch.push(blobId)
        } else if (blobId.startsWith('att-')) {
          if ((await get('attachments', blobId.slice('att-'.length))) === undefined) toFetch.push(blobId)
        }
      }
      if (toFetch.length >= BATCH_PULL_THRESHOLD && supportsBatchSharedList(sharingClient)) {
        if (await batchPullShare(sharingClient, share, known)) continue
      }

      for (const blobId of toFetch) {
        const sealed = await sharingClient.getSharedBlob(share.ownerEd, blobId)
        if (!sealed) continue
        await applySharedSealed(share, known, blobId, sealed)
      }
    } catch (err) {
      // Left for the next pull rather than aborting every other share.
      console.warn(`shared pull for ${share.ownerEd} failed:`, err)
    }
  }
}
