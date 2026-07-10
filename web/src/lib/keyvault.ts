// Local key custody: the mnemonic and vault key live on disk only as
// wrapped envelopes, never in the clear. See docs/ARCHITECTURE.md ("Seed
// custody") for the at-rest shape this implements.
//
// Two on-disk formats coexist:
//
// - **v1** (passphrase only): the mnemonic, vault key, and a check sentinel are
//   each sealed directly under the passphrase-derived key (`kdfOut`).
// - **v2** (passphrase + optional passkeys): a random per-device *master key*
//   (MK) seals one canonical copy of each record; every unlock method
//   (passphrase, each passkey) stores MK wrapped under its own secret. Adopting
//   a relay-won vault key reseals the single canonical copy, so no unlock method
//   ever drifts to a stale key. New vaults are born v1; a device migrates to v2
//   the first time it enrolls a passkey (see `enrollPasskey`).
//
// The KDF itself lives in ./kdf.ts (no wasm dependency) so it stays unit
// testable without booting the wasm module — see __tests__/kdf.test.ts.
import { get, put, del, getAll, deleteDb } from './db'
import { initSvastha, WasmIdentity, WasmDataKey } from './svastha'
import { toHex, fromHex } from './hex'
import { deriveKdfBytes, DEFAULT_ITERATIONS, SALT_LEN } from './kdf'

export { deriveKdfBytes, DEFAULT_ITERATIONS }

// --- store keys ---
const V1 = { mnemonic: 'mnemonic', vaultkey: 'vaultkey', check: 'check' } as const
// v2 canonicals are sealed under MK and live at *new* keys so migration never
// overwrites a v1 record (see `enrollPasskey`).
const V2 = { mnemonic: 'v2:mnemonic', vaultkey: 'v2:vaultkey', check: 'v2:check' } as const
const FORMAT_KEY = 'format' // set to 2 at the migration commit point
const MK_PASSPHRASE = 'mk:passphrase' // MK sealed under the passphrase key
const mkPasskeyKey = (credId: string) => `mk:passkey:${credId}` // MK sealed under a passkey secret

const enc = new TextEncoder()
const AAD = {
  // v1 (sealed under kdfOut)
  mnemonic: enc.encode('svastha/keyvault/mnemonic'),
  vaultkey: enc.encode('svastha/keyvault/vaultkey'),
  check: enc.encode('svastha/keyvault/check'),
  // v2 canonicals (sealed under MK) — distinct AADs from v1
  v2mnemonic: enc.encode('svastha/keyvault/v2/mnemonic'),
  v2vaultkey: enc.encode('svastha/keyvault/v2/vaultkey'),
  v2check: enc.encode('svastha/keyvault/v2/check'),
  // MK-wrap records
  mkPassphrase: enc.encode('svastha/keyvault/mk-passphrase'),
}
// The credential id is bound into the passkey record's AAD, tying the ciphertext
// to the metadata stored alongside it.
const aadMkPasskey = (credId: string) => enc.encode(`svastha/keyvault/mk-passkey:${credId}`)

const CHECK_PLAINTEXT = enc.encode('svastha-check')

/** A KDF-wrapped record: a payload sealed under a passphrase-derived key, with
 * the KDF parameters needed to re-derive it. Used for the v1 canonicals and for
 * the v2 `mk:passphrase` record. */
interface KdfRecord {
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt_hex: string
  sealed_hex: string
}

/** A payload sealed under an already-derived 32-byte key (MK). The v2
 * canonicals carry no KDF parameters — MK is recovered via an `mk:*` record. */
interface SealedRecord {
  sealed_hex: string
}

/** `mk:passkey:{credId}`: MK sealed under a passkey's PRF-derived secret, plus
 * the credential metadata needed to list, re-assert, and label it. */
export interface PasskeyRecord extends SealedRecord {
  credId: string
  rpId: string
  label: string
  created: number
}

/** Thrown when a passphrase fails to open the wrapping key. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase doesn't match. Your seed phrase can always restore access.")
    this.name = 'WrongPassphraseError'
  }
}

/** Thrown when a passkey secret fails to open its `mk:passkey` record (e.g. the
 * passkey is not the one enrolled, or the record is gone). */
export class PasskeyUnlockError extends Error {
  constructor() {
    super("That passkey didn't unlock this vault. Use your passphrase instead.")
    this.name = 'PasskeyUnlockError'
  }
}

// --- primitives ---

/** Seal under a raw 32-byte key, returning hex ciphertext. */
function sealBytes(key32: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): string {
  return toHex(WasmDataKey.from_bytes(key32).seal(plaintext, aad))
}

/** Open a hex ciphertext under a raw 32-byte key. Throws on the wrong key/AAD. */
function openBytes(key32: Uint8Array, aad: Uint8Array, sealedHex: string): Uint8Array {
  return WasmDataKey.from_bytes(key32).open(fromHex(sealedHex), aad)
}

function kdfRecord(
  kdfOut: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  aad: Uint8Array,
  plaintext: Uint8Array,
): KdfRecord {
  return {
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt_hex: toHex(salt),
    sealed_hex: sealBytes(kdfOut, aad, plaintext),
  }
}

function sealed(key32: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): SealedRecord {
  return { sealed_hex: sealBytes(key32, aad, plaintext) }
}

async function isV2(): Promise<boolean> {
  return (await get<number>('keyvault', FORMAT_KEY)) === 2
}

export async function hasVault(): Promise<boolean> {
  return (
    (await get('keyvault', V2.check)) !== undefined ||
    (await get('keyvault', V1.check)) !== undefined
  )
}

/** Seal a freshly generated (or restored) mnemonic and vault key under a new
 * passphrase, replacing any existing vault records. New vaults are born v1;
 * passkey enrollment is what migrates a device to v2. */
export async function initVault(mnemonic: string, passphrase: string): Promise<void> {
  await initSvastha()
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const kdfOut = await deriveKdfBytes(passphrase, salt, DEFAULT_ITERATIONS)

  const vaultKey = WasmDataKey.generate()
  const mnemonicBytes = enc.encode(mnemonic)

  await Promise.all([
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.mnemonic, mnemonicBytes), V1.mnemonic),
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.vaultkey, vaultKey.to_bytes()), V1.vaultkey),
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.check, CHECK_PLAINTEXT), V1.check),
  ])
}

export interface UnlockedSession {
  identity: WasmIdentity
  vaultKey: WasmDataKey
  // The key the *canonical* vaultkey record is sealed under: the passphrase's
  // `kdfOut` in v1, the master key (MK) in v2. Kept in memory (see
  // session.svelte.ts) so a relay-won vault key can be resealed without a
  // passphrase prompt. See `resealVaultKey`.
  wrapKey: Uint8Array
}

/** Publish the pre-unlock fingerprint. Public key material is already visible to
 * any relay this device talks to, so storing it unwrapped lets the lock screen
 * show a fingerprint before the vault opens. */
async function publishFingerprint(identity: WasmIdentity): Promise<void> {
  await put('prefs', identity.ed25519_public_hex, 'ed25519-pub')
}

/** Open the v2 canonicals under a recovered master key. */
async function openWithMk(mk: Uint8Array): Promise<UnlockedSession> {
  const [mnem, vk, chk] = await Promise.all([
    get<SealedRecord>('keyvault', V2.mnemonic),
    get<SealedRecord>('keyvault', V2.vaultkey),
    get<SealedRecord>('keyvault', V2.check),
  ])
  if (!mnem || !vk || !chk) throw new Error('No vault found on this device — set one up first.')

  // Integrity sentinel: MK must open the check record. A failure here is
  // corruption, not a wrong secret (the caller already verified the secret by
  // opening the mk:* record that produced this MK).
  openBytes(mk, AAD.v2check, chk.sealed_hex)

  const phrase = new TextDecoder().decode(openBytes(mk, AAD.v2mnemonic, mnem.sealed_hex))
  const identity = WasmIdentity.from_mnemonic(phrase, '')
  const vaultKey = WasmDataKey.from_bytes(openBytes(mk, AAD.v2vaultkey, vk.sealed_hex))

  await publishFingerprint(identity)
  // A crash after the migration commit can leave v1 records the v2 path ignores;
  // clear them opportunistically (they are the per-method-copy stale-key hazard
  // if any code ever read them again). Fire-and-forget — never blocks unlock.
  void cleanupLegacyV1()

  return { identity, vaultKey, wrapKey: mk }
}

async function unlockV1(passphrase: string): Promise<UnlockedSession> {
  const [mnemonicRecord, vaultkeyRecord, checkRecord] = await Promise.all([
    get<KdfRecord>('keyvault', V1.mnemonic),
    get<KdfRecord>('keyvault', V1.vaultkey),
    get<KdfRecord>('keyvault', V1.check),
  ])
  if (!mnemonicRecord || !vaultkeyRecord || !checkRecord) {
    throw new Error('No vault found on this device — set one up first.')
  }

  const salt = fromHex(checkRecord.salt_hex)
  const kdfOut = await deriveKdfBytes(passphrase, salt, checkRecord.iterations)

  try {
    openBytes(kdfOut, AAD.check, checkRecord.sealed_hex)
  } catch {
    throw new WrongPassphraseError()
  }

  const phrase = new TextDecoder().decode(openBytes(kdfOut, AAD.mnemonic, mnemonicRecord.sealed_hex))
  // The BIP39 passphrase is deliberately left empty here: the unlock passphrase
  // is a *local* wrapping secret protecting this device's keyvault, not part of
  // the seed -> identity derivation. Using it as the BIP39 passphrase would mean
  // losing (or changing) it also changes the identity, defeating "the mnemonic
  // is the sole recovery root."
  const identity = WasmIdentity.from_mnemonic(phrase, '')
  const vaultKey = WasmDataKey.from_bytes(openBytes(kdfOut, AAD.vaultkey, vaultkeyRecord.sealed_hex))

  await publishFingerprint(identity)
  return { identity, vaultKey, wrapKey: kdfOut }
}

async function unlockV2(passphrase: string): Promise<UnlockedSession> {
  const mkRec = await get<KdfRecord>('keyvault', MK_PASSPHRASE)
  if (!mkRec) throw new Error('No vault found on this device — set one up first.')

  const salt = fromHex(mkRec.salt_hex)
  const kdfOut = await deriveKdfBytes(passphrase, salt, mkRec.iterations)

  let mk: Uint8Array
  try {
    mk = openBytes(kdfOut, AAD.mkPassphrase, mkRec.sealed_hex)
  } catch {
    throw new WrongPassphraseError()
  }
  return openWithMk(mk)
}

/** Verify a passphrase, then open the mnemonic and vault key. Throws
 * {@link WrongPassphraseError} on a mismatch. */
export async function unlock(passphrase: string): Promise<UnlockedSession> {
  await initSvastha()
  return (await isV2()) ? unlockV2(passphrase) : unlockV1(passphrase)
}

/** Open the vault with a passkey's PRF-derived secret. Only ever available on a
 * v2 vault (a passkey cannot exist without one). */
export async function unlockWithPasskey(
  credId: string,
  passkeySecret: Uint8Array,
): Promise<UnlockedSession> {
  await initSvastha()
  const rec = await get<PasskeyRecord>('keyvault', mkPasskeyKey(credId))
  if (!rec) throw new PasskeyUnlockError()
  let mk: Uint8Array
  try {
    mk = openBytes(passkeySecret, aadMkPasskey(credId), rec.sealed_hex)
  } catch {
    throw new PasskeyUnlockError()
  }
  return openWithMk(mk)
}

/** Re-seal the canonical vaultkey record under a *different* vault key, using
 * the caller's already-in-hand wrap key — no passphrase prompt. Used when this
 * device adopts a vault key it lost a first-writer-wins race for (see vault.ts's
 * `ensureVaultKeyBlob`). Works for both formats: `wrapKey` is `kdfOut` in v1 and
 * MK in v2, and there is exactly one canonical copy either way. */
export async function resealVaultKey(wrapKey: Uint8Array, vaultKey: WasmDataKey): Promise<void> {
  const v2 = await get<SealedRecord>('keyvault', V2.vaultkey)
  if (v2) {
    await put('keyvault', sealed(wrapKey, AAD.v2vaultkey, vaultKey.to_bytes()), V2.vaultkey)
    return
  }
  const existing = await get<KdfRecord>('keyvault', V1.vaultkey)
  if (!existing) throw new Error('No vault found on this device.')
  await put(
    'keyvault',
    kdfRecord(wrapKey, fromHex(existing.salt_hex), existing.iterations, AAD.vaultkey, vaultKey.to_bytes()),
    V1.vaultkey,
  )
}

/** Re-seal under a new passphrase, without touching the mnemonic or vault key.
 * In v2 only the `mk:passphrase` record is rewritten (MK and the canonicals are
 * untouched); in v1 all three canonicals are resealed. */
export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  await initSvastha()

  if (await isV2()) {
    const { wrapKey: mk } = await unlockV2(oldPassphrase)
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
    const kdfOut = await deriveKdfBytes(newPassphrase, salt, DEFAULT_ITERATIONS)
    await put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.mkPassphrase, mk), MK_PASSPHRASE)
    return
  }

  const { identity, vaultKey } = await unlockV1(oldPassphrase)
  const mnemonic = identity.mnemonic
  if (!mnemonic) throw new Error('Current identity has no recoverable mnemonic.')

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const kdfOut = await deriveKdfBytes(newPassphrase, salt, DEFAULT_ITERATIONS)
  const mnemonicBytes = enc.encode(mnemonic)

  await Promise.all([
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.mnemonic, mnemonicBytes), V1.mnemonic),
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.vaultkey, vaultKey.to_bytes()), V1.vaultkey),
    put('keyvault', kdfRecord(kdfOut, salt, DEFAULT_ITERATIONS, AAD.check, CHECK_PLAINTEXT), V1.check),
  ])
}

/**
 * Enroll a passkey as an alternative unlock, migrating a v1 vault to v2 the
 * first time. Returns the master key so the caller can update the live session's
 * `wrapKey` (a v1 session was holding `kdfOut`, which resealVaultKey must no
 * longer use once the canonicals move under MK).
 *
 * The migration is strictly additive until a single commit point so a crash can
 * never brick the vault (which would then only be recoverable from the written
 * seed phrase):
 *
 *   1. write the MK-sealed canonicals at *new* keys + the two mk:* wraps
 *   2. flip the format marker to 2  ← commit
 *   3. delete the v1 records
 *
 * A crash before step 2 leaves v1 fully intact (the orphaned v2/mk records are
 * overwritten when enrollment reruns); a crash after leaves a working v2 vault
 * plus stale v1 records that `openWithMk` clears on the next unlock.
 */
export async function enrollPasskey(
  session: UnlockedSession,
  passkeySecret: Uint8Array,
  cred: { credId: string; rpId: string; label: string },
): Promise<Uint8Array> {
  await initSvastha()

  const record = (mk: Uint8Array): PasskeyRecord => ({
    sealed_hex: sealBytes(passkeySecret, aadMkPasskey(cred.credId), mk),
    credId: cred.credId,
    rpId: cred.rpId,
    label: cred.label,
    created: Date.now(),
  })

  if (await isV2()) {
    // Already migrated: the session's wrapKey is MK. Just add the wrap.
    const mk = session.wrapKey
    await put('keyvault', record(mk), mkPasskeyKey(cred.credId))
    return mk
  }

  // v1 -> v2 migration. The session's wrapKey is the passphrase's kdfOut; reuse
  // the stored v1 salt/iterations so mk:passphrase re-derives from the same
  // passphrase.
  const kdfOut = session.wrapKey
  const v1check = await get<KdfRecord>('keyvault', V1.check)
  const mnemonic = session.identity.mnemonic
  if (!v1check || !mnemonic) throw new Error('No unlocked v1 vault to migrate.')

  const mk = WasmDataKey.generate().to_bytes()
  const salt = fromHex(v1check.salt_hex)

  // Step 1: additive writes at new keys — nothing overwrites a v1 record.
  await Promise.all([
    put('keyvault', sealed(mk, AAD.v2mnemonic, enc.encode(mnemonic)), V2.mnemonic),
    put('keyvault', sealed(mk, AAD.v2vaultkey, session.vaultKey.to_bytes()), V2.vaultkey),
    put('keyvault', sealed(mk, AAD.v2check, CHECK_PLAINTEXT), V2.check),
    put('keyvault', kdfRecord(kdfOut, salt, v1check.iterations, AAD.mkPassphrase, mk), MK_PASSPHRASE),
    put('keyvault', record(mk), mkPasskeyKey(cred.credId)),
  ])

  // Step 2: commit.
  await put('keyvault', 2, FORMAT_KEY)

  // Step 3: retire the v1 records.
  await cleanupLegacyV1()

  return mk
}

async function cleanupLegacyV1(): Promise<void> {
  if ((await get('keyvault', V1.check)) === undefined) return
  await Promise.all([del('keyvault', V1.mnemonic), del('keyvault', V1.vaultkey), del('keyvault', V1.check)])
}

/** The passkeys enrolled on this device, newest first. */
export async function listPasskeys(): Promise<PasskeyRecord[]> {
  const all = await getAll<unknown>('keyvault')
  return all
    .filter((r): r is PasskeyRecord => !!r && typeof r === 'object' && 'credId' in r)
    .sort((a, b) => b.created - a.created)
}

/** Forget a passkey's local wrap. The passphrase always remains; the credential
 * itself is not deletable from here (WebAuthn has no site-initiated deletion — it
 * lingers in the platform manager until the user removes it there). */
export async function removePasskey(credId: string): Promise<void> {
  await del('keyvault', mkPasskeyKey(credId))
}

/** Delete the entire local database — used before a restore-from-seed wipes
 * this device's vault. Irreversible; the caller must confirm with the user. */
export async function wipe(): Promise<void> {
  await deleteDb()
}
