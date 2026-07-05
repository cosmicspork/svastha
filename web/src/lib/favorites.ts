// Starred quick-log combos, now backed by the curation overlay's
// `fav:{category}:{hash}` records (see curation.ts) instead of a single
// device-local `prefs` key — favorites are still device-chosen UI shortcuts,
// not clinical facts, but there is no reason they shouldn't follow the
// person to a second device the same way tags and notes do. A one-time
// migration (`ensureFavoritesMigrated`, called lazily before every read or
// write below) carries over anything favorited before this change; the old
// `prefs` key is left in place afterward as harmless dead data (see
// curation.ts's `migrateFavoritesToCuration` doc comment).
import type { Category } from './category'
import type { DraftTemplate } from './drafts'
import { getCuration, setCuration, allCurationByPrefix, sha256Hex, ensureFavoritesMigrated } from './curation'

export interface Favorite {
  label: string
  category: Category
  /** Timestamp-free drafts; stamped with `effective_at` at log time. */
  drafts: DraftTemplate[]
}

/** The curation value for a `fav:` key: a live favorite, or a tombstone left
 * by `removeFavorite` (LWW-merged like everything else in curation, so
 * "removed" has to be a value, not a delete — there is no delete). */
type FavoriteValue = Favorite | { removed: true }

/** Per category — a favorites row longer than this stops being "favorites". */
const MAX_PER_CATEGORY = 12

async function favoriteKey(category: Category, label: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(label.toLowerCase()))
  return `fav:${category}:${hash}`
}

export async function listFavorites(category: Category): Promise<Favorite[]> {
  await ensureFavoritesMigrated()
  const records = await allCurationByPrefix(`fav:${category}:`)
  return records
    .filter((r) => !('removed' in (r.value as FavoriteValue)))
    .sort((a, b) => a.updated_at - b.updated_at) // oldest-favorited first, same order as the old array
    .map((r) => r.value as Favorite)
}

/** Add a favorite (idempotent on label within a category); drops the oldest
 * when the category is at cap. */
export async function addFavorite(favorite: Favorite): Promise<void> {
  await ensureFavoritesMigrated()
  const key = await favoriteKey(favorite.category, favorite.label)
  if (await getCuration(key)) return // already favorited (including a migrated-in one)

  const existing = await listFavorites(favorite.category)
  if (existing.length >= MAX_PER_CATEGORY) {
    await removeFavorite(favorite.category, existing[0].label)
  }
  await setCuration(key, favorite)
}

export async function removeFavorite(category: Category, label: string): Promise<void> {
  const key = await favoriteKey(category, label)
  if (!(await getCuration(key))) return
  await setCuration(key, { removed: true })
}
