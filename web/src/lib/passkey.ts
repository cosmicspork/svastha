// WebAuthn PRF: derive a stable 32-byte wrapping secret from a platform passkey
// (Face ID / Touch ID / Android biometric, optionally via a PRF-capable manager
// like 1Password or Bitwarden). That secret wraps the keyvault master key — see
// keyvault.ts's `enrollPasskey`/`unlockWithPasskey`. This module is pure
// WebAuthn + HKDF; it never touches storage.
//
// PRF support is per-authenticator and cannot be feature-detected up front, so
// detection is empirical: only a credential that reports `prf.enabled` (enroll)
// or returns a PRF result (unlock) is usable. `passkeysSupported()` only gates
// whether the WebAuthn API exists at all.
import { toHex, fromHex } from './hex'

const enc = new TextEncoder()

// Fixed PRF input. The credential id already scopes the derived secret, so a
// constant salt is sufficient; it must never change once passkeys exist, or
// every enrolled passkey would derive a different secret and stop unlocking.
const PRF_SALT = enc.encode('svastha/keyvault/passkey/prf/v1')

// A fixed WebAuthn user handle so a device's passkeys group under one "account"
// in the platform manager. Not a secret; not the identity.
const USER_HANDLE = enc.encode('svastha-local-vault')

/** Thrown when the authenticator completed but does not support the PRF
 * extension, so no secret can be derived. */
export class PasskeyNotSupportedError extends Error {
  constructor() {
    super("This device's passkey can't be used to unlock the vault. Keep using your passphrase.")
    this.name = 'PasskeyNotSupportedError'
  }
}

/** True when the WebAuthn API is present at all. Whether a given passkey can
 * actually derive a PRF secret is only known after an enroll/unlock attempt. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials?.create
  )
}

// TS's DOM lib does not yet type the `prf` extension, so build the input shape
// here and cast it to the DOM type at the option boundary, and read the output
// shape via a cast.
interface PrfExtensionOutput {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}
function prfExtension(): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: PRF_SALT } } } as unknown as AuthenticationExtensionsClientInputs
}

/** HKDF-SHA256 the raw PRF output into the 32-byte wrapping secret, domain-
 * separated so the raw PRF value is never used directly as a key. */
async function deriveSecret(prfOutput: ArrayBuffer): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode('svastha/keyvault/passkey-mk-wrap'),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

function randomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export interface EnrolledPasskey {
  credId: string
  rpId: string
  secret: Uint8Array
}

/**
 * Create a passkey and derive its wrapping secret. UV is required (the PRF
 * output is UV-scoped — relaxing it would change the secret). `existingCredIds`
 * are excluded so re-enrollment can't mint duplicate credentials.
 *
 * Returns null if the user cancels or no authenticator is available; throws
 * {@link PasskeyNotSupportedError} if the authenticator lacks PRF.
 */
export async function enrollPasskey(existingCredIds: string[]): Promise<EnrolledPasskey | null> {
  const rpId = window.location.hostname
  const created = await create({
    challenge: randomChallenge() as BufferSource,
    rp: { name: 'Svastha' },
    user: { id: USER_HANDLE as BufferSource, name: 'Svastha vault', displayName: 'Svastha vault' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existingCredIds.map((id) => ({ type: 'public-key', id: fromHex(id) as BufferSource })),
    extensions: prfExtension(),
  })
  if (!created) return null

  const ext = created.getClientExtensionResults() as PrfExtensionOutput
  if (!ext.prf?.enabled) throw new PasskeyNotSupportedError()

  const credId = toHex(new Uint8Array(created.rawId))

  // Some authenticators return the PRF result on create(); others only on a
  // follow-up get(). Prefer create's result, fall back to an assertion.
  let prfOutput = ext.prf.results?.first
  if (!prfOutput) {
    const asserted = await authenticateRaw([credId])
    if (!asserted) return null
    prfOutput = asserted.prfOutput
  }

  return { credId, rpId, secret: await deriveSecret(prfOutput) }
}

export interface PasskeyAssertion {
  credId: string
  secret: Uint8Array
}

/** Assert one of `credIds` and derive its wrapping secret. Returns null on
 * cancel; throws {@link PasskeyNotSupportedError} if PRF yields nothing. */
export async function authenticate(credIds: string[]): Promise<PasskeyAssertion | null> {
  const raw = await authenticateRaw(credIds)
  if (!raw) return null
  return { credId: raw.credId, secret: await deriveSecret(raw.prfOutput) }
}

async function authenticateRaw(
  credIds: string[],
): Promise<{ credId: string; prfOutput: ArrayBuffer } | null> {
  const asserted = await getAssertion({
    challenge: randomChallenge() as BufferSource,
    allowCredentials: credIds.map((id) => ({ type: 'public-key', id: fromHex(id) as BufferSource })),
    userVerification: 'required',
    extensions: prfExtension(),
  })
  if (!asserted) return null
  const ext = asserted.getClientExtensionResults() as PrfExtensionOutput
  const prfOutput = ext.prf?.results?.first
  if (!prfOutput) throw new PasskeyNotSupportedError()
  return { credId: toHex(new Uint8Array(asserted.rawId)), prfOutput }
}

// --- thin wrappers that map user-cancel (NotAllowedError) to null ---

async function create(publicKey: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential | null> {
  try {
    return (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return null
    throw err
  }
}

async function getAssertion(publicKey: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential | null> {
  try {
    return (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return null
    throw err
  }
}
