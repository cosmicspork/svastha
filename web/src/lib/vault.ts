// The vault.key lifecycle: the vault data key lives at the relay under
// `vault.key`, wrapped to the owner's own X25519 public key (ECIES). A
// wrapped key is already AEAD-protected end to end, so it is stored as-is —
// no extra vault-key sealing on top. See docs/ARCHITECTURE.md, "Sync and
// backup".
import type { RelayClient } from './relay'
import { session } from './session.svelte'
import { resealVaultKey } from './keyvault'
import { fromHex } from './hex'
import { syncInit } from './sync'
import { configureSharing } from './shared'

const VAULT_KEY_BLOB_ID = 'vault.key'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Reconcile the local vault key against whatever this identity already has
 * published at the relay:
 *
 * - **Present, and it matches.** Nothing to do.
 * - **Present, and it differs.** This device lost a first-writer-wins race
 *   (see below) — adopt the remote key into the session and re-seal the
 *   local keyvault record under it, so future unlocks (and pushes) use the
 *   winning key.
 * - **Absent.** This identity has never published one — wrap the local key
 *   to its own X25519 public key and publish it.
 *
 * First-writer-wins: if two fresh devices race to publish `vault.key` for the
 * same identity, whichever `PUT` lands last on the relay wins (blobs are
 * replace-on-put, there is no compare-and-swap), and the loser adopts the
 * winner's key on its next call here. This is acceptable for v1 because the
 * race window is narrow and consequence-free in practice: pushing an event
 * requires a *configured* relay, and configuring one always calls this
 * function first (see `connectRelay`, below) — so no event can already be
 * sealed under the key a device is about to discard.
 */
export async function ensureVaultKeyBlob(relay: RelayClient): Promise<void> {
  const { identity, vaultKey, kdfOut } = session
  if (!identity || !vaultKey || !kdfOut) throw new Error('Session is locked.')

  const remote = await relay.getBlob(VAULT_KEY_BLOB_ID)
  if (remote) {
    const remoteKey = identity.unwrap_key(remote)
    if (!bytesEqual(remoteKey.to_bytes(), vaultKey.to_bytes())) {
      session.vaultKey = remoteKey
      await resealVaultKey(kdfOut, remoteKey)
    }
    return
  }

  const ownX25519 = fromHex(identity.x25519_public_hex)
  const wrapped = vaultKey.wrap_to(ownX25519)
  await relay.putBlob(VAULT_KEY_BLOB_ID, wrapped)
}

/**
 * The one entry point UI code should use to bring a relay connection up:
 * reconcile `vault.key` first, then start the sync engine. Enforces the
 * ordering `ensureVaultKeyBlob` documents above — never call `syncInit`
 * directly from a route component.
 */
export async function connectRelay(relay: RelayClient): Promise<void> {
  await ensureVaultKeyBlob(relay)
  if (!session.vaultKey) throw new Error('Session is locked.')
  syncInit(relay, session.vaultKey)
  // `relay` (a `RelayClient`) and `session.identity` (a `WasmIdentity`) satisfy
  // sharing's narrower `SharingClient`/`UnwrapIdentity` interfaces structurally
  // — see shared.ts's doc comment on why it takes these in rather than reading
  // the session itself.
  if (session.identity) configureSharing(relay, session.identity)
}
