// The unlocked session: identity and vault key, memory-only (never persisted —
// persistence is exactly what the passphrase-wrapped keyvault guards against).
import type { WasmIdentity, WasmDataKey } from './svastha'

interface Session {
  identity: WasmIdentity | null
  vaultKey: WasmDataKey | null
  // The PBKDF2 output derived at unlock time, kept in memory alongside the
  // identity and vault key so the keyvault's vaultkey record can be re-sealed
  // later (adopting a relay-won vault key — see vault.ts's
  // `ensureVaultKeyBlob`) without asking for the passphrase again. Wiped on
  // lock, same as the rest of the session.
  kdfOut: Uint8Array | null
}

const session: Session = $state({ identity: null, vaultKey: null, kdfOut: null })

// Svelte disallows exporting a `$derived` binding directly from a module (only
// components may export reactive state); a function wrapper keeps callers
// reactive as long as they read it inside a template or another derived/effect.
export function locked(): boolean {
  return session.identity === null || session.vaultKey === null
}

export function setSession(identity: WasmIdentity, vaultKey: WasmDataKey, kdfOut: Uint8Array): void {
  session.identity = identity
  session.vaultKey = vaultKey
  session.kdfOut = kdfOut
}

export function clearSession(): void {
  session.identity = null
  session.vaultKey = null
  session.kdfOut = null
}

export { session }
