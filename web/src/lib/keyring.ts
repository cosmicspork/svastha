// The vault keyring: this device's live view of the epoch keys behind its vault
// (see spec/README.md, "Key epochs" and docs/ARCHITECTURE.md, "Vaults and
// grants"). Rotation mints a new epoch; new blobs seal under the newest one
// while every earlier epoch stays in the ring so existing blobs keep opening.
//
// This module owns three things:
//   1. `KeyringBlobKey` — adapts a `WasmKeyring` to the `{ seal, open }` shape
//      the sync engine, share reader, and export importer already seal blobs
//      through, so none of them change their interface to become epoch-aware.
//   2. Rotation orchestration (`revokeAndRotate`) with its relay/wasm boundaries
//      injected, so the ordering (revoke → rotate → publish → re-key) is
//      unit-testable without a real relay or real crypto.
//   3. Small wasm helpers for the incoming-handoff path (merge a re-keyed ring
//      into an existing one; check a wrapped ring unwraps to us).
import { WasmKeyring } from './svastha'
import type { WasmIdentity } from './svastha'
import { fromHex, toHex } from './hex'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A keyring container begins with the ASCII magic `svkr`; a legacy single-key
 * `vault.key` is a bare `WrappedKey` with no such prefix (which `from_bytes`
 * reads as a one-epoch genesis ring). Used so the vault-key reconcile can tell a
 * container it must merge from a legacy key it can adopt in place. */
export function isKeyringContainer(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x73 && // s
    bytes[1] === 0x76 && // v
    bytes[2] === 0x6b && // k
    bytes[3] === 0x72 // r
  )
}

/**
 * Adapts a `WasmKeyring` to the `{ seal, open }` shape sync.ts / shared.ts /
 * export.ts seal blobs through. Those callers pass `aad = utf8(blob_id)`, but the
 * keyring wants the blob id itself (it derives the epoch-bound AAD internally), so
 * this decodes the aad back to the id. Sealing always uses the newest epoch
 * (rotation-aware); opening trial-decrypts every epoch, so a pre-rotation blob
 * (genesis, bare-AAD) and a rotated blob (marked-AAD) both open. A blob id is
 * ASCII (`[A-Za-z0-9._-]`), so the utf8 round-trip is exact.
 */
export class KeyringBlobKey {
  constructor(
    private readonly keyring: WasmKeyring,
    private readonly identity: WasmIdentity,
  ) {}

  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
    return this.keyring.seal_blob(this.identity, dec.decode(aad), plaintext)
  }

  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array {
    return this.keyring.open_blob(this.identity, dec.decode(aad), sealed)
  }

  /** The canonical container bytes of the wrapped keyring — used by the export
   * importer to detect a backup sealed under a different (older) ring. */
  containerBytes(): Uint8Array {
    return this.keyring.to_bytes()
  }
}

// --- incoming handoff helpers (thin wasm wrappers; exercised by the e2e) ---

/** Merge an incoming wrapped keyring (from a re-keying `key_handoff`, or a legacy
 * bare wrapped key) into an existing one by union of epochs — every epoch key is
 * kept, none lost. Both sides are wrapped to the same recipient, so the merged
 * ring opens every epoch either side could. Returns the merged container hex.
 * This is the "a key_handoff arriving at a device that already holds a keyring
 * merges rather than replaces" rule (spec/README.md, "Merge"). */
export function mergeWrappedKeyrings(existingHex: string, incomingHex: string): string {
  const existing = WasmKeyring.from_bytes(fromHex(existingHex))
  const incoming = WasmKeyring.from_bytes(fromHex(incomingHex))
  return toHex(existing.merge(incoming).to_bytes())
}

/** Whether a wrapped keyring (or legacy bare wrapped key) was wrapped to this
 * identity — proof it is for us before we store or act on it. Unwrapping the
 * newest epoch is the cheapest witness. */
export function keyringUnwrapsTo(wrappedHex: string, identity: WasmIdentity): boolean {
  try {
    WasmKeyring.from_bytes(fromHex(wrappedHex)).newest_key(identity)
    return true
  } catch {
    return false
  }
}

// --- key_handoff envelope construction ---

/** The `key_handoff` body (spec's `KeyHandoffBody`): the sender's identity and a
 * wrapped keyring (or, grandfathered, a bare wrapped key). */
export interface KeyHandoffBody {
  from_ed: string
  from_x25519: string
  label: string
  wrapped_hex: string
}

/** The identity capabilities key distribution needs, narrowed so tests can pass a
 * fake without wasm. `WasmIdentity` satisfies it structurally. */
export interface SealingIdentity {
  readonly ed25519_public_hex: string
  readonly x25519_public_hex: string
  seal_message(recipientX25519: Uint8Array, kind: string, sentAt: number, body: Uint8Array): string
}

/** A wrapped keyring able to serialize itself — `WasmKeyring` and its `rotate`
 * result satisfy this. */
export interface WrappableKeyring {
  wrap_for_grantee(owner: SealingIdentity, granteeX25519: Uint8Array): { to_bytes(): Uint8Array }
  rotate(ownerX25519: Uint8Array, createdAt: number): WrappableKeyring
  to_bytes(): Uint8Array
}

/** Seal a `key_handoff` envelope carrying `keyring` re-wrapped to a grantee, ready
 * to deposit into their mailbox. Pure over its inputs; the wasm calls (wrap, seal)
 * ride the injected keyring/identity, so a test can drive the surrounding
 * orchestration with fakes. */
export function sealKeyHandoff(
  identity: SealingIdentity,
  keyring: WrappableKeyring,
  granteeX25519Hex: string,
  label: string,
  now: number,
): Uint8Array {
  const wrapped = keyring.wrap_for_grantee(identity, fromHex(granteeX25519Hex))
  const body: KeyHandoffBody = {
    from_ed: identity.ed25519_public_hex,
    from_x25519: identity.x25519_public_hex,
    label,
    wrapped_hex: toHex(wrapped.to_bytes()),
  }
  const envelope = identity.seal_message(
    fromHex(granteeX25519Hex),
    'key_handoff',
    now,
    enc.encode(JSON.stringify(body)),
  )
  return enc.encode(envelope)
}

/** The mailbox item id a `key_handoff` from this owner is deposited under —
 * derived from the owner's identity so a re-rotation overwrites the grantee's
 * pending item rather than piling up a second one (the grantee merges either
 * way). */
export function keyHandoffItemId(ownerEdHex: string): string {
  return `keyring-${ownerEdHex.slice(0, 16)}`
}

// --- rotation orchestration (relay/wasm boundaries injected → unit-testable) ---

/** A still-trusted grantee to re-key on rotation. */
export interface Grantee {
  ed: string
  x25519: string
  label: string
}

/** The relay surface rotation drives — a narrow slice of `RelayClient`, so a test
 * supplies an in-memory fake (mirrors sync.ts's `BlobClient`). */
export interface RotationRelay {
  putBlob(id: string, blob: Uint8Array): Promise<void>
  deleteGrant(granteeHex: string): Promise<boolean>
  putMailbox(recipientHex: string, id: string, blob: Uint8Array): Promise<void>
}

export interface RotationDeps {
  relay: RotationRelay
  identity: SealingIdentity
  /** The session's current keyring. */
  keyring: WrappableKeyring
  /** Grantees still trusted after the revoke — each re-keyed with the new ring. */
  grantees: Grantee[]
  /** The grantee to revoke first (delete their grant edge), or null for a plain
   * "rotate now" with no revoke. */
  revoke: string | null
  /** Clock for the new epoch and the handoff `sent_at` (Unix ms). */
  now?: number
}

/**
 * Revoke-and-rotate as one action (design §3 — a revoke without rotation is
 * dishonest). The ordering is load-bearing:
 *
 *   1. Delete the revoked grant edge, so the revoked identity can no longer even
 *      fetch ciphertext.
 *   2. Mint the next epoch. New blobs seal under it; every earlier epoch stays in
 *      the ring, so existing blobs keep opening and nothing is re-encrypted.
 *   3. Publish the extended keyring as `vault.key`. The owner's *other* devices
 *      adopt it through the standard vault-key reconcile on their next connect
 *      (docs/ARCHITECTURE.md, "Vault-key reconciliation") — that is the app's
 *      key-distribution model for same-identity devices.
 *   4. Re-key every still-trusted grantee: the keyring re-wrapped to them, in a
 *      signed `key_handoff`. The revoked identity is simply never handed it.
 *
 * Returns the new keyring so the caller can adopt it into the live session (future
 * seals then use the new epoch). It cannot retract what the revoked party already
 * decrypted or the old-epoch material it holds — the honest-revocation caveat the
 * confirmation UI states — but everything sealed after this is beyond it.
 */
export async function revokeAndRotate(deps: RotationDeps): Promise<WrappableKeyring> {
  const now = deps.now ?? Date.now()

  if (deps.revoke) await deps.relay.deleteGrant(deps.revoke)

  const rotated = deps.keyring.rotate(fromHex(deps.identity.x25519_public_hex), now)
  await deps.relay.putBlob('vault.key', rotated.to_bytes())

  for (const g of deps.grantees) {
    const envelope = sealKeyHandoff(deps.identity, rotated, g.x25519, g.label, now)
    await deps.relay.putMailbox(g.ed, keyHandoffItemId(deps.identity.ed25519_public_hex), envelope)
  }

  return rotated
}
