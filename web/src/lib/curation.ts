// The curation overlay: the system's only mutable state, layered over the
// otherwise append-only event log (see docs/ARCHITECTURE.md, "Event model").
// Tags, notes, hides, favorite draft templates, and the concept-level
// `status:`/`name:`/`regimen:` overrides all live here as signed curation records,
// LWW-merged and synced through their own `cur-*` blob namespace — see
// docs/ARCHITECTURE.md's "Curation overlay" section for the full design
// (mutable-blob mapping, the signing rationale, owner-only v1 scope).
//
// The record type, its canonical serialization, signing, verification, and the
// merge rule are the trust contract's (`crates/core`, `curation.rs`), reached
// through wasm: a fresh write is signed by the same owner identity that signs
// events (`identity.sign_curation`), and a record pulled from outside the local
// store is verified-or-dropped (`verify_curation`). This module owns only the
// app-level conventions: the key namespaces, the mutable `cur-*` blob mapping,
// on-device storage, and the sync scope.
//
// Like sync.ts and shared.ts, this module never *statically* imports
// session.svelte.ts: Svelte's `$state` rune needs the svelte plugin's
// compile-time transform, which vitest's plain-TS config (see
// vitest.config.ts's comment) doesn't load, so a static import would throw
// at module-evaluation time under test. The one place this module needs the
// live session — obtaining the signer for a fresh write — uses a dynamic
// `import()`, exactly like sync.ts's `installEventsHook`. Everything else
// (LWW merge, the sync codec, the pure `writeCuration`/`migrate*` cores) takes
// the signer as an explicit parameter instead, which is what keeps them
// directly unit-testable.
import { get, put, getAll } from './db'
import { registerCodec, enqueue, drain, type Codec } from './sync'
import { verify_curation, type WasmIdentity } from './svastha'

/** One curation record body — the fields the author signs plus `author`. Mirrors
 * `core`'s `CurationRecord`; a stored/synced record additionally carries a
 * `signature` (see {@link SignedCurationRecord}). */
export interface CurationRecord {
  key: string
  value: unknown
  /** Unix milliseconds — a plain client clock, not a signed timestamp (see
   * `lwwMerge`'s doc comment on the clock-skew tradeoff this implies). */
  updated_at: number
  /** Ed25519 hex of the writer's identity. Both the merge tiebreaker and the
   * key the `signature` verifies against. */
  author: string
}

/** A `CurationRecord` with the owner identity's Ed25519 signature over its
 * canonical bytes (`core`'s `SignedCurationRecord`, flat wire shape). Every
 * fresh write produces one; a record still lacking `signature` is a
 * grandfathered pre-signing write (accepted, and re-signed on its next local
 * write — see the migration below). */
export interface SignedCurationRecord extends CurationRecord {
  signature: string
}

/** Produces a signed record from a curation write. The real one wraps the
 * session identity's `sign_curation` wasm binding ({@link signerFor}); tests
 * inject a stub so the pure write/migration cores stay wasm-free. */
export type CurationSigner = (key: string, value: unknown, updatedAt: number) => SignedCurationRecord

/** The signer backed by an unlocked identity: `author` and the signature are
 * stamped by `core` (via wasm), exactly as `sign_event` stamps an event's id. */
export function signerFor(identity: WasmIdentity): CurationSigner {
  return (key, value, updated_at) =>
    JSON.parse(identity.sign_curation(JSON.stringify({ key, value, updated_at }))) as SignedCurationRecord
}

// --- LWW merge ---

/**
 * Last-writer-wins merge: higher `updated_at` wins; a tie breaks on the
 * lexicographically greater `author` hex, so every device that sees the same
 * two records picks the same winner without needing a shared clock or a
 * negotiation round trip.
 *
 * A pure tiebreak — it does NOT verify signatures. Callers verify-or-drop
 * first (see `curationCodec.remoteApply`), exactly as `core`'s `merge` does;
 * this is the TS twin of that function, kept local so it can also merge a
 * grandfathered unsigned record (which `merge_curation`'s wasm binding, needing
 * a `signature`, cannot) during the transition. `curation.test.ts` pins it
 * against `core`-signed fixtures so the two can't drift.
 *
 * Clock-skew note: `updated_at` is each device's own `Date.now()`, not a
 * signed or server-attested timestamp, so a device with a fast clock can make
 * a genuinely older edit "win." This is an accepted tradeoff (see
 * docs/ARCHITECTURE.md) — the only way to fool it is to already hold the vault
 * key, at which point LWW correctness is a much smaller problem than the fact
 * that key already grants full read/write.
 */
export function lwwMerge(
  local: CurationRecord | undefined,
  remote: CurationRecord,
): CurationRecord {
  if (!local) return remote
  if (remote.updated_at !== local.updated_at) {
    return remote.updated_at > local.updated_at ? remote : local
  }
  return remote.author > local.author ? remote : local
}

// --- key <-> blob id ---

/** Exported for callers (favorites.ts) that mint their own curation keys from
 * arbitrary strings (a favorite's label). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function curationBlobId(hashHex: string): string {
  return `cur-${hashHex}`
}

async function keyToBlobId(key: string): Promise<string> {
  return curationBlobId(await sha256Hex(new TextEncoder().encode(key)))
}

/** The `cur-` blob id for a curation key — exported so sync.ts's
 * `listLocalBlobIds` can enumerate curation blobs without duplicating the
 * key-hashing logic (it can't reach the module-private `keyToBlobId`). */
export function curationBlobIdForKey(key: string): Promise<string> {
  return keyToBlobId(key)
}

/**
 * Reverse map (blob id -> curation key). There is no second index store for
 * this — curation records top out in the hundreds even for a heavily-tagged,
 * years-long log (tags/notes/hides/favorites for one person), so hashing
 * every local key once and caching the map in memory is cheaper and simpler
 * than maintaining a second store that could drift from the primary one.
 * Rebuilt on a cache miss (covers a key written after the cache was built)
 * and invalidated on every local write.
 */
let blobIdCache: Map<string, string> | null = null // blobId -> key

async function buildBlobIdCache(): Promise<Map<string, string>> {
  const all = await getAll<CurationRecord>('curation')
  const map = new Map<string, string>()
  for (const record of all) {
    map.set(await keyToBlobId(record.key), record.key)
  }
  return map
}

async function keyForBlobId(blobId: string): Promise<string | null> {
  blobIdCache ??= await buildBlobIdCache()
  if (blobIdCache.has(blobId)) return blobIdCache.get(blobId)!
  blobIdCache = await buildBlobIdCache() // miss — maybe written since the last build
  return blobIdCache.get(blobId) ?? null
}

function invalidateBlobIdCache(): void {
  blobIdCache = null
}

// --- reads/writes ---

export function getCuration(key: string): Promise<CurationRecord | undefined> {
  return get<CurationRecord>('curation', key)
}

/** The pure, directly-testable write core: caller supplies the `sign` function
 * (and optionally `updatedAt`, for tests) instead of this module reaching into
 * the live session. `setCuration` below is the thin real-session wrapper every
 * app callsite uses — same split as events.ts's builders vs. `logEvent`. */
export async function writeCuration(
  key: string,
  value: unknown,
  sign: CurationSigner,
  updatedAt: number = Date.now(),
): Promise<void> {
  await put('curation', sign(key, value, updatedAt))
  invalidateBlobIdCache()
  await enqueue([await keyToBlobId(key)])
  void drain()
}

export async function setCuration(key: string, value: unknown): Promise<void> {
  const { session } = await import('./session.svelte')
  const identity = session.identity
  if (!identity) throw new Error('Session is locked — cannot write curation.')
  await writeCuration(key, value, signerFor(identity))
}

export async function allCurationByPrefix(prefix: string): Promise<CurationRecord[]> {
  const all = await getAll<CurationRecord>('curation')
  return all.filter((r) => r.key.startsWith(prefix))
}

// --- sync codec ('cur-') ---

function isCurationRecord(value: unknown): value is CurationRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.key === 'string' && typeof v.updated_at === 'number' && typeof v.author === 'string'
}

/** Exported (unlike sync.ts's own ev-/doc- codecs) so it can be exercised
 * directly in tests. `remoteApply` now verifies a signed record's signature
 * through wasm (`verify_curation`) — tests that reach that branch mock
 * `./svastha`, the way doctorShare.test.ts does. */
export const curationCodec: Codec = {
  prefix: 'cur-',
  // The one namespace where the same blob id is legitimately overwritten
  // with new content (a later tag/hide/note/favorite write) — see
  // `Codec.mutable`'s doc comment in sync.ts. Without this, a device that
  // already pushed or pulled a `cur-` id once would never look at it again,
  // and two devices editing the same curation key would never converge.
  mutable: true,
  async localHas(id) {
    return (await keyForBlobId(id)) !== null
  },
  async localLoad(id) {
    const key = await keyForBlobId(id)
    if (!key) return null
    const record = await get<CurationRecord>('curation', key)
    return record ? new TextEncoder().encode(JSON.stringify(record)) : null
  },
  async remoteApply(id, plaintext) {
    const text = new TextDecoder().decode(plaintext)
    const parsed: unknown = JSON.parse(text)
    if (!isCurationRecord(parsed)) throw new Error(`cur- blob ${id}: malformed curation record`)
    // Mirrors the ev-/doc- codecs' embedded-id check: the AAD binding already
    // stops the relay from swapping ciphertext between blob ids, but this
    // additionally catches a same-device bug (a record ever pushed under the
    // wrong hash) instead of silently misfiling it.
    const expectedId = await keyToBlobId(parsed.key)
    if (expectedId !== id) throw new Error(`cur- blob ${id}: embedded key does not hash to the blob id`)

    // Verify-or-drop: a record bearing a signature that fails verification is
    // corrupt or adversarial (the point of signing — a share recipient or a
    // second writer can't be sure the AEAD seal was made by the author), so
    // drop it quietly rather than throw (throwing would just retry the same bad
    // blob every pull). A record with no `signature` predates signing and is
    // grandfathered through — accepted by LWW and re-signed on its next local
    // write. See docs/ARCHITECTURE.md, "Curation overlay".
    if ((parsed as Partial<SignedCurationRecord>).signature !== undefined) {
      let verified = false
      try {
        verified = verify_curation(text)
      } catch {
        verified = false
      }
      if (!verified) {
        console.warn(`cur- blob ${id}: signature does not verify — dropping`)
        return
      }
    }

    const local = await get<CurationRecord>('curation', parsed.key)
    const winner = lwwMerge(local, parsed)
    await put('curation', winner)
    invalidateBlobIdCache()

    if (winner !== parsed) {
      // The remote record lost the merge (our local edit is newer, or tied
      // and lexicographically ahead) — re-enqueue our own key so the next
      // drain pushes the winner back to the relay. Without this the relay
      // would keep serving the losing value forever, and a third device
      // pulling fresh would adopt it instead of converging on the real
      // winner.
      await enqueue([await keyToBlobId(winner.key)])
      void drain()
    }
  },
}
registerCodec(curationCodec)

// --- helpers: tags / hide / note ---

export async function tagsOf(eventId: string): Promise<string[]> {
  const record = await getCuration(`tag:${eventId}`)
  return (record?.value as { tags?: string[] } | undefined)?.tags ?? []
}

export async function setTags(eventId: string, tags: string[]): Promise<void> {
  await setCuration(`tag:${eventId}`, { tags })
}

export async function isHidden(eventId: string): Promise<boolean> {
  const record = await getCuration(`hide:${eventId}`)
  return (record?.value as { hidden?: boolean } | undefined)?.hidden === true
}

export async function setHidden(eventId: string, hidden: boolean): Promise<void> {
  await setCuration(`hide:${eventId}`, { hidden })
}

export async function noteOf(eventId: string): Promise<string> {
  const record = await getCuration(`note:${eventId}`)
  return (record?.value as { text?: string } | undefined)?.text ?? ''
}

export async function setNote(eventId: string, text: string): Promise<void> {
  await setCuration(`note:${eventId}`, { text })
}

/** Distinct tags across every `tag:` record — the filter-chip and
 * TagEditor-suggestion source. */
export async function allTags(): Promise<string[]> {
  const records = await allCurationByPrefix('tag:')
  const tags = new Set<string>()
  for (const record of records) {
    for (const tag of (record.value as { tags?: string[] } | undefined)?.tags ?? []) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}

// --- helpers: concept status / name / regimen ---
//
// Unlike tag/note/hide (keyed on an `event_id`), these curate a *folded
// clinical concept* — every event sharing a `${kind}|${system}|${code}` (the
// summary's `keyFor`). `status:` marks the concept current/past (meds) or
// active/resolved (problems); `name:` is the owner's display-name override,
// the highest-priority layer of the render-time name chain (see
// code-names.ts); `regimen:` carries how a medication is actually taken
// (schedule, route, prescriber, course dates, instructions) — facts no
// imported `medication_statement` event holds. None of them touches a signed
// event: all three are curation, resolved at render time exactly like a
// borrowed display.

/** A folded concept's curated lifecycle. `'active'` (the unstatused default)
 * renders as "current" for meds / "active" for problems; `'inactive'` as
 * "past" / "resolved". */
export type ConceptStatus = 'active' | 'inactive'

export async function getStatus(conceptKey: string): Promise<ConceptStatus | undefined> {
  const record = await getCuration(`status:${conceptKey}`)
  return (record?.value as { status?: ConceptStatus } | undefined)?.status
}

export async function setStatus(conceptKey: string, status: ConceptStatus): Promise<void> {
  await setCuration(`status:${conceptKey}`, { status })
}

/** The owner's display-name override for a concept, or `''` when there is
 * none. A cleared override is stored as `{ display: '' }` (an empty display),
 * not deleted — the sync model has no delete (see favorites.ts), and an empty
 * display naturally means "no override, fall through to the next name layer". */
export async function getName(conceptKey: string): Promise<string> {
  const record = await getCuration(`name:${conceptKey}`)
  return ((record?.value as { display?: string } | undefined)?.display ?? '').trim()
}

export async function setName(conceptKey: string, display: string): Promise<void> {
  await setCuration(`name:${conceptKey}`, { display: display.trim() })
}

/** Build the concept -> status map from a set of curation records: reads the
 * `status:` records, keying on the bare `${kind}|${system}|${code}`. Pure over
 * an in-memory record list, so the same reduction serves both {@link
 * allStatuses} (the local store) and a doctor-share recipient folding the
 * verified `status:` records carried in a bundle. Non-`status:` records are
 * skipped, so a mixed array (status + name) is fine to pass. */
export function statusMapFrom(records: CurationRecord[]): Map<string, ConceptStatus> {
  const map = new Map<string, ConceptStatus>()
  for (const r of records) {
    if (!r.key.startsWith('status:')) continue
    const status = (r.value as { status?: ConceptStatus } | undefined)?.status
    if (status) map.set(r.key.slice('status:'.length), status)
  }
  return map
}

/** Build the concept -> display-name override map from a set of curation
 * records (the `name:` ones). Empty overrides (a cleared name) are dropped, so
 * a caller sees only real overrides. The pure analogue of {@link allNames}, and
 * likewise tolerant of a mixed (status + name) array. */
export function nameMapFrom(records: CurationRecord[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of records) {
    if (!r.key.startsWith('name:')) continue
    const display = ((r.value as { display?: string } | undefined)?.display ?? '').trim()
    if (display) map.set(r.key.slice('name:'.length), display)
  }
  return map
}

/** Concept -> status, for the whole summary (see summary.ts's `buildSummary`,
 * which takes this map). Keyed on the bare `${kind}|${system}|${code}`, the
 * `status:` prefix stripped. */
export async function allStatuses(): Promise<Map<string, ConceptStatus>> {
  return statusMapFrom(await allCurationByPrefix('status:'))
}

/** Concept -> display-name override. Empty overrides (a cleared name) are
 * dropped, so a caller sees only real overrides. */
export async function allNames(): Promise<Map<string, string>> {
  return nameMapFrom(await allCurationByPrefix('name:'))
}

/** The routes a medication can be filed under. A closed set (rather than free
 * text) because it is what the medications page shelves on, and a shelf per
 * spelling of "by mouth" is not a shelf. */
export const REGIMEN_ROUTES = ['mouth', 'nose', 'eyes', 'skin', 'inhaled', 'injection', 'other'] as const

export type RegimenRoute = (typeof REGIMEN_ROUTES)[number]

export const REGIMEN_ROUTE_LABELS: Record<RegimenRoute, string> = {
  mouth: 'By mouth',
  nose: 'Nose',
  eyes: 'Eyes',
  skin: 'Skin',
  inhaled: 'Inhaled',
  injection: 'Injection',
  other: 'Other',
}

/** How a medication concept is actually taken — the facts an imported
 * `medication_statement` does not carry. Every field is optional and honest
 * free text apart from `route` (a closed set) and the dates: nothing here is
 * parsed, inferred, or defaulted, so an empty field means "not recorded", never
 * "none". */
export interface Regimen {
  dose?: string
  schedule?: string
  route?: RegimenRoute
  as_needed?: boolean
  prescriber?: string
  /** ISO `YYYY-MM-DD`. */
  started?: string
  /** ISO `YYYY-MM-DD`. */
  stopped?: string
  instructions?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** ISO `YYYY-MM-DD` *and* a real calendar date: the round trip rejects
 * `2026-13-99` and `2026-02-31`, which the shape alone accepts. A date that
 * cannot exist is not a course date, and silently keeping one would put it on
 * the summary as if it were. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Tolerant shape-check on read, shared by every path that turns a stored or
 * bundle-supplied `regimen:` value into a {@link Regimen}: unknown or
 * wrong-typed fields are dropped, not repaired, and the whole value normalizes
 * to `undefined` when nothing survives.
 *
 * Never throws. The same value can arrive from a second device running a newer
 * build or (later) from a doctor-share bundle, so garbage has to normalize away
 * rather than crash a render — the tolerance `isCurationRecord` and
 * `nameMapFrom` already apply at their own layers.
 *
 * `undefined` for the all-empty value is also the clearing convention: clearing
 * a regimen writes an empty object (the sync model has no delete — see
 * `setName`), and reducers drop it here.
 */
export function normalizeRegimen(value: unknown): Regimen | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const regimen: Regimen = {}

  const dose = trimmedString(v.dose)
  if (dose) regimen.dose = dose
  const schedule = trimmedString(v.schedule)
  if (schedule) regimen.schedule = schedule
  const route = trimmedString(v.route)
  if (route && (REGIMEN_ROUTES as readonly string[]).includes(route)) {
    regimen.route = route as RegimenRoute
  }
  if (v.as_needed === true) regimen.as_needed = true
  const prescriber = trimmedString(v.prescriber)
  if (prescriber) regimen.prescriber = prescriber
  const started = trimmedString(v.started)
  if (started && isCalendarDate(started)) regimen.started = started
  const stopped = trimmedString(v.stopped)
  if (stopped && isCalendarDate(stopped)) regimen.stopped = stopped
  const instructions = trimmedString(v.instructions)
  if (instructions) regimen.instructions = instructions

  return Object.keys(regimen).length === 0 ? undefined : regimen
}

const REGIMEN_FIELDS = [
  'dose',
  'schedule',
  'route',
  'as_needed',
  'prescriber',
  'started',
  'stopped',
  'instructions',
] as const

/**
 * Whether two regimens differ once normalized — the diff-before-write test the
 * edit sheet applies before calling {@link setRegimen}.
 *
 * Without it, saving the sheet for an unrelated reason (a rename, a typo fixed
 * and un-fixed) would mint a fresh LWW record with a new `updated_at` on every
 * medication the owner ever opened: a mutable `cur-` blob re-pushed to the
 * relay and re-merged on every other device, for no change at all.
 */
export function regimenChanged(before: Regimen | undefined, after: Regimen | undefined): boolean {
  const a = normalizeRegimen(before)
  const b = normalizeRegimen(after)
  if (!a || !b) return a !== b
  return REGIMEN_FIELDS.some((field) => a[field] !== b[field])
}

/** The owner's regimen for a concept, or `undefined` when there is none (or
 * what is stored no longer normalizes to anything). */
export async function getRegimen(conceptKey: string): Promise<Regimen | undefined> {
  const record = await getCuration(`regimen:${conceptKey}`)
  return normalizeRegimen(record?.value)
}

/** Writes the normalized value, so the stored record never carries untrimmed
 * text or a field the readers would drop anyway. An all-empty regimen is
 * stored as `{}` — the clear (see {@link normalizeRegimen}). */
export async function setRegimen(conceptKey: string, regimen: Regimen): Promise<void> {
  await setCuration(`regimen:${conceptKey}`, normalizeRegimen(regimen) ?? {})
}

/** Build the concept -> regimen map from a set of curation records (the
 * `regimen:` ones). Cleared and unsalvageable values are dropped, so a caller
 * sees only real regimens. The pure analogue of {@link allRegimens} — same
 * split as {@link statusMapFrom}/{@link nameMapFrom}, and likewise tolerant of
 * a mixed-namespace array. */
export function regimenMapFrom(records: CurationRecord[]): Map<string, Regimen> {
  const map = new Map<string, Regimen>()
  for (const r of records) {
    if (!r.key.startsWith('regimen:')) continue
    const regimen = normalizeRegimen(r.value)
    if (regimen) map.set(r.key.slice('regimen:'.length), regimen)
  }
  return map
}

/** Concept -> regimen, for the whole summary (see summary.ts's `buildSummary`,
 * which takes this map). */
export async function allRegimens(): Promise<Map<string, Regimen>> {
  return regimenMapFrom(await allCurationByPrefix('regimen:'))
}

// --- favorites migration ---

const FAVORITES_MIGRATED_PREF = 'favorites-migrated-to-curation'

/** Legacy shape of a favorite, as it lived under the single `prefs` key
 * before this migration (see favorites.ts's pre-migration history). Declared
 * locally rather than imported from favorites.ts to avoid a cycle (favorites.ts
 * imports this module for its curation-backed storage). */
interface LegacyFavorite {
  label: string
  category: string
  drafts: unknown[]
}

/** One-time copy of the legacy prefs-based favorites into curation `fav:`
 * records, so favorites sync across devices like everything else in this
 * module. Pure core (author injected) so it's directly testable; the old
 * prefs key (`favorites`) is deliberately left untouched afterward — it
 * becomes dead data once curation is authoritative, but deleting it buys
 * nothing and risks a data-loss bug for zero benefit. Idempotent both via the
 * prefs marker and via a per-favorite existence check, so re-running it (e.g.
 * a second device that already synced the same favorites via `cur-`) never
 * duplicates or clobbers anything. */
export async function migrateFavoritesToCuration(sign: CurationSigner): Promise<void> {
  if (await get<boolean>('prefs', FAVORITES_MIGRATED_PREF)) return
  const legacy = (await get<LegacyFavorite[]>('prefs', 'favorites')) ?? []
  for (const favorite of legacy) {
    const key = `fav:${favorite.category}:${await sha256Hex(new TextEncoder().encode(favorite.label.toLowerCase()))}`
    if (await getCuration(key)) continue
    await writeCuration(key, favorite, sign)
  }
  await put('prefs', true, FAVORITES_MIGRATED_PREF)
}

/** Real-session wrapper — called lazily by favorites.ts before every read or
 * write, same pattern as `setCuration` vs. `writeCuration`. A no-op (and
 * retried on the next call) while locked. */
export async function ensureFavoritesMigrated(): Promise<void> {
  const { session } = await import('./session.svelte')
  const identity = session.identity
  if (!identity) return
  await migrateFavoritesToCuration(signerFor(identity))
}

// --- signing migration (one-time, on first unlock after this version) ---

const CURATION_SIGNED_PREF = 'curation-signed-migrated'

/** Re-sign every local pre-signing curation record IN PLACE. `core`'s
 * `sign_curation` stamps `author` from the identity, so this only signs a
 * record the owner already authored (`author === owner`) — its content
 * (`key`/`value`/`updated_at`/`author`) is then *identical*, gaining only a
 * `signature`. Preserving `updated_at` and `author` is what makes the
 * migration LWW-safe: when the re-signed blob is re-pushed over its existing
 * `cur-` id, a concurrent device sees an exact merge tie (same `updated_at`,
 * same `author`), so the migration can never override a genuinely newer edit
 * made on another device, nor be seen as one. A record authored elsewhere
 * (a foreign unsigned record pulled mid-transition) is left alone —
 * grandfathered, and legitimately re-authored on its next local write.
 *
 * Pure core (signer injected) so it's directly testable; idempotent via both
 * the prefs marker and the per-record `signature` check, so a second unlock —
 * or a second device that already synced the signed records — is a no-op. */
export async function migrateCurationToSigned(sign: CurationSigner, owner: string): Promise<void> {
  if (await get<boolean>('prefs', CURATION_SIGNED_PREF)) return
  const all = await getAll<SignedCurationRecord>('curation')
  let resigned = false
  for (const record of all) {
    if (record.signature !== undefined) continue
    if (record.author !== owner) continue // foreign unsigned — grandfathered
    await put('curation', sign(record.key, record.value, record.updated_at))
    await enqueue([await keyToBlobId(record.key)])
    resigned = true
  }
  if (resigned) {
    invalidateBlobIdCache()
    void drain()
  }
  await put('prefs', true, CURATION_SIGNED_PREF)
}

/** Real-session wrapper — run once whenever a session unlocks (App.svelte's
 * sync effect). A no-op (retried next unlock) while locked. */
export async function ensureCurationSigned(): Promise<void> {
  const { session } = await import('./session.svelte')
  const identity = session.identity
  if (!identity) return
  await migrateCurationToSigned(signerFor(identity), identity.ed25519_public_hex)
}
