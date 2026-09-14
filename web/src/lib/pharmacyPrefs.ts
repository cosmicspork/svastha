// The pharmacy list's text size, remembered across visits: someone who reads
// the list across a counter needs Counter every time, not once. Stored in the
// same `prefs` store as the theme (see theme.ts), device-local and never shared.
import { get, put } from './db'

export type ListSize = 'standard' | 'counter'

export const LIST_SIZE_PREF = 'pharmacy-list-size'

const SIZES: readonly ListSize[] = ['standard', 'counter']

/** Whether a stored value is one this app wrote. A `prefs` store survives app
 * versions, so an unknown value is a real possibility (an older or newer
 * build, a hand-edited database) and must not reach the DOM as a `data-size`
 * nobody styles — the list would render at neither size. */
export function isListSize(value: unknown): value is ListSize {
  return typeof value === 'string' && (SIZES as readonly string[]).includes(value)
}

export async function loadListSize(): Promise<ListSize> {
  const stored = await get<unknown>('prefs', LIST_SIZE_PREF)
  return isListSize(stored) ? stored : 'standard'
}

export async function setListSize(size: ListSize): Promise<void> {
  await put('prefs', size, LIST_SIZE_PREF)
}
