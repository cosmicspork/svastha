// The unlocked session: identity and vault key, memory-only (never persisted —
// persistence is exactly what the passphrase-wrapped keyvault guards against).
import type { WasmIdentity, WasmDataKey } from './svastha'

interface Session {
  identity: WasmIdentity | null
  vaultKey: WasmDataKey | null
}

const session: Session = $state({ identity: null, vaultKey: null })

// Svelte disallows exporting a `$derived` binding directly from a module (only
// components may export reactive state); a function wrapper keeps callers
// reactive as long as they read it inside a template or another derived/effect.
export function locked(): boolean {
  return session.identity === null || session.vaultKey === null
}

export function setSession(identity: WasmIdentity, vaultKey: WasmDataKey): void {
  session.identity = identity
  session.vaultKey = vaultKey
}

export function clearSession(): void {
  session.identity = null
  session.vaultKey = null
}

export { session }
