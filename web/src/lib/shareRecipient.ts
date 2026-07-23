// The RECIPIENT side of doctor sharing: a share link opened cold in any browser,
// with no account, no vault, and nothing persisted. The link's fragment carries
// a bearer token (fetches the sealed bundle from the relay) and the decryption
// key (never leaves the tab). This module is the whole pipeline — parse the
// fragment, fetch by token, open in memory, verify every event's signature —
// deliberately kept out of relay.ts/sync.ts/shared.ts: those are the owner's own
// authenticated, persisted trust boundary, and a share view is neither.
//
// See docs/ARCHITECTURE.md ("Vaults and grants") and spec/README.md ("Shares").
import { WasmDataKey, verify_event, verify_curation } from './svastha'
import { base64ToBytes } from './base64'
import { toHex } from './hex'
import type { StoredEvent } from './events'
import type { SignedCurationRecord } from './curation'

/** A share token is exactly the relay's charset and length (see
 * `crates/relay/src/routes.rs`'s `valid_share_token`): 26 chars of the blob-id
 * alphabet, which never includes a dot — that is what lets the fragment split
 * cleanly on `.`. */
const TOKEN_RE = /^[A-Za-z0-9_-]{26}$/

export interface ParsedFragment {
  token: string
  /** The 32 raw share-key bytes. */
  key: Uint8Array
  /** The relay origin, e.g. `https://relay.example.org` (no trailing slash). */
  relay: string
}

export interface OpenedBundle {
  /** ISO8601 instant the owner sealed the bundle. */
  createdAt: string
  /** The owner's Ed25519 public key as 64 hex chars — every kept event's
   * `author` equals this, and the header shows its short fingerprint for
   * out-of-band confirmation. */
  signerHex: string
  /** Only the events whose signature verified against `signerHex`. */
  events: StoredEvent[]
  verified: number
  /** Events dropped because they failed verification — a non-zero count drives
   * a visible warning rather than silently rendering a tampered subset. */
  dropped: number
  /** Inlined captured-document bytes (sha256 → base64 plaintext), for the
   * viewer to render paper records the events reference. Empty when the share
   * carried none. */
  attachments: Record<string, string>
  /** Inlined imported-source-document bytes (sha256 → name + base64
   * plaintext), for the viewer to render the original C-CDA/FHIR/PDF an
   * event's `provenance.source_doc` points at. Empty when the share carried
   * none. */
  documents: Record<string, { name: string; bytes: string }>
  /** Only the `status:`/`name:` curation records whose signature verified
   * against `signerHex` — folded into the summary's Current/Past + Active/
   * Resolved grouping and name overrides, the same view the owner sees. Empty
   * when the share carried none. */
  curation: SignedCurationRecord[]
  /** Curation records dropped because their signature failed verification —
   * counted and surfaced like {@link dropped}, so a tampered status/name record
   * is visibly rejected rather than silently rendered. */
  droppedCuration: number
}

/** Each maps to one specific, honest error state in the UI. `expired` and
 * `network` are the only ones the sender/reader can act on (ask for a new link;
 * retry); `invalid`/`damaged` are terminal for this link. */
export type ShareError = 'invalid' | 'expired' | 'damaged' | 'network'

export type ShareLoadResult =
  | { status: 'ok'; bundle: OpenedBundle }
  | { status: 'error'; error: ShareError }

/** Decode base64url (unpadded) to bytes, throwing on any non-alphabet input.
 * The key and relay fragment segments are both base64url unpadded per the
 * pinned link contract. */
function base64urlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64url')
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return base64ToBytes(b64 + pad)
}

/**
 * Parse `#/s/{token}.{key}.{relay}` (or the bare `/s/…` path). Returns null for
 * anything malformed — a missing prefix, the wrong number of dot-separated
 * segments, a bad token, a key that isn't 32 bytes, or a relay that isn't an
 * absolute http(s) origin. A null here is the UI's "invalid or incomplete" link.
 */
export function parseShareFragment(hash: string): ParsedFragment | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const PREFIX = '/s/'
  if (!h.startsWith(PREFIX)) return null

  // token, key, and relay are all base64url-ish and never contain a dot, so a
  // well-formed fragment is exactly three dot-separated segments.
  const parts = h.slice(PREFIX.length).split('.')
  if (parts.length !== 3) return null
  const [token, keyB64, relayB64] = parts
  if (!TOKEN_RE.test(token)) return null

  let key: Uint8Array
  let relay: string
  try {
    key = base64urlToBytes(keyB64)
    relay = new TextDecoder().decode(base64urlToBytes(relayB64))
  } catch {
    return null
  }
  if (key.length !== 32) return null

  // The relay must be an absolute http(s) origin: fetch()ing an attacker-chosen
  // arbitrary string is a needless foot-gun, and anything else is a broken link.
  if (!/^https?:\/\/[^\s]+$/.test(relay)) return null

  return { token, key, relay: relay.replace(/\/+$/, '') }
}

/**
 * Validate the decrypted plaintext against the pinned bundle contract:
 * `{ v: 1, created_at, signer, events: [...] }`, with `signer` a base64url
 * unpadded 32-byte Ed25519 key. Returns null (→ "damaged link") on malformed
 * JSON, a version other than 1, or any missing/mistyped field. Does NOT verify
 * signatures — that is `verifyBundleEvents`/`verifyBundleCuration`, split out so
 * the pure-JSON shape check is testable without wasm. `attachments`,
 * `documents`, and `curation` are all optional: a bundle from before a given
 * field existed omits it and must still validate identically (each defaults to
 * empty), and a present field is only shape-checked here — its records are
 * verified-or-dropped later (curation) or trusted as part of the AEAD-sealed
 * whole (attachments/documents — see `openShareBundle`).
 */
export function validateBundle(json: string): {
  createdAt: string
  signerHex: string
  events: StoredEvent[]
  attachments: Record<string, string>
  documents: Record<string, { name: string; bytes: string }>
  curation: SignedCurationRecord[]
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const b = parsed as Record<string, unknown>
  if (b.v !== 1) return null
  if (typeof b.created_at !== 'string') return null
  if (typeof b.signer !== 'string') return null
  if (!Array.isArray(b.events)) return null

  let signerHex: string
  try {
    const signerBytes = base64urlToBytes(b.signer)
    if (signerBytes.length !== 32) return null
    signerHex = toHex(signerBytes)
  } catch {
    return null
  }

  // `attachments` is optional (older bundles and attachment-free scopes omit
  // it). When present it must be a flat string→string map; anything else is a
  // damaged bundle rather than a silently-ignored field.
  let attachments: Record<string, string> = {}
  if (b.attachments !== undefined) {
    if (!b.attachments || typeof b.attachments !== 'object' || Array.isArray(b.attachments)) return null
    const entries = Object.entries(b.attachments as Record<string, unknown>)
    if (!entries.every(([, v]) => typeof v === 'string')) return null
    attachments = Object.fromEntries(entries) as Record<string, string>
  }

  // `documents` is optional (older bundles and document-free scopes omit it).
  // When present it must be a flat map to `{ name: string, bytes: string }` —
  // a `doc-` blob carries no mime, unlike an attachment, so `name` rides along
  // for the viewer to derive one (see provenance.ts's `mimeForDocName`).
  let documents: Record<string, { name: string; bytes: string }> = {}
  if (b.documents !== undefined) {
    if (!b.documents || typeof b.documents !== 'object' || Array.isArray(b.documents)) return null
    const entries = Object.entries(b.documents as Record<string, unknown>)
    const valid = entries.every(([, v]) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false
      const doc = v as Record<string, unknown>
      return typeof doc.name === 'string' && typeof doc.bytes === 'string'
    })
    if (!valid) return null
    documents = Object.fromEntries(entries) as Record<string, { name: string; bytes: string }>
  }

  // `curation` is optional (older bundles and curation-free scopes omit it).
  // When present it must be an array; the per-record shape and signature are
  // not checked here — `verifyBundleCuration` verifies-or-drops each, so a
  // malformed or forged element is dropped and counted rather than damaging the
  // whole bundle.
  let curation: SignedCurationRecord[] = []
  if (b.curation !== undefined) {
    if (!Array.isArray(b.curation)) return null
    curation = b.curation as SignedCurationRecord[]
  }

  return { createdAt: b.created_at, signerHex, events: b.events as StoredEvent[], attachments, documents, curation }
}

/**
 * Verify each event, dropping and counting the failures. An event is kept only
 * if its own signature verifies (`verify_event`) AND its `author` is the
 * bundle's declared signer — the same two-part check the owner's shared pull
 * makes (see shared.ts): a relay could otherwise splice in a validly-signed but
 * foreign event, and a signature alone would not catch it.
 */
export function verifyBundleEvents(
  events: StoredEvent[],
  signerHex: string,
): { events: StoredEvent[]; verified: number; dropped: number } {
  const good: StoredEvent[] = []
  let dropped = 0
  for (const se of events) {
    let ok = false
    try {
      ok = se?.author === signerHex && verify_event(JSON.stringify(se))
    } catch {
      ok = false
    }
    if (ok) good.push(se)
    else dropped++
  }
  return { events: good, verified: good.length, dropped }
}

/**
 * Verify each carried curation record, dropping and counting the failures — the
 * same two-part check `verifyBundleEvents` makes: the record's own signature
 * must verify (`verify_curation`) AND its `author` must equal the bundle's
 * declared signer. A record outside the vault carries no AEAD seal a recipient
 * can trust, so an unsigned or foreign-authored record has no standing here and
 * is dropped (unlike the owner's own-vault pull, which grandfathers a
 * pre-signing record). `verify_curation` throws on a malformed record, which the
 * catch folds into a drop as well.
 */
export function verifyBundleCuration(
  records: SignedCurationRecord[],
  signerHex: string,
): { records: SignedCurationRecord[]; dropped: number } {
  const good: SignedCurationRecord[] = []
  let dropped = 0
  for (const r of records) {
    let ok = false
    try {
      ok = r?.author === signerHex && typeof r.signature === 'string' && verify_curation(JSON.stringify(r))
    } catch {
      ok = false
    }
    if (ok) good.push(r)
    else dropped++
  }
  return { records: good, dropped }
}

/**
 * Decrypt the sealed bundle in memory and verify it. AAD is the token string's
 * UTF-8 bytes (the pinned contract), binding the ciphertext to the token it was
 * fetched under. Returns null (→ "damaged link") on any decrypt/parse/shape
 * failure. Requires `initSvastha()` to have run.
 */
export function openShareBundle(
  sealed: Uint8Array,
  token: string,
  key: Uint8Array,
): OpenedBundle | null {
  let plaintext: Uint8Array
  try {
    const dataKey = WasmDataKey.from_bytes(key)
    plaintext = dataKey.open(sealed, new TextEncoder().encode(token))
  } catch {
    return null
  }

  const validated = validateBundle(new TextDecoder().decode(plaintext))
  if (!validated) return null

  const { events, verified, dropped } = verifyBundleEvents(validated.events, validated.signerHex)
  const curation = verifyBundleCuration(validated.curation, validated.signerHex)
  return {
    createdAt: validated.createdAt,
    signerHex: validated.signerHex,
    events,
    verified,
    dropped,
    attachments: validated.attachments,
    documents: validated.documents,
    curation: curation.records,
    droppedCuration: curation.dropped,
  }
}

/** Fetch the sealed bundle by bearer token — the system's only unauthenticated
 * read. A plain `fetch()`, deliberately NOT the signed `RelayClient`: a share
 * reader has no identity. `410` is expired/revoked, `404` never-existed; other
 * transport failures fold to a retryable `network`. */
async function fetchShareBundle(
  relay: string,
  token: string,
): Promise<{ status: 'ok'; bytes: Uint8Array } | { status: 'error'; error: ShareError }> {
  let resp: Response
  try {
    resp = await fetch(`${relay}/v0/share/${token}`)
  } catch {
    return { status: 'error', error: 'network' }
  }
  if (resp.status === 410) return { status: 'error', error: 'expired' }
  if (resp.status === 404) return { status: 'error', error: 'invalid' }
  if (!resp.ok) return { status: 'error', error: 'network' }
  try {
    return { status: 'ok', bytes: new Uint8Array(await resp.arrayBuffer()) }
  } catch {
    return { status: 'error', error: 'network' }
  }
}

/** The whole recipient pipeline: parse → fetch → open+verify, mapping each
 * failure to its specific error state. */
export async function loadShare(hash: string): Promise<ShareLoadResult> {
  const parsed = parseShareFragment(hash)
  if (!parsed) return { status: 'error', error: 'invalid' }

  const fetched = await fetchShareBundle(parsed.relay, parsed.token)
  if (fetched.status === 'error') return { status: 'error', error: fetched.error }

  const bundle = openShareBundle(fetched.bytes, parsed.token, parsed.key)
  if (!bundle) return { status: 'error', error: 'damaged' }

  return { status: 'ok', bundle }
}
