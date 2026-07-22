// Local, device-only notifications: a small persisted inbox surfaced by the app
// header's bell. Never synced and never sensitive — these are reminders about
// *this* device's state (a pending share invite, a doctor link about to expire,
// an available update), not record content. The relay never sees them.
//
// The wasm/db/source orchestration lives in notification-sources.ts; this module
// stays pure + IndexedDB only (like dictionary.ts, a plain `svelte/store` rather
// than a rune module) so its logic unit-tests under node vitest without loading
// the Svelte compiler or the wasm bundle. Source types are imported `type`-only
// for the same reason — a value import of shared.ts/doctorShare.ts would drag in
// the wasm module those touch.
import { writable, derived, get as getStore } from 'svelte/store'
import { getAll, put, del, clear } from './db'
import { isoToMillis } from './time'
import { fingerprint } from './exchange'
import type { PendingInvite } from './shared'
import type { DoctorShareRecord } from './doctorShare'

const STORE = 'notifications'

/** Keep the inbox bounded: the newest 50. Older items fall off both the store
 * and IndexedDB — an inbox that only grows is a memory leak, and nobody scrolls
 * a hundred stale reminders. */
export const NOTIFICATION_CAP = 50

/** Days-before-expiry that trips the doctor-link reminder. */
export const EXPIRY_THRESHOLD_DAYS = 3

export type NotificationKind =
  | 'share-invite'
  | 'doctor-share-expiring'
  | 'dictionary-update'
  | 'app-update'

export interface Notification {
  /** Caller-supplied, stable per real-world fact so re-derivation is idempotent
   * (never a random id): `addNotification` is a no-op when this id already
   * exists, which is how a source that re-runs every app open avoids dupes. */
  id: string
  kind: NotificationKind
  title: string
  body?: string
  /** ISO instant; drives newest-first order and the cap. */
  createdAt: string
  /** ISO instant it was read, or absent while unread. */
  readAt?: string
  /** Freeform per-kind bag. `action`/`href` drive the sheet's tap-to-navigate. */
  data?: { action?: string; href?: string; [k: string]: unknown }
}

// --- store ---

export const notifications = writable<Notification[]>([])

/** Unread count for the bell badge; hidden at zero by the header. */
export const unreadCount = derived(notifications, (list) => countUnread(list))

// --- pure helpers (unit-tested directly) ---

export function sortNewestFirst(list: Notification[]): Notification[] {
  return [...list].sort((a, b) => isoToMillis(b.createdAt) - isoToMillis(a.createdAt))
}

/** Insert (or replace, by id) then trim to the newest {@link NOTIFICATION_CAP}.
 * Replacing by id keeps the shape total even though `addNotification` guards
 * against re-adds — the dedupe is the invariant, the guard is the fast path. */
export function dedupeAndCap(
  list: Notification[],
  item: Notification,
  cap: number = NOTIFICATION_CAP,
): Notification[] {
  const without = list.filter((n) => n.id !== item.id)
  return sortNewestFirst([item, ...without]).slice(0, cap)
}

export function markReadIn(list: Notification[], id: string, readAtIso: string): Notification[] {
  return list.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: readAtIso } : n))
}

export function countUnread(list: Notification[]): number {
  return list.reduce((n, item) => n + (item.readAt ? 0 : 1), 0)
}

// --- pure source derivations ---

/** One notification per pending share invite, keyed by the inviter's Ed25519
 * key so the same invite never mints two. Body carries the fingerprint the Home
 * banner also shows, so a user can eyeball-match before opening Share. */
export function deriveInviteNotifications(invites: PendingInvite[]): Notification[] {
  return invites.map((invite) => ({
    id: `share-invite:${invite.fromEd}`,
    kind: 'share-invite' as const,
    title: `${invite.label || 'Someone'} shared their vault with you`,
    body: fingerprint(invite.fromEd),
    createdAt: new Date().toISOString(),
    data: { action: 'View', href: '#/share' },
  }))
}

/** Reminders for active doctor links expiring within {@link EXPIRY_THRESHOLD_DAYS}.
 * Pure over the records and a passed-in `now` (millis). The id is keyed by
 * token + threshold, not by the day count, so it fires exactly once as the
 * window closes rather than re-firing (with a new "N days") every app open.
 *
 * Active-ness is re-derived inline rather than importing doctorShare's
 * `shareStatus`: that module pulls in the wasm bundle, which this module must
 * stay clear of to unit-test under node (same duplicate-to-avoid-wasm tradeoff
 * sync.ts/attachments.ts make for sha256). Revocation still wins over expiry. */
export function deriveExpiringShareNotifications(
  shares: DoctorShareRecord[],
  now: number,
): Notification[] {
  const dayMs = 24 * 60 * 60 * 1000
  const horizon = now + EXPIRY_THRESHOLD_DAYS * dayMs
  const out: Notification[] = []
  for (const share of shares) {
    if (share.revokedAt) continue
    const expMs = isoToMillis(share.expiresAt)
    if (expMs <= now || expMs > horizon) continue // already expired, or not close yet
    const days = Math.max(1, Math.ceil((expMs - now) / dayMs))
    const label = share.scopeDescription || 'A shared link'
    out.push({
      id: `doctor-share-expiring:${share.token}:${EXPIRY_THRESHOLD_DAYS}`,
      kind: 'doctor-share-expiring',
      title: `"${label}" expires in ${days} ${days === 1 ? 'day' : 'days'}`,
      createdAt: new Date(now).toISOString(),
      data: { action: 'View', href: '#/share' },
    })
  }
  return out
}

// --- IndexedDB-backed store ops ---

/** Hydrate the store from IndexedDB. Call once on unlock. */
export async function loadNotifications(): Promise<void> {
  const all = await getAll<Notification>(STORE)
  notifications.set(sortNewestFirst(all))
}

/** Add a notification, idempotent by id (a re-derived source never duplicates).
 * Persists the new item and prunes anything that fell past the cap from both the
 * store and IndexedDB. */
export async function addNotification(item: Notification): Promise<void> {
  const current = getStore(notifications)
  if (current.some((n) => n.id === item.id)) return
  const next = dedupeAndCap(current, item)
  notifications.set(next)
  await put(STORE, item)
  const keep = new Set(next.map((n) => n.id))
  for (const n of current) if (!keep.has(n.id)) await del(STORE, n.id)
}

/** Mark one item read (no-op if unknown or already read). */
export async function markRead(id: string): Promise<void> {
  const current = getStore(notifications)
  const target = current.find((n) => n.id === id)
  if (!target || target.readAt) return
  const next = markReadIn(current, id, new Date().toISOString())
  notifications.set(next)
  await put(STORE, next.find((n) => n.id === id)!)
}

/** Drop every notification (store + IndexedDB). Used by lock/teardown. */
export async function clearNotifications(): Promise<void> {
  notifications.set([])
  await clear(STORE)
}

/** The shape a follow-up PWA-update PR calls when a new service worker is
 * waiting — no service-worker wiring here, just the stable entry point. The id
 * is keyed by the version so one waiting build yields one reminder. */
export function notifyAppUpdate(version: string): Promise<void> {
  return addNotification({
    id: `app-update:${version}`,
    kind: 'app-update',
    title: 'A new version of Svastha is ready',
    body: 'Reopen the app to update.',
    createdAt: new Date().toISOString(),
  })
}
