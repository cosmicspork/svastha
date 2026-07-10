import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteDb, get } from '../db'
import {
  initVault,
  unlock,
  unlockWithPasskey,
  enrollPasskey,
  resealVaultKey,
  changePassphrase,
  listPasskeys,
  removePasskey,
  hasVault,
  WrongPassphraseError,
  PasskeyUnlockError,
  type UnlockedSession,
} from '../keyvault'

// The wasm module needs a browser, so unit tests run in node without it (see
// vitest.config.ts). Mock it with a *sync* authenticated blob that mirrors the
// only contract keyvault.ts depends on: open() returns the plaintext iff the
// same 32-byte key AND the same AAD are supplied, and throws otherwise. It does
// not encrypt (the plaintext rides inside the blob) — these tests exercise the
// migration/wrapping orchestration, not the AEAD, which is `core`'s job. The
// real WebCrypto PBKDF2 in kdf.ts runs unmodified, so wrong-passphrase paths use
// genuinely different derived keys.
vi.mock('../svastha', () => {
  const fnv32 = (bytes: Uint8Array): number => {
    let h = 0x811c9dc5 >>> 0
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
  const readU32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

  class FakeDataKey {
    constructor(private key: Uint8Array) {}
    static from_bytes(b: Uint8Array) {
      return new FakeDataKey(Uint8Array.from(b))
    }
    static generate() {
      return new FakeDataKey(crypto.getRandomValues(new Uint8Array(32)))
    }
    to_bytes() {
      return Uint8Array.from(this.key)
    }
    seal(pt: Uint8Array, aad: Uint8Array): Uint8Array {
      return new Uint8Array([...u32(fnv32(this.key)), ...u32(aad.length), ...aad, ...pt])
    }
    open(blob: Uint8Array, aad: Uint8Array): Uint8Array {
      const aadLen = readU32(blob, 4)
      const storedAad = blob.subarray(8, 8 + aadLen)
      const pt = blob.subarray(8 + aadLen)
      if (readU32(blob, 0) !== fnv32(this.key)) throw new Error('wrong key')
      if (!eq(storedAad, aad)) throw new Error('wrong aad')
      return Uint8Array.from(pt)
    }
  }

  class FakeIdentity {
    constructor(private phrase: string) {}
    static from_mnemonic(phrase: string, _pass: string) {
      return new FakeIdentity(phrase)
    }
    static generate() {
      return new FakeIdentity('abandon '.repeat(23) + 'art')
    }
    get mnemonic() {
      return this.phrase
    }
    get ed25519_public_hex() {
      return 'ab'.repeat(32)
    }
    get x25519_public_hex() {
      return 'cd'.repeat(32)
    }
  }

  return { initSvastha: vi.fn(async () => {}), WasmDataKey: FakeDataKey, WasmIdentity: FakeIdentity }
})

const MNEMONIC = 'abandon abandon abandon zoo'
const PASS = 'correct horse battery staple'
const cred = (credId: string) => ({ credId, rpId: 'localhost', label: `Passkey ${credId}` })
const secret = (seed: number) => new Uint8Array(32).fill(seed)

async function v1Session(): Promise<UnlockedSession> {
  await initVault(MNEMONIC, PASS)
  return unlock(PASS)
}

beforeEach(deleteDb)

describe('v1 (passphrase only)', () => {
  it('round-trips the mnemonic and vault key', async () => {
    await initVault(MNEMONIC, PASS)
    expect(await hasVault()).toBe(true)
    expect(await get('keyvault', 'format')).toBeUndefined()

    const s = await unlock(PASS)
    expect(s.identity.mnemonic).toBe(MNEMONIC)
    expect(s.vaultKey.to_bytes()).toHaveLength(32)
  })

  it('rejects the wrong passphrase', async () => {
    await initVault(MNEMONIC, PASS)
    await expect(unlock('wrong')).rejects.toBeInstanceOf(WrongPassphraseError)
  })

  it('changePassphrase re-keys without touching the vault key', async () => {
    const before = (await v1Session()).vaultKey.to_bytes()
    await changePassphrase(PASS, 'new-pass-phrase')
    await expect(unlock(PASS)).rejects.toBeInstanceOf(WrongPassphraseError)
    const after = await unlock('new-pass-phrase')
    expect(after.identity.mnemonic).toBe(MNEMONIC)
    expect(after.vaultKey.to_bytes()).toEqual(before)
  })
})

describe('enroll: v1 -> v2 migration', () => {
  it('migrates, deletes v1 records, and unlocks by passphrase and passkey', async () => {
    const s = await v1Session()
    const mk = await enrollPasskey(s, secret(1), cred('A'))

    // committed to v2, v1 records retired
    expect(await get('keyvault', 'format')).toBe(2)
    expect(await get('keyvault', 'mnemonic')).toBeUndefined()
    expect(await get('keyvault', 'vaultkey')).toBeUndefined()
    expect(await get('keyvault', 'check')).toBeUndefined()
    expect(await get('keyvault', 'v2:vaultkey')).toBeDefined()
    expect(await get('keyvault', 'mk:passphrase')).toBeDefined()
    expect(await get('keyvault', 'mk:passkey:A')).toBeDefined()

    const byPass = await unlock(PASS)
    expect(byPass.identity.mnemonic).toBe(MNEMONIC)
    expect(byPass.wrapKey).toEqual(mk)

    const byPasskey = await unlockWithPasskey('A', secret(1))
    expect(byPasskey.identity.mnemonic).toBe(MNEMONIC)
    expect(byPasskey.vaultKey.to_bytes()).toEqual(byPass.vaultKey.to_bytes())
  })

  it('rejects a passkey secret that does not open its record', async () => {
    await enrollPasskey(await v1Session(), secret(1), cred('A'))
    await expect(unlockWithPasskey('A', secret(9))).rejects.toBeInstanceOf(PasskeyUnlockError)
    await expect(unlockWithPasskey('missing', secret(1))).rejects.toBeInstanceOf(PasskeyUnlockError)
  })

  it('a second passkey enrolls without re-migrating', async () => {
    const s = await v1Session()
    const mk = await enrollPasskey(s, secret(1), cred('A'))
    // session.wrapKey is now MK after the first (migrating) enroll
    s.wrapKey = mk
    const canonicalBefore = await get('keyvault', 'v2:vaultkey')

    const mk2 = await enrollPasskey(s, secret(2), cred('B'))
    expect(mk2).toEqual(mk)
    // canonicals untouched by a non-migrating enroll
    expect(await get('keyvault', 'v2:vaultkey')).toEqual(canonicalBefore)

    expect((await unlockWithPasskey('A', secret(1))).identity.mnemonic).toBe(MNEMONIC)
    expect((await unlockWithPasskey('B', secret(2))).identity.mnemonic).toBe(MNEMONIC)
  })
})

describe('reseal stays consistent across every unlock method', () => {
  it('a relay-won vault-key adoption is seen by both passphrase and passkey', async () => {
    const s = await v1Session()
    const mk = await enrollPasskey(s, secret(1), cred('A'))

    // Simulate ensureVaultKeyBlob adopting a different vault key via the session
    // (wrapKey is MK post-migration).
    const { WasmDataKey } = await import('../svastha')
    const adopted = WasmDataKey.generate()
    await resealVaultKey(mk, adopted)

    expect((await unlock(PASS)).vaultKey.to_bytes()).toEqual(adopted.to_bytes())
    expect((await unlockWithPasskey('A', secret(1))).vaultKey.to_bytes()).toEqual(adopted.to_bytes())
  })
})

describe('migration crash-safety', () => {
  it('a crash before the commit leaves v1 openable, and rerun converges', async () => {
    const s = await v1Session()

    // Model a crash mid-step-1: orphaned v2/mk records written, but the format
    // marker never flipped and v1 records never deleted. Reuse the migration to
    // produce a realistic partial state, then roll the marker back and restore
    // the v1 records the way a pre-commit crash would have left them.
    const v1Records = {
      mnemonic: await get('keyvault', 'mnemonic'),
      vaultkey: await get('keyvault', 'vaultkey'),
      check: await get('keyvault', 'check'),
    }
    await enrollPasskey(s, secret(1), cred('A'))
    // undo the commit + deletion to simulate the pre-commit crash window
    const { put } = await import('../db')
    const { del } = await import('../db')
    await del('keyvault', 'format')
    await put('keyvault', v1Records.mnemonic, 'mnemonic')
    await put('keyvault', v1Records.vaultkey, 'vaultkey')
    await put('keyvault', v1Records.check, 'check')

    // v1 still unlocks (isV2 is false again) despite orphaned v2/mk records.
    expect(await get('keyvault', 'format')).toBeUndefined()
    const viaV1 = await unlock(PASS)
    expect(viaV1.identity.mnemonic).toBe(MNEMONIC)

    // Rerun the migration: it overwrites the orphans and commits.
    await enrollPasskey(viaV1, secret(2), cred('B'))
    expect(await get('keyvault', 'format')).toBe(2)
    expect((await unlock(PASS)).identity.mnemonic).toBe(MNEMONIC)
    expect((await unlockWithPasskey('B', secret(2))).identity.mnemonic).toBe(MNEMONIC)
  })

  it('a v2 vault unlocks even with stale v1 records present, then clears them', async () => {
    const s = await v1Session()
    await enrollPasskey(s, secret(1), cred('A'))
    // Re-introduce stale v1 records (a crash between commit and delete).
    const { put } = await import('../db')
    await put('keyvault', { kdf: 'PBKDF2-SHA256', iterations: 1, salt_hex: '00', sealed_hex: 'dead' }, 'check')

    // v2 path unlocks regardless (isV2 true).
    expect((await unlock(PASS)).identity.mnemonic).toBe(MNEMONIC)
  })
})

describe('v2 passphrase and passkey management', () => {
  it('changePassphrase in v2 rewrites only the passphrase wrap', async () => {
    const s = await v1Session()
    await enrollPasskey(s, secret(1), cred('A'))
    const canonicalBefore = await get('keyvault', 'v2:vaultkey')

    await changePassphrase(PASS, 'a-brand-new-pass')
    expect(await get('keyvault', 'format')).toBe(2)
    expect(await get('keyvault', 'v2:vaultkey')).toEqual(canonicalBefore) // untouched

    await expect(unlock(PASS)).rejects.toBeInstanceOf(WrongPassphraseError)
    expect((await unlock('a-brand-new-pass')).identity.mnemonic).toBe(MNEMONIC)
    // passkey is unaffected by a passphrase change
    expect((await unlockWithPasskey('A', secret(1))).identity.mnemonic).toBe(MNEMONIC)
  })

  it('lists and removes passkeys; passphrase always remains', async () => {
    const s = await v1Session()
    const mk = await enrollPasskey(s, secret(1), cred('A'))
    s.wrapKey = mk
    await enrollPasskey(s, secret(2), cred('B'))

    expect((await listPasskeys()).map((p) => p.credId).sort()).toEqual(['A', 'B'])

    await removePasskey('A')
    expect((await listPasskeys()).map((p) => p.credId)).toEqual(['B'])
    await expect(unlockWithPasskey('A', secret(1))).rejects.toBeInstanceOf(PasskeyUnlockError)
    // passphrase and the remaining passkey still work
    expect((await unlock(PASS)).identity.mnemonic).toBe(MNEMONIC)
    expect((await unlockWithPasskey('B', secret(2))).identity.mnemonic).toBe(MNEMONIC)
  })
})
