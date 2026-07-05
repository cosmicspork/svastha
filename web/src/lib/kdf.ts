// Passphrase -> key-wrapping-key derivation. Split out from keyvault.ts so
// tests can exercise it without importing the wasm module (which needs a
// browser) — this file has no dependency beyond WebCrypto.

export const DEFAULT_ITERATIONS = 600_000
export const SALT_LEN = 16

/** PBKDF2-SHA256, 32-byte output. */
export async function deriveKdfBytes(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}
