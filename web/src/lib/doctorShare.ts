// Owner-side doctor sharing: package a scoped subset of the record under a
// fresh per-share key, upload it to the relay under an unguessable bearer
// token, and hand the doctor a link (and QR) that carries the key only in its
// URL fragment. The relay stays zero-knowledge — it holds opaque ciphertext and
// never sees the per-share key (the app's vault key never moves either; a share
// re-seals under its own key). See `spec/README.md`'s "Shares" and
// `docs/ARCHITECTURE.md`'s "Vaults and grants".
//
// The pure builders (token/key generation, bundle shape, link assembly, scope
// filtering) are separated from the wasm/relay/db orchestration so they unit
// test without a browser, mirroring how `summary.ts` stays pure over
// `StoredEvent[]`.
import { WasmDataKey, type WasmIdentity } from './svastha'
import type { RelayClient } from './relay'
import type { StoredEvent } from './events'
import { categorize, type Category } from './category'
import { isoToMillis } from './time'
import { fromHex } from './hex'
import { bytesToBase64, base64ToBytes } from './base64'
import { get, getAll, put } from './db'

/** Token alphabet: URL-safe base64 minus the dot the relay would also allow —
 * the share link uses dots to separate `token.key.relay`, so a dot in the token
 * would break parsing. */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Token length. 26 chars over the 64-symbol alphabet is ~155 bits of entropy,
 * comfortably above the relay's ≥22-char (~128-bit) unguessability floor. */
export const SHARE_TOKEN_LEN = 26

/** Per-share key size — 32 CSPRNG bytes, fed to the same `WasmDataKey` the app
 * seals everything else under. */
const SHARE_KEY_BYTES = 32

/** Base64url (RFC 4648 §5), unpadded — the encoding the share link and bundle
 * signer field use. */
export function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Inverse of {@link base64url}. Re-pads before decoding since `atob` is not
 * guaranteed to tolerate a missing pad across engines. */
export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return base64ToBytes(b64 + pad)
}

/** A fresh share token: {@link SHARE_TOKEN_LEN} chars drawn uniformly from
 * {@link TOKEN_ALPHABET} via a CSPRNG. The 64-symbol alphabet is a power of
 * two, so masking the low 6 bits of each random byte is unbiased — no rejection
 * sampling needed. */
export function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_LEN))
  let out = ''
  for (const b of bytes) out += TOKEN_ALPHABET[b & 63]
  return out
}

export interface ShareScope {
  /** Inclusive ISO lower bound on `effective_at`, or null for open-ended. */
  fromIso: string | null
  /** Inclusive ISO upper bound on `effective_at`, or null for open-ended. */
  toIso: string | null
  /** Categories to include; null (or empty) means every category. */
  categories: Category[] | null
}

/** Filter events to a share scope: category membership plus an `effective_at`
 * date window. Undated events are kept only when the window is fully open (both
 * bounds null): a bounded window is a request for a specific period, and an
 * event with no date can't be placed in one — including it would silently leak
 * out-of-range facts. */
export function filterEventsForScope(events: StoredEvent[], scope: ShareScope): StoredEvent[] {
  const cats = scope.categories && scope.categories.length > 0 ? new Set(scope.categories) : null
  const fromMs = scope.fromIso ? isoToMillis(scope.fromIso) : null
  const toMs = scope.toIso ? isoToMillis(scope.toIso) : null
  const openRange = fromMs === null && toMs === null
  return events.filter((se) => {
    if (cats && !cats.has(categorize(se.event))) return false
    const at = se.event.effective_at
    if (openRange) return true
    if (!at) return false
    const ms = isoToMillis(at)
    if (fromMs !== null && ms < fromMs) return false
    if (toMs !== null && ms > toMs) return false
    return true
  })
}

/** The bundle plaintext, before sealing. `events` are `SignedEvent`s in exactly
 * the JSON shape the app stores and syncs (`StoredEvent`), so the recipient
 * runs the same verify path a relay pull does. */
export interface ShareBundle {
  v: 1
  created_at: string
  /** base64url (unpadded) of the owner's 32-byte Ed25519 public key. */
  signer: string
  events: StoredEvent[]
}

/** Build the bundle plaintext. `signerEd25519Hex` is the owner's 64-hex-char
 * Ed25519 public key; it is re-encoded to base64url so the recipient can pin
 * every event's `author` to the one signer named by the bundle. */
export function buildBundle(
  events: StoredEvent[],
  signerEd25519Hex: string,
  createdAtIso: string,
): ShareBundle {
  return {
    v: 1,
    created_at: createdAtIso,
    signer: base64url(fromHex(signerEd25519Hex)),
    events,
  }
}

/** Assemble the doctor-facing link: `{appOrigin}/#/s/{token}.{key}.{relay}`.
 * `key` is base64url of the 32 per-share key bytes and `relay` is base64url of
 * the relay origin string. Both ride the URL *fragment* (`#…`), which browsers
 * never transmit to a server, so the relay never receives the decryption key. */
export function buildShareLink(
  appOrigin: string,
  token: string,
  keyBytes: Uint8Array,
  relayOrigin: string,
): string {
  const key = base64url(keyBytes)
  const relay = base64url(new TextEncoder().encode(relayOrigin))
  return `${appOrigin}/#/s/${token}.${key}.${relay}`
}

/** The expiry choices the create UI offers; the default is 7 days. The relay
 * clamps anything past 30 days, so 30 is the effective ceiling. */
export const EXPIRY_CHOICES = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const

export const DEFAULT_EXPIRY_DAYS = 7

/** A device-local record of one created share. `key` is base64url of the 32
 * per-share key bytes, kept on-device so an active share's link/QR can be
 * re-shown; it is purged (blanked) once the share is expired or revoked. Never
 * synced — cross-device manage is deferred by design. */
export interface DoctorShareRecord {
  token: string
  key: string
  scopeDescription: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
}

export type ShareStatus = 'active' | 'expired' | 'revoked'

/** Whether a share is still openable. Revocation wins over expiry; both are
 * derived from the record so no background clock is needed. */
export function shareStatus(record: DoctorShareRecord, now: number = Date.now()): ShareStatus {
  if (record.revokedAt) return 'revoked'
  if (isoToMillis(record.expiresAt) <= now) return 'expired'
  return 'active'
}

/** Create a share: generate a token and a fresh key, seal the bundle under that
 * key (AAD = the token's UTF-8 bytes, mirroring the blob-id AAD binding
 * elsewhere), upload it to the relay with the chosen expiry, and record it
 * locally. `events` must already be scope-filtered. Returns the stored record
 * and the doctor-facing link. */
export async function createDoctorShare(params: {
  relay: RelayClient
  identity: WasmIdentity
  events: StoredEvent[]
  scopeDescription: string
  expiryDays: number
  appOrigin: string
  relayOrigin: string
}): Promise<{ record: DoctorShareRecord; link: string }> {
  const { relay, identity, events, scopeDescription, expiryDays, appOrigin, relayOrigin } = params

  const token = generateShareToken()
  const keyBytes = crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES))
  const shareKey = WasmDataKey.from_bytes(keyBytes)

  const createdAtIso = new Date().toISOString()
  const bundle = buildBundle(events, identity.ed25519_public_hex, createdAtIso)
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle))
  const aad = new TextEncoder().encode(token)
  const sealed = shareKey.seal(plaintext, aad)

  const expiresAtSecs = Math.floor(Date.now() / 1000) + expiryDays * 24 * 60 * 60
  await relay.putShare(token, sealed, expiresAtSecs)

  const record: DoctorShareRecord = {
    token,
    key: base64url(keyBytes),
    scopeDescription,
    createdAt: createdAtIso,
    expiresAt: new Date(expiresAtSecs * 1000).toISOString(),
  }
  await put('doctor_shares', record)

  return { record, link: buildShareLink(appOrigin, token, keyBytes, relayOrigin) }
}

/** Rebuild an active share's link from its stored key, or null once the key has
 * been purged (an expired or revoked share has no link to re-show). */
export function shareLinkFor(
  record: DoctorShareRecord,
  appOrigin: string,
  relayOrigin: string,
): string | null {
  if (!record.key) return null
  return buildShareLink(appOrigin, record.token, base64urlToBytes(record.key), relayOrigin)
}

/** All locally-recorded shares, newest first. Lazily purges the stored
 * per-share key of any share that is no longer active: the key is kept on-device
 * only so a live share's link can be re-shown, and a dead share's key is just a
 * needless secret at rest. */
export async function listDoctorShares(): Promise<DoctorShareRecord[]> {
  const all = await getAll<DoctorShareRecord>('doctor_shares')
  const now = Date.now()
  for (const r of all) {
    if (r.key && shareStatus(r, now) !== 'active') {
      r.key = ''
      await put('doctor_shares', r)
    }
  }
  return all.sort((a, b) => isoToMillis(b.createdAt) - isoToMillis(a.createdAt))
}

/** Revoke a share: tell the relay to tombstone the bundle, then mark the local
 * record revoked and purge its key. Revocation only stops *future* fetches — it
 * cannot recall what a recipient already pulled (the UI says so). */
export async function revokeDoctorShare(relay: RelayClient, token: string): Promise<void> {
  await relay.deleteShare(token)
  const record = await get<DoctorShareRecord>('doctor_shares', token)
  if (record) {
    record.revokedAt = new Date().toISOString()
    record.key = ''
    await put('doctor_shares', record)
  }
}
