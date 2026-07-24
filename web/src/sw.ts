// The service worker. Switched from `vite-plugin-pwa`'s auto-generated
// `generateSW` build to the `injectManifest` strategy specifically to add Web
// Push handling below (see docs/ARCHITECTURE.md's "Web Push",
// spec/README.md's "Web Push" subsection, and PR feat/web-push-client).
// `self.__WB_MANIFEST` is replaced at build time with the same precache list
// `generateSW` used to compute from vite.config.ts's `injectManifest` options
// (`globPatterns`/`globIgnores` carried over unchanged).
//
// `registerType` stays `'prompt'` (see main.ts's comment on `registerSW`): a
// waiting worker must never activate on its own, so this file deliberately
// does NOT call `self.skipWaiting()` on install or `self.clients.claim()` on
// activate — either would silently swap the running bundle out from under an
// open tab. Instead it waits for the page's own "Relaunch now" action
// (pwaUpdate.ts) to post the standard `SKIP_WAITING` message below. That
// message listener, and precaching itself, are the only two things
// `generateSW` used to provide automatically that a custom worker source must
// now supply by hand — everything else (routing, offline shell) is unchanged.
import { precacheAndRoute } from 'workbox-precaching'
import type { PrecacheEntry } from 'workbox-precaching/_types'
import { NOTIFICATION_TITLE, NOTIFICATION_BODY, NOTIFICATION_TAG, focusOrOpen } from './lib/push-sw'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> }

precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') self.skipWaiting()
})

// --- Web Push ---
//
// The relay's push is payload-free by construction, and this worker cannot
// decrypt vault content anyway (the vault's keys are sealed at rest while
// locked, which is the only state a service worker ever runs in) — so every
// push shows the exact same generic, neutral notification. See push-sw.ts's
// doc comment for why that copy is final, not a placeholder.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification(NOTIFICATION_TITLE, {
      body: NOTIFICATION_BODY,
      tag: NOTIFICATION_TAG,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(focusOrOpen(self.clients))
})

// Subscriptions rot — the browser or OS can drop one without the app ever
// being open to notice. Best-effort re-subscribe with the same
// applicationServerKey; this worker holds no relay identity or signing key
// (it never holds any key material at all), so it cannot PUT the result to
// the relay itself. The next app open reconciles it: push.ts's
// `reassertPushOnStart` reads whatever `pushManager.getSubscription()` now
// returns and re-registers it.
self.addEventListener('pushsubscriptionchange', (event) => {
  const evt = event as ExtendableEvent & {
    oldSubscription: PushSubscription | null
    newSubscription: PushSubscription | null
  }
  const applicationServerKey = evt.oldSubscription?.options.applicationServerKey
  if (!applicationServerKey) return
  evt.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey })
      .catch(() => {
        // Best-effort: permission revoked or the key unavailable — the
        // setting stays "on" locally, and an explicit re-enable in Settings
        // (or the user granting permission again) recovers it.
      }),
  )
})
