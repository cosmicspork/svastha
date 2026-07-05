// The curation overlay: the system's only mutable state, layered over the
// otherwise append-only event log (see docs/ARCHITECTURE.md, "Event model").
// Tags, notes, hides, and favorite draft templates all live here as
// `CurationRecord`s, LWW-merged and synced through their own `cur-*` blob
// namespace — see docs/ARCHITECTURE.md's "Sync and backup" section for the
// full design (mutable-blob mapping, unsigned-writer rationale, owner-only
// v1 scope).
//
// Like sync.ts and shared.ts, this module never *statically* imports
// session.svelte.ts: Svelte's `$state` rune needs the svelte plugin's
// compile-time transform, which vitest's plain-TS config (see
// vitest.config.ts's comment) doesn't load, so a static import would throw
// at module-evaluation time under test. The one place this module needs the
// live session — stamping `author` on a fresh write — uses a dynamic
// `import()`, exactly like sync.ts's `installEventsHook`. Everything else
// (LWW merge, the sync codec, the pure `writeCuration` core) takes the
// author as an explicit parameter instead, which is also what keeps them
// directly unit-testable.
import { get, put, getAll } from './db'
import { registerCodec, enqueue, drain, type Codec } from './sync'

/** One curation record. Deliberately NOT part of the trust contract (`core`
 * only knows signed, immutable events) and deliberately unsigned: see the
 * module doc comment above and docs/ARCHITECTURE.md for why vault-key
 * possession is an adequate proxy for authorship in today's single-writer
 * vault. */
export interface CurationRecord {
  key: string
  value: unknown
  /** Unix milliseconds — a plain client clock, not a signed timestamp (see
   * `lwwMerge`'s doc comment on the clock-skew tradeoff this implies). */
  updated_at: number
  /** Ed25519 hex of the writer's identity. Purely a merge tiebreaker; never
   * verified against a signature (there is none — see above). */
  author: string
}

// --- LWW merge ---

/**
 * Last-writer-wins merge: higher `updated_at` wins; a tie breaks on the
 * lexicographically greater `author` hex, so every device that sees the same
 * two records picks the same winner without needing a shared clock or a
 * negotiation round trip.
 *
 * Clock-skew note: `updated_at` is each device's own `Date.now()`, not a
 * signed or server-attested timestamp, so a device with a fast clock can make
 * a genuinely older edit "win." This is an accepted tradeoff for a
 * single-writer vault (see docs/ARCHITECTURE.md) — the only way to fool it is
 * to already hold the vault key, at which point LWW correctness is a much
 * smaller problem than the fact that key already grants full read/write.
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

/** The pure, directly-testable write core: caller supplies `author` (and
 * optionally `updatedAt`, for tests) instead of this module reaching into the
 * live session. `setCuration` below is the thin real-session wrapper every
 * app callsite uses — same split as events.ts's builders vs. `logEvent`. */
export async function writeCuration(
  key: string,
  value: unknown,
  author: string,
  updatedAt: number = Date.now(),
): Promise<void> {
  await put('curation', { key, value, updated_at: updatedAt, author } satisfies CurationRecord)
  invalidateBlobIdCache()
  await enqueue([await keyToBlobId(key)])
  void drain()
}

export async function setCuration(key: string, value: unknown): Promise<void> {
  const { session } = await import('./session.svelte')
  const identity = session.identity
  if (!identity) throw new Error('Session is locked — cannot write curation.')
  await writeCuration(key, value, identity.ed25519_public_hex)
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
 * directly in tests — 'cur-' remoteApply needs no wasm/signature verification
 * (see the module doc comment on why curation is unsigned), so unlike the
 * ev- codec there's no reason to only cover it indirectly through
 * enqueue/drain and an e2e run. */
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
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (!isCurationRecord(parsed)) throw new Error(`cur- blob ${id}: malformed curation record`)
    // Mirrors the ev-/doc- codecs' embedded-id check: the AAD binding already
    // stops the relay from swapping ciphertext between blob ids, but this
    // additionally catches a same-device bug (a record ever pushed under the
    // wrong hash) instead of silently misfiling it.
    const expectedId = await keyToBlobId(parsed.key)
    if (expectedId !== id) throw new Error(`cur- blob ${id}: embedded key does not hash to the blob id`)

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
export async function migrateFavoritesToCuration(author: string): Promise<void> {
  if (await get<boolean>('prefs', FAVORITES_MIGRATED_PREF)) return
  const legacy = (await get<LegacyFavorite[]>('prefs', 'favorites')) ?? []
  for (const favorite of legacy) {
    const key = `fav:${favorite.category}:${await sha256Hex(new TextEncoder().encode(favorite.label.toLowerCase()))}`
    if (await getCuration(key)) continue
    await writeCuration(key, favorite, author)
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
  await migrateFavoritesToCuration(identity.ed25519_public_hex)
}
