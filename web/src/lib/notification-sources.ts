// Wires the local notification inbox (notifications.ts) to the client-local
// sources that feed it. Kept separate from notifications.ts because these
// imports (doctorShare, dictionary, shared) reach the wasm bundle and the relay
// client, which the pure/unit-tested core must stay clear of. All sources are
// client-local — nothing here talks to the relay beyond the dictionary's own
// same-origin manifest fetch.
import {
  addNotification,
  deriveInviteNotifications,
  deriveProposalNotifications,
  deriveExpiringShareNotifications,
} from './notifications'
import { pendingInvites } from './shared'
import { pendingProposals, refreshPendingProposals } from './proposals'
import { listDoctorShares } from './doctorShare'
import { isEnabled, checkForUpdate } from './dictionary'

/** Fan pending share invites into the inbox and keep them in sync as the list
 * changes. Idempotent by id (see deriveInviteNotifications), so re-emitting the
 * same invite set is a no-op. Returns the unsubscribe for teardown. The Home
 * banner is intentionally left as a second, louder surface for the same fact. */
export function startInviteNotifications(): () => void {
  return pendingInvites.subscribe((invites) => {
    for (const n of deriveInviteNotifications(invites)) void addNotification(n)
  })
}

/** Fan pending proposals into the inbox and keep them current as drafts are
 * worked through. Hydrates the store from IndexedDB first (proposals persist
 * across reloads, unlike the in-memory invite list), then keeps it subscribed.
 * Idempotent by id (see deriveProposalNotifications). Returns the unsubscribe. */
export function startProposalNotifications(): () => void {
  void refreshPendingProposals()
  return pendingProposals.subscribe((records) => {
    for (const n of deriveProposalNotifications(records)) void addNotification(n)
  })
}

/** One-shot scan on app open (unlocked): doctor links about to expire, plus a
 * dictionary-update check when the feature is on and the device is online. Each
 * source is guarded on its own so one failing never starves the other, and the
 * dictionary check swallows network errors — offline is the normal case, not a
 * notification-worthy event. */
export async function scanForNotifications(): Promise<void> {
  try {
    const shares = await listDoctorShares()
    for (const n of deriveExpiringShareNotifications(shares, Date.now())) {
      await addNotification(n)
    }
  } catch (err) {
    console.warn('notification scan (doctor shares) failed:', err)
  }

  try {
    if (navigator.onLine && (await isEnabled())) {
      const check = await checkForUpdate()
      if (check.updateAvailable) {
        await addNotification({
          id: `dictionary-update:${check.latest}`,
          kind: 'dictionary-update',
          title: 'A code dictionary update is available',
          body: `Version ${check.latest}`,
          createdAt: new Date().toISOString(),
          data: { action: 'Update', href: '#/settings' },
        })
      }
    }
  } catch {
    // Offline (or a manifest hiccup) is expected and silent — a dictionary
    // update is a nicety, never worth surfacing a failure over.
  }
}
