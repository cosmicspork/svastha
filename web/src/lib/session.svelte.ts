// The unlocked session: identity and vault key, memory-only (never persisted —
// persistence is exactly what the wrapped keyvault guards against).
import type { WasmIdentity, WasmDataKey } from './svastha'

interface Session {
  identity: WasmIdentity | null
  vaultKey: WasmDataKey | null
  // The key the canonical vaultkey record is sealed under — the passphrase's
  // PBKDF2 output in a v1 vault, the master key (MK) in v2. Kept in memory
  // alongside the identity and vault key so the vaultkey record can be re-sealed
  // later (adopting a relay-won vault key — see vault.ts's `ensureVaultKeyBlob`)
  // without asking for the passphrase again. Enrolling a passkey migrates v1->v2
  // and swaps this from kdfOut to MK (see keyvault.ts's `enrollPasskey`). Wiped
  // on lock, same as the rest of the session.
  wrapKey: Uint8Array | null
}

const session: Session = $state({ identity: null, vaultKey: null, wrapKey: null })

// Svelte disallows exporting a `$derived` binding directly from a module (only
// components may export reactive state); a function wrapper keeps callers
// reactive as long as they read it inside a template or another derived/effect.
export function locked(): boolean {
  return session.identity === null || session.vaultKey === null
}

export function setSession(identity: WasmIdentity, vaultKey: WasmDataKey, wrapKey: Uint8Array): void {
  session.identity = identity
  session.vaultKey = vaultKey
  session.wrapKey = wrapKey
}

export function clearSession(): void {
  session.identity = null
  session.vaultKey = null
  session.wrapKey = null
}

export { session }
