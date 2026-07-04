// Starred quick-log combos, stored under one prefs key. Plain prefs data (not
// events): favorites are device-local UI state, not clinical facts, so they
// stay out of the signed log.
import { get, put } from './db'
import type { Category } from './category'
import type { DraftTemplate } from './drafts'

export interface Favorite {
  label: string
  category: Category
  /** Timestamp-free drafts; stamped with `effective_at` at log time. */
  drafts: DraftTemplate[]
}

const PREFS_KEY = 'favorites'
/** Per category — a favorites row longer than this stops being "favorites". */
const MAX_PER_CATEGORY = 12

export async function listFavorites(category: Category): Promise<Favorite[]> {
  const all = (await get<Favorite[]>('prefs', PREFS_KEY)) ?? []
  return all.filter((f) => f.category === category)
}

/** Add a favorite (idempotent on label within a category); drops the oldest
 * when the category is at cap. */
export async function addFavorite(favorite: Favorite): Promise<void> {
  const all = (await get<Favorite[]>('prefs', PREFS_KEY)) ?? []
  if (all.some((f) => f.category === favorite.category && f.label === favorite.label)) return

  const inCategory = all.filter((f) => f.category === favorite.category)
  const others = all.filter((f) => f.category !== favorite.category)
  const kept = inCategory.slice(Math.max(0, inCategory.length + 1 - MAX_PER_CATEGORY))
  await put('prefs', [...others, ...kept, favorite], PREFS_KEY)
}

export async function removeFavorite(category: Category, label: string): Promise<void> {
  const all = (await get<Favorite[]>('prefs', PREFS_KEY)) ?? []
  await put(
    'prefs',
    all.filter((f) => !(f.category === category && f.label === label)),
    PREFS_KEY,
  )
}
