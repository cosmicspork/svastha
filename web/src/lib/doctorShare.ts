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
import type { SignedCurationRecord, ConceptStatus } from './curation'
import { conceptKey, conceptKeysForEvents } from './summary'
import { categorize, CATEGORIES, CATEGORY_META, type Category } from './category'
import { isoToMillis } from './time'
import { fromHex } from './hex'
import { bytesToBase64, base64ToBytes } from './base64'
import { attachmentBytes } from './attachments'
import { getProvenance } from './provenance'
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

/** The relay caps a share bundle at 8 MiB (see spec/README.md "Shares"). The
 * sealing nonce+tag add only a few dozen bytes, so bound the plaintext just
 * below the cap and reject early with a friendly message. */
const SHARE_MAX_BYTES = 8 * 1024 * 1024 - 1024

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
  /** Categories to include; null (or empty) means every *non-sensitive*
   * category (see `CATEGORY_META`'s `sensitive` flag) — a share the owner
   * didn't scope explicitly should never carry cycle or mood data by
   * default. An explicit list is honored verbatim, so naming a sensitive
   * category here is exactly the opt-in path. */
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
    const category = categorize(se.event)
    if (cats ? !cats.has(category) : CATEGORY_META[category].sensitive) return false
    const at = se.event.effective_at
    if (openRange) return true
    if (!at) return false
    const ms = isoToMillis(at)
    if (fromMs !== null && ms < fromMs) return false
    if (toMs !== null && ms > toMs) return false
    return true
  })
}

/** Materialize the explicit category scope a new share carries, from the sheet's
 * two independent selections: `selected` (the non-sensitive category chips) and
 * `sensitiveOn` (the opt-in toggles, `cycle`/`mind`). The result is ALWAYS an
 * explicit list in {@link CATEGORIES} order — a share never rides on the
 * null "every non-sensitive category" fallback, so a sensitive category is
 * included only by literally naming it, and can never be swept in implicitly.
 *
 * Returns null as the empty sentinel — nothing selected and nothing opted in —
 * which the sheet uses to disable creation rather than silently treating "no
 * selection" as "everything". (`filterEventsForScope` still honors a null scope
 * as every non-sensitive category, kept as API-level defense-in-depth; this
 * builder just never produces one for a real share.) */
export function deriveShareCategories(
  selected: ReadonlySet<Category>,
  sensitiveOn: ReadonlySet<Category>,
): Category[] | null {
  const list = CATEGORIES.filter((c) => selected.has(c) || sensitiveOn.has(c))
  return list.length > 0 ? list : null
}

/** The bundle plaintext, before sealing. `events` are `SignedEvent`s in exactly
 * the JSON shape the app stores and syncs (`StoredEvent`), so the recipient
 * runs the same verify path a relay pull does. `attachments` inlines the bytes
 * of any captured paper record referenced by those events (base64, keyed by the
 * content hash the `attachment` value carries), so a recipient with no vault key
 * and no relay auth can still open them — a share re-encrypts everything it
 * needs under its own key. Omitted when the scope has no attachments.
 * `documents` does the same for imported source documents (a `doc-` blob an
 * event's `provenance.source_doc` points at) — keyed by the same content hash,
 * carrying `name` alongside the bytes since (unlike an attachment) a `doc-`
 * blob has no stored mime; the recipient derives it from the name the same way
 * the owner's own viewer does (see `provenance.ts`'s `mimeForDocName`). Omitted
 * when the scope references none. */
export interface ShareBundle {
  v: 1
  created_at: string
  /** base64url (unpadded) of the owner's 32-byte Ed25519 public key. */
  signer: string
  events: StoredEvent[]
  attachments?: Record<string, string>
  documents?: Record<string, { name: string; bytes: string }>
  /** The owner's `status:`/`name:` concept curation for the concepts these
   * events fold into — signed records the recipient verifies-or-drops against
   * `signer`, exactly as it does the events. Only these two namespaces cross
   * the vault boundary (never tags/hides/notes/favorites), and only for
   * concepts actually in `events`. Omitted when the scope carries none; an old
   * recipient ignores the unknown field. See {@link curationForBundle}. */
  curation?: SignedCurationRecord[]
}

/** The distinct content hashes of every attachment referenced by these events,
 * in sha order. Pure (no db), so the create UI can count pages from the scoped
 * events without touching storage. */
export function referencedAttachmentShas(events: StoredEvent[]): string[] {
  const shas = new Set<string>()
  for (const se of events) {
    const v = se.event.value
    if (v && 'attachment' in v) shas.add(v.attachment.sha256)
  }
  return [...shas].sort()
}

/** The distinct content hashes of every imported source document these events'
 * provenance points at, in sha order. Mirrors {@link referencedAttachmentShas}
 * for the `doc-` namespace, so the create UI can count both the same way. */
export function referencedDocumentShas(events: StoredEvent[]): string[] {
  const shas = new Set<string>()
  for (const se of events) {
    const sha = se.event.provenance.source_doc
    if (sha) shas.add(sha)
  }
  return [...shas].sort()
}

/** The concept `status:`/`name:` curation records to carry alongside a bundle's
 * events: only those two namespaces, and only for a concept some event in the
 * bundle folds into. Tags, hides, notes, and favorites never leave the vault
 * this way (they are the owner's private working state), and a record for an
 * excluded concept is dropped so the carriage can't leak the shape of what was
 * left out. Unsigned records (a not-yet-migrated pre-signing write) are skipped
 * too — a recipient outside the vault can only trust a signature, so an
 * unsignable record has nothing to carry. Pure over the record list the sheet
 * loads, mirroring the other bundle builders. */
export function curationForBundle(
  events: StoredEvent[],
  records: SignedCurationRecord[],
): SignedCurationRecord[] {
  const concepts = conceptKeysForEvents(events)
  const carried: SignedCurationRecord[] = []
  for (const r of records) {
    const prefix = r.key.startsWith('status:') ? 'status:' : r.key.startsWith('name:') ? 'name:' : null
    if (!prefix) continue
    if (typeof r.signature !== 'string' || r.signature.length === 0) continue
    if (concepts.has(r.key.slice(prefix.length))) carried.push(r)
  }
  return carried
}

/** Apply the meds scope choice: unless `includePastMeds`, drop the events of a
 * medication concept the owner has marked inactive (past), so the default share
 * is a current-only med list. Problems are never dropped here — a resolved
 * problem is clinically informative history, so both active and resolved
 * always ride along (their `status:` records group them for the recipient).
 * Non-medication events pass through untouched. Pure; the sheet reflects its
 * result in the entry count and preview. */
export function applyMedScope(
  events: StoredEvent[],
  statuses: Map<string, ConceptStatus>,
  includePastMeds: boolean,
): StoredEvent[] {
  if (includePastMeds) return events
  return events.filter((se) => {
    if (se.event.kind !== 'medication_statement') return true
    return (statuses.get(conceptKey(se.event)) ?? 'active') === 'active'
  })
}

/** Build the bundle plaintext. `signerEd25519Hex` is the owner's 64-hex-char
 * Ed25519 public key; it is re-encoded to base64url so the recipient can pin
 * every event's `author` (and every carried curation record's `author`) to the
 * one signer named by the bundle. `attachments` (sha256 → base64 plaintext
 * bytes), `documents` (sha256 → name + base64 plaintext bytes), and `curation`
 * (signed `status:`/`name:` records) are inlined only when non-empty. */
export function buildBundle(
  events: StoredEvent[],
  signerEd25519Hex: string,
  createdAtIso: string,
  attachments: Record<string, string> = {},
  curation: SignedCurationRecord[] = [],
  documents: Record<string, { name: string; bytes: string }> = {},
): ShareBundle {
  const bundle: ShareBundle = {
    v: 1,
    created_at: createdAtIso,
    signer: base64url(fromHex(signerEd25519Hex)),
    events,
  }
  if (Object.keys(attachments).length > 0) bundle.attachments = attachments
  if (Object.keys(documents).length > 0) bundle.documents = documents
  if (curation.length > 0) bundle.curation = curation
  return bundle
}

/** Gather a bundle's inlined bytes and build its plaintext — the one place the
 * "what a share contains" contract lives, shared by the relay-link path
 * ({@link createDoctorShare}) and the relay-less file path (`fileShare.ts`), so
 * the two can never drift on scope, curation carriage, or inlined blobs. Reads
 * the local `attachments` and `provenance` stores for the bytes of any captured
 * paper record (`att-`) and imported source document (`doc-`) the scoped events
 * reference; a blob this device never received is silently omitted, mirroring
 * the per-loop behavior documented below. `events` must already be
 * scope-filtered; `curation` already narrowed to the in-scope concepts. */
export async function assembleShareBundle(
  events: StoredEvent[],
  signerEd25519Hex: string,
  curation: SignedCurationRecord[],
  createdAtIso: string,
): Promise<ShareBundle> {
  // Inline the bytes of any captured paper record in scope, so the recipient
  // (no vault key, no relay auth) can open them from the bundle itself.
  const attachments: Record<string, string> = {}
  for (const sha256 of referencedAttachmentShas(events)) {
    const bytes = await attachmentBytes(sha256)
    if (bytes) attachments[sha256] = bytesToBase64(bytes)
  }
  // Same treatment for the imported source documents these events point at.
  // Reads the local `provenance` store regardless of that blob's own sync
  // status — a doc- blob too large for the relay's body cap still lives on the
  // importing device (see import.ts's `tooLargeToSync`), so a share created
  // from that device can still carry it even though a relay pull couldn't. A
  // device that never received the blob (synced from elsewhere) silently omits
  // it here, mirroring the attachment loop above.
  const documents: Record<string, { name: string; bytes: string }> = {}
  for (const sha256 of referencedDocumentShas(events)) {
    const doc = await getProvenance(sha256)
    if (doc) documents[sha256] = { name: doc.name, bytes: bytesToBase64(doc.bytes) }
  }
  return buildBundle(events, signerEd25519Hex, createdAtIso, attachments, curation, documents)
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
  /** The signed `status:`/`name:` records to carry — already narrowed to the
   * concepts in `events` (see {@link curationForBundle}). */
  curation?: SignedCurationRecord[]
  scopeDescription: string
  expiryDays: number
  appOrigin: string
  relayOrigin: string
}): Promise<{ record: DoctorShareRecord; link: string }> {
  const { relay, identity, events, curation = [], scopeDescription, expiryDays, appOrigin, relayOrigin } =
    params

  const token = generateShareToken()
  const keyBytes = crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES))
  const shareKey = WasmDataKey.from_bytes(keyBytes)

  const createdAtIso = new Date().toISOString()
  const bundle = await assembleShareBundle(events, identity.ed25519_public_hex, curation, createdAtIso)
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle))
  // A share is capped tighter than a blob (relay's 8 MiB share ceiling). Catch
  // it here with an honest message rather than letting the PUT 413 — attachments
  // and source documents are what can push a scoped subset over.
  if (plaintext.length > SHARE_MAX_BYTES) {
    throw new Error(
      'This selection is too large to share — it includes more photo pages or documents than a ' +
        'single link can carry. Narrow the dates or categories, or share fewer paper records or documents.',
    )
  }
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
