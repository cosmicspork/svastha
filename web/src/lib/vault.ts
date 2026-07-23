// The vault.key lifecycle: the vault key lives at the relay under `vault.key`,
// wrapped to the owner's own X25519 public key (ECIES). Since key epochs, it is a
// **keyring** — every epoch key wrapped to the owner, serialized into one blob (a
// legacy single wrapped key still reads as a one-epoch genesis ring). A wrapped
// keyring is already AEAD-protected end to end, so it is stored as-is — no extra
// sealing on top. See docs/ARCHITECTURE.md, "Sync and backup" and "Vaults and
// grants", and spec/README.md, "Key epochs".
import type { RelayClient } from './relay'
import { session } from './session.svelte'
import { resealVaultKey } from './keyvault'
import { fromHex } from './hex'
import { WasmKeyring, verify_message } from './svastha'
import { KeyringBlobKey, isKeyringContainer } from './keyring'
import { syncInit } from './sync'
import { configureSharing, handleIncomingKeyHandoff } from './shared'
import { configureMailbox } from './mailbox'

const VAULT_KEY_BLOB_ID = 'vault.key'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Reconcile this device's vault keyring against whatever it has published at the
 * relay under `vault.key`, and set `session.keyring` to the result:
 *
 * - **Absent.** This identity has never published one — publish the genesis
 *   wrapped key (byte-identical to the pre-epoch contract) and adopt it as a
 *   one-epoch genesis ring.
 * - **Present, a keyring container.** A rotation has happened somewhere. Merge the
 *   remote ring with this device's genesis (union of epochs — every epoch key is
 *   kept), republish if the merge added anything the relay lacked, and adopt the
 *   merged ring. This is how the owner's other devices pick up a rotation, and how
 *   two independently-rotated replicas converge (spec's "Merge").
 * - **Present, a legacy bare key.** No rotation yet. First-writer-wins on the
 *   genesis epoch: if the remote key differs from local, adopt it and re-seal the
 *   local keyvault record under it (unchanged from the pre-keyring behavior), then
 *   read it as a genesis ring. It becomes a container the first time this vault
 *   rotates.
 *
 * First-writer-wins is consequence-free because `connectRelay` always runs this
 * before the sync engine starts, so no event is ever sealed under a key this
 * device is about to discard.
 */
export async function reconcileVaultKeyring(relay: RelayClient): Promise<void> {
  const { identity, vaultKey, wrapKey } = session
  if (!identity || !vaultKey || !wrapKey) throw new Error('Session is locked.')

  const ownX25519 = fromHex(identity.x25519_public_hex)
  const remote = await relay.getBlob(VAULT_KEY_BLOB_ID)

  if (!remote) {
    // Publish the bare genesis wrapping (same bytes the pre-keyring client wrote,
    // so an existing vault never sees its vault.key shape change until it rotates)
    // and read it back as the genesis ring.
    const wrapped = vaultKey.wrap_to(ownX25519)
    await relay.putBlob(VAULT_KEY_BLOB_ID, wrapped)
    session.keyring = WasmKeyring.from_bytes(wrapped)
    return
  }

  if (isKeyringContainer(remote)) {
    const remoteRing = WasmKeyring.from_bytes(remote)
    const localGenesis = WasmKeyring.genesis(vaultKey, ownX25519)
    const merged = localGenesis.merge(remoteRing)
    const mergedBytes = merged.to_bytes()
    if (!bytesEqual(mergedBytes, remote)) {
      await relay.putBlob(VAULT_KEY_BLOB_ID, mergedBytes)
    }
    session.keyring = merged
    return
  }

  // Legacy bare key: preserve the first-writer-wins adopt-and-reseal, then read
  // the (possibly adopted) bytes as a genesis ring.
  const remoteKey = identity.unwrap_key(remote)
  if (!bytesEqual(remoteKey.to_bytes(), vaultKey.to_bytes())) {
    session.vaultKey = remoteKey
    await resealVaultKey(wrapKey, remoteKey)
  }
  session.keyring = WasmKeyring.from_bytes(remote)
}

/**
 * The one entry point UI code should use to bring a relay connection up:
 * reconcile the keyring first, then start the sync engine sealing/opening blobs
 * through it. Enforces the ordering `reconcileVaultKeyring` documents — never call
 * `syncInit` directly from a route component.
 */
export async function connectRelay(relay: RelayClient): Promise<void> {
  await reconcileVaultKeyring(relay)
  const { identity, keyring } = session
  if (!identity || !keyring) throw new Error('Session is locked.')

  // The sync engine, share reader, and export importer all seal blobs through a
  // `{ seal, open }` key; the keyring adapter makes that epoch-aware without any
  // of them changing interface. `relay` and `identity` satisfy the mailbox/share
  // layers' narrower interfaces structurally.
  syncInit(relay, new KeyringBlobKey(keyring, identity))
  configureSharing(relay, identity)
  // The mailbox layer routes an incoming `key_handoff` through this handler so a
  // re-keying (post-rotation) handoff merges into an existing share rather than
  // surfacing a duplicate invite (see shared.ts).
  configureMailbox(relay, identity, verify_message, handleIncomingKeyHandoff)
}
