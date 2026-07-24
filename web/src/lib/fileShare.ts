// Relay-less doctor share: the same sealed bundle `doctorShare.ts` uploads to
// the relay, written instead to a FILE the owner hands over out of band
// (AirDrop, a USB stick, a clinic-portal upload). No relay round-trip, no
// bearer token, no expiry — and, by construction, no revocation: once the file
// is handed over it is a copy, exactly like a paper folder. The UI says so.
//
// The bundle itself is byte-for-byte the relay path's bundle (`assembleShareBundle`
// in doctorShare.ts): same scope filter, same `status:`/`name:` curation, same
// inlined `att-`/`doc-` bytes, same `WasmDataKey` sealing. This file changes only
// two things — where the ciphertext travels (a file, not the relay) and where its
// key comes from (a passphrase-derived key, or one embedded in the header). The
// bundle is app-level and opaque to the relay per spec/README.md's "Shares", so
// this is NOT a contract change and `CONTRACT_VERSION` does not move.
//
// File layout: a small versioned header, then the sealed bundle bytes.
//
//   offset size  field
//   0      4     magic "SVSH"
//   4      1     format version (1)
//   5      1     mode (1 = embedded, 2 = passphrase)
//   -- embedded --
//   6      32    raw 32-byte share key (possession = access)
//   -- passphrase --
//   6      16    PBKDF2 salt
//   22     4     PBKDF2 iteration count (u32, big-endian)
//   -- both --
//   <hdr>  ...   the sealed bundle (WasmDataKey.seal output)
//
// The pure header/KDF/passphrase builders are separated from the wasm sealing so
// they unit-test without a browser, mirroring doctorShare.ts's split.
import { WasmDataKey, type WasmIdentity } from './svastha'
import type { StoredEvent } from './events'
import type { SignedCurationRecord } from './curation'
import { assembleShareBundle } from './doctorShare'
import { openBundlePlaintext, type OpenedBundle } from './shareRecipient'
import { getAll, put } from './db'
import { isoToMillis } from './time'

/** File magic: ASCII "SVSH". Four bytes so a wrong file type is rejected at
 * parse time (a "damaged file", distinct from a wrong passphrase). */
export const MAGIC = new Uint8Array([0x53, 0x56, 0x53, 0x48])
/** App-level format version, independent of the wire `CONTRACT_VERSION` (this
 * format sits below the wire contract, like the export container does). */
export const FORMAT_VERSION = 1

const MODE_EMBEDDED = 1
const MODE_PASSPHRASE = 2

export type FileShareMode = 'passphrase' | 'embedded'

/** File extension the export writes and the picker suggests. */
export const FILE_SHARE_EXT = '.svashare'

const SHARE_KEY_BYTES = 32
const SALT_BYTES = 16

/** PBKDF2-SHA-256 iteration count, matching the app's at-rest keyvault KDF
 * (docs/ARCHITECTURE.md, "Seed custody"). PBKDF2 is only as strong as the
 * secret it stretches; that is acceptable here precisely because the passphrase
 * is app-GENERATED at ≥ 64 bits (see FILE_SHARE_PASSPHRASE_WORDS) rather than
 * human-chosen — the KDF is defence in depth over already-adequate entropy, not
 * the sole barrier, so a high iteration count with no new argon2/wasm dependency
 * is the right trade. The count rides in the header so a future raise still
 * opens today's files. */
export const PBKDF2_ITERATIONS = 600_000

/** Words drawn for a generated passphrase. The embedded EFF short wordlist is
 * 1296 = 6^4 words, so each uniformly-drawn word is log2(1296) ≈ 10.34 bits;
 * 7 words ≈ 72.4 bits, comfortably over the 64-bit floor the design sets. */
export const FILE_SHARE_PASSPHRASE_WORDS = 7

/** AEAD associated data for a file share. Fixed and version-scoped: unlike the
 * relay path there is no bearer token to bind, and the header's key/salt already
 * fully determine decryptability, so a constant is sufficient (and keeps the
 * seal construction otherwise identical to the relay path's). */
export const FILE_SHARE_AAD = new TextEncoder().encode('svastha:file-share:1')

/** A file share carries no relay cap (that 8 MiB ceiling is the relay's, not the
 * format's). This is only a soft "this is getting large" threshold for the
 * export UI — over it, warn but still allow. */
export const FILE_SHARE_SOFT_WARN_BYTES = 8 * 1024 * 1024

// --- header encode/parse (pure) ---

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  )
}

/** The embedded-mode header: magic, version, mode, then the raw share key. */
export function buildEmbeddedHeader(key: Uint8Array): Uint8Array {
  if (key.length !== SHARE_KEY_BYTES) throw new Error('share key must be 32 bytes')
  return new Uint8Array([...MAGIC, FORMAT_VERSION, MODE_EMBEDDED, ...key])
}

/** The passphrase-mode header: magic, version, mode, salt, iteration count. */
export function buildPassphraseHeader(salt: Uint8Array, iterations: number): Uint8Array {
  if (salt.length !== SALT_BYTES) throw new Error('salt must be 16 bytes')
  return new Uint8Array([...MAGIC, FORMAT_VERSION, MODE_PASSPHRASE, ...salt, ...u32be(iterations)])
}

export type ParsedHeader =
  | { mode: 'embedded'; key: Uint8Array; body: Uint8Array }
  | { mode: 'passphrase'; salt: Uint8Array; iterations: number; body: Uint8Array }

/** Parse and validate a file share's header, returning the mode-specific fields
 * and the sealed `body` that follows. Returns null for anything structurally
 * wrong — wrong magic, unknown version or mode, a truncated header, or no body —
 * which the recipient surfaces as a "damaged file" (distinct from a wrong
 * passphrase, which is a valid header that simply fails to decrypt). */
export function parseHeader(bytes: Uint8Array): ParsedHeader | null {
  if (bytes.length < 6) return null
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null
  if (bytes[4] !== FORMAT_VERSION) return null
  const mode = bytes[5]
  if (mode === MODE_EMBEDDED) {
    const bodyOffset = 6 + SHARE_KEY_BYTES
    if (bytes.length <= bodyOffset) return null
    return { mode: 'embedded', key: bytes.slice(6, bodyOffset), body: bytes.slice(bodyOffset) }
  }
  if (mode === MODE_PASSPHRASE) {
    const bodyOffset = 6 + SALT_BYTES + 4
    if (bytes.length <= bodyOffset) return null
    const salt = bytes.slice(6, 6 + SALT_BYTES)
    const iterations = readU32be(bytes, 6 + SALT_BYTES)
    if (iterations <= 0) return null
    return { mode: 'passphrase', salt, iterations, body: bytes.slice(bodyOffset) }
  }
  return null
}

/** Concatenate a header and the sealed bundle into the file's bytes. */
export function assembleFile(header: Uint8Array, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + sealed.length)
  out.set(header, 0)
  out.set(sealed, header.length)
  return out
}

// --- passphrase generation & KDF (pure over WebCrypto) ---

/** A uniform index in [0, n) via rejection sampling over a Uint32 — no modulo
 * bias, which matters when n (1296) is not a power of two. */
function uniformIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  let x: number
  do {
    crypto.getRandomValues(buf)
    x = buf[0]
  } while (x >= limit)
  return x % n
}

/** Generate an app-chosen passphrase: {@link FILE_SHARE_PASSPHRASE_WORDS} words
 * drawn uniformly (CSPRNG, unbiased) from the embedded EFF short wordlist,
 * space-separated. Never user-chosen — the known, high entropy is what lets the
 * KDF be PBKDF2. The wordlist is dynamically imported so it never weighs on the
 * main bundle (only the export path calls this; the recipient derives from the
 * typed phrase and needs no list). */
export async function generatePassphrase(words: number = FILE_SHARE_PASSPHRASE_WORDS): Promise<string> {
  const { WORDLIST } = await import('./wordlist')
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDLIST[uniformIndex(WORDLIST.length)])
  return out.join(' ')
}

/** Canonical form fed to the KDF: trimmed, lowercased, inner whitespace
 * collapsed to single spaces. Applied to both the generated phrase and the
 * recipient's typed input so casing and spacing never change the derived key
 * (one wordlist entry, "yo-yo", carries a hyphen, so words are separated by
 * spaces only — never hyphens — and this normalization leaves it intact). */
export function normalizePassphrase(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Derive the 32-byte share key from a passphrase via PBKDF2-SHA-256. The
 * passphrase is normalized first, so the recipient's typing need not match the
 * displayed spacing/casing byte-for-byte. */
export async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = new TextEncoder().encode(normalizePassphrase(passphrase))
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    SHARE_KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

// --- export (owner side; needs wasm seal + the bundle assembler) ---

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

export function fileShareFilename(now: Date): string {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  return `svastha-share-${stamp}${FILE_SHARE_EXT}`
}

/** Seal a bundle plaintext under a fresh key with the fixed file-share AAD —
 * the same `WasmDataKey.seal` the relay path uses, only the AAD source differs. */
function sealBundle(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  return WasmDataKey.from_bytes(key).seal(plaintext, FILE_SHARE_AAD)
}

export interface FileShareExport {
  bytes: Uint8Array
  filename: string
  mode: FileShareMode
  /** The generated passphrase — present only in passphrase mode, shown ONCE at
   * export and never persisted. Null in embedded mode. */
  passphrase: string | null
  sizeBytes: number
  /** Whether the file crossed the soft size warning (never a hard failure). */
  large: boolean
}

/** Build a relay-less share file. `events` must already be scope-filtered and
 * `curation` narrowed to the in-scope concepts (the create sheet does both,
 * exactly as for a relay link). Passphrase mode derives the key from a fresh
 * generated phrase; embedded mode rides a random key in the header. */
export async function createFileShare(params: {
  identity: WasmIdentity
  events: StoredEvent[]
  curation?: SignedCurationRecord[]
  mode: FileShareMode
  now?: Date
}): Promise<FileShareExport> {
  const { identity, events, curation = [], mode, now = new Date() } = params

  const bundle = await assembleShareBundle(events, identity.ed25519_public_hex, curation, now.toISOString())
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle))

  let header: Uint8Array
  let key: Uint8Array
  let passphrase: string | null = null
  if (mode === 'passphrase') {
    passphrase = await generatePassphrase()
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    key = await derivePassphraseKey(passphrase, salt, PBKDF2_ITERATIONS)
    header = buildPassphraseHeader(salt, PBKDF2_ITERATIONS)
  } else {
    key = crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES))
    header = buildEmbeddedHeader(key)
  }

  const sealed = sealBundle(plaintext, key)
  const bytes = assembleFile(header, sealed)
  return {
    bytes,
    filename: fileShareFilename(now),
    mode,
    passphrase,
    sizeBytes: bytes.length,
    large: bytes.length > FILE_SHARE_SOFT_WARN_BYTES,
  }
}

// --- share history (owner side; device-local, never synced) ---

/** A device-local record that a file share was created. Deliberately holds NO
 * key material and NO passphrase — a file share is unrevocable and never
 * expires, so there is nothing to re-show and nothing to purge; this is purely
 * a history entry. It lives in its own store so the relay-link tombstone sweep
 * (`listDoctorShares`) never touches it. */
export interface FileShareRecord {
  id: string
  mode: FileShareMode
  scopeDescription: string
  createdAt: string
}

/** Record that a file share was created. */
export async function recordFileShare(entry: {
  mode: FileShareMode
  scopeDescription: string
  createdAt: string
}): Promise<FileShareRecord> {
  const record: FileShareRecord = { id: `file:${crypto.randomUUID()}`, ...entry }
  await put('file_shares', record)
  return record
}

/** All recorded file shares, newest first. No purge: a file share holds no key
 * or expiry to clean up. */
export async function listFileShares(): Promise<FileShareRecord[]> {
  const all = await getAll<FileShareRecord>('file_shares')
  return all.sort((a, b) => isoToMillis(b.createdAt) - isoToMillis(a.createdAt))
}

// --- recipient side (open a share file) ---

/** Open the sealed body under a known key with the file-share AAD, then run the
 * shared validate → verify-or-drop pipeline. Null on any decrypt/shape failure. */
function openBody(body: Uint8Array, key: Uint8Array): OpenedBundle | null {
  let plaintext: Uint8Array
  try {
    plaintext = WasmDataKey.from_bytes(key).open(body, FILE_SHARE_AAD)
  } catch {
    return null
  }
  return openBundlePlaintext(plaintext)
}

export type FileShareInspection =
  | { status: 'ok'; bundle: OpenedBundle }
  | { status: 'passphrase'; body: Uint8Array; salt: Uint8Array; iterations: number }
  | { status: 'damaged' }

/**
 * First look at a share file's bytes. A valid embedded-mode file opens straight
 * away (`ok`); a valid passphrase-mode file returns `passphrase` with the
 * material the caller needs to prompt and retry; anything with an invalid header,
 * or an embedded file that fails to decrypt, is `damaged`. Requires
 * `initSvastha()` to have run. Synchronous — passphrase derivation (the only
 * async step) is deferred to {@link openWithPassphrase}.
 */
export function inspectFileShare(bytes: Uint8Array): FileShareInspection {
  const header = parseHeader(bytes)
  if (!header) return { status: 'damaged' }
  if (header.mode === 'passphrase') {
    return { status: 'passphrase', body: header.body, salt: header.salt, iterations: header.iterations }
  }
  const bundle = openBody(header.body, header.key)
  // A well-formed embedded header whose body won't open is a corrupted file, not
  // a passphrase problem — there is no phrase to retry, so it is damaged.
  return bundle ? { status: 'ok', bundle } : { status: 'damaged' }
}

/**
 * Attempt to open a passphrase-mode file with a candidate phrase. Returns the
 * opened bundle, or null for a wrong phrase (the caller offers a friendly
 * retry). A genuinely corrupted body with the right phrase is indistinguishable
 * from a wrong phrase and folds into the same null — acceptable, since the
 * retry path is the same and the header itself already parsed cleanly.
 */
export async function openWithPassphrase(
  body: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  passphrase: string,
): Promise<OpenedBundle | null> {
  const key = await derivePassphraseKey(passphrase, salt, iterations)
  return openBody(body, key)
}
