// Local key custody: the mnemonic and vault key live on disk only as
// passphrase-wrapped envelopes, never in the clear. See docs/ARCHITECTURE.md
// ("Seed custody") for the at-rest shape this implements.
//
// The KDF itself lives in ./kdf.ts (no wasm dependency) so it stays unit
// testable without booting the wasm module — see __tests__/kdf.test.ts.
import { get, put, deleteDb } from './db'
import { initSvastha, WasmIdentity, WasmDataKey } from './svastha'
import { toHex, fromHex } from './hex'
import { deriveKdfBytes, DEFAULT_ITERATIONS, SALT_LEN } from './kdf'

export { deriveKdfBytes, DEFAULT_ITERATIONS }

const AAD = {
  mnemonic: new TextEncoder().encode('svastha/keyvault/mnemonic'),
  vaultkey: new TextEncoder().encode('svastha/keyvault/vaultkey'),
  check: new TextEncoder().encode('svastha/keyvault/check'),
}
const CHECK_PLAINTEXT = new TextEncoder().encode('svastha-check')

/** One sealed keyvault record. All three records (mnemonic, vaultkey, check)
 * share this shape and, per unlock, the same `salt`/`iterations`/KDF output —
 * only the AAD and sealed payload differ. */
interface KeyvaultRecord {
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt_hex: string
  sealed_hex: string
}

/** Thrown when a passphrase fails to open the check sentinel. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase doesn't match. Your seed phrase can always restore access.")
    this.name = 'WrongPassphraseError'
  }
}

async function sealRecord(
  kdfOut: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<KeyvaultRecord> {
  const key = WasmDataKey.from_bytes(kdfOut)
  const sealed = key.seal(plaintext, aad)
  return {
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt_hex: toHex(salt),
    sealed_hex: toHex(sealed),
  }
}

function openRecord(record: KeyvaultRecord, kdfOut: Uint8Array, aad: Uint8Array): Uint8Array {
  const key = WasmDataKey.from_bytes(kdfOut)
  return key.open(fromHex(record.sealed_hex), aad)
}

export async function hasVault(): Promise<boolean> {
  return (await get('keyvault', 'check')) !== undefined
}

/** Seal a freshly generated (or restored) mnemonic and vault key under a new
 * passphrase, replacing any existing vault records. */
export async function initVault(mnemonic: string, passphrase: string): Promise<void> {
  await initSvastha()
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const kdfOut = await deriveKdfBytes(passphrase, salt, DEFAULT_ITERATIONS)

  const vaultKey = WasmDataKey.generate()
  const mnemonicBytes = new TextEncoder().encode(mnemonic)

  const [mnemonicRecord, vaultkeyRecord, checkRecord] = await Promise.all([
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.mnemonic, mnemonicBytes),
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.vaultkey, vaultKey.to_bytes()),
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.check, CHECK_PLAINTEXT),
  ])

  await Promise.all([
    put('keyvault', mnemonicRecord, 'mnemonic'),
    put('keyvault', vaultkeyRecord, 'vaultkey'),
    put('keyvault', checkRecord, 'check'),
  ])
}

export interface UnlockedSession {
  identity: WasmIdentity
  vaultKey: WasmDataKey
  // See session.svelte.ts's `kdfOut` doc comment for why this is returned
  // (and kept in memory) rather than discarded once the vault key is open.
  kdfOut: Uint8Array
}

/** Derive the passphrase key once, verify it against the check sentinel, then
 * open the mnemonic and vault key. Throws {@link WrongPassphraseError} on a
 * passphrase mismatch. */
export async function unlock(passphrase: string): Promise<UnlockedSession> {
  await initSvastha()
  const [mnemonicRecord, vaultkeyRecord, checkRecord] = await Promise.all([
    get<KeyvaultRecord>('keyvault', 'mnemonic'),
    get<KeyvaultRecord>('keyvault', 'vaultkey'),
    get<KeyvaultRecord>('keyvault', 'check'),
  ])
  if (!mnemonicRecord || !vaultkeyRecord || !checkRecord) {
    throw new Error('No vault found on this device — set one up first.')
  }

  const salt = fromHex(checkRecord.salt_hex)
  const kdfOut = await deriveKdfBytes(passphrase, salt, checkRecord.iterations)

  try {
    openRecord(checkRecord, kdfOut, AAD.check)
  } catch {
    throw new WrongPassphraseError()
  }

  const mnemonicBytes = openRecord(mnemonicRecord, kdfOut, AAD.mnemonic)
  const phrase = new TextDecoder().decode(mnemonicBytes)
  // The BIP39 passphrase is deliberately left empty here: the unlock
  // passphrase the user just typed is a *local* wrapping secret protecting
  // this device's keyvault, not part of the seed -> identity derivation. Using
  // it as the BIP39 passphrase would mean losing (or changing) it also changes
  // the identity, defeating "the mnemonic is the sole recovery root."
  const identity = WasmIdentity.from_mnemonic(phrase, '')

  const vaultKeyBytes = openRecord(vaultkeyRecord, kdfOut, AAD.vaultkey)
  const vaultKey = WasmDataKey.from_bytes(vaultKeyBytes)

  return { identity, vaultKey, kdfOut }
}

/** Re-seal the local vaultkey record under a *different* vault key, reusing
 * the salt/iterations already on disk and the caller's already-derived
 * `kdfOut` — no passphrase prompt needed. Used when this device adopts a
 * vault key it lost a first-writer-wins race for (see vault.ts's
 * `ensureVaultKeyBlob`): the local copy must end up sealed under the winning
 * key so the next unlock (offline or not) recovers the right one. */
export async function resealVaultKey(kdfOut: Uint8Array, vaultKey: WasmDataKey): Promise<void> {
  const existing = await get<KeyvaultRecord>('keyvault', 'vaultkey')
  if (!existing) throw new Error('No vault found on this device.')
  const record = await sealRecord(
    kdfOut,
    fromHex(existing.salt_hex),
    existing.iterations,
    AAD.vaultkey,
    vaultKey.to_bytes(),
  )
  await put('keyvault', record, 'vaultkey')
}

/** Re-seal all three records under a new passphrase, without touching the
 * underlying mnemonic or vault key. */
export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  await initSvastha()
  const { identity, vaultKey } = await unlock(oldPassphrase)
  const mnemonic = identity.mnemonic
  if (!mnemonic) throw new Error('Current identity has no recoverable mnemonic.')

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const kdfOut = await deriveKdfBytes(newPassphrase, salt, DEFAULT_ITERATIONS)
  const mnemonicBytes = new TextEncoder().encode(mnemonic)

  const [mnemonicRecord, vaultkeyRecord, checkRecord] = await Promise.all([
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.mnemonic, mnemonicBytes),
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.vaultkey, vaultKey.to_bytes()),
    sealRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.check, CHECK_PLAINTEXT),
  ])

  await Promise.all([
    put('keyvault', mnemonicRecord, 'mnemonic'),
    put('keyvault', vaultkeyRecord, 'vaultkey'),
    put('keyvault', checkRecord, 'check'),
  ])
}

/** Delete the entire local database — used before a restore-from-seed wipes
 * this device's vault. Irreversible; the caller must confirm with the user. */
export async function wipe(): Promise<void> {
  await deleteDb()
}
