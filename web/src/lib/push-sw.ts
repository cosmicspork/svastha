// The pure pieces of the service worker's Web Push handling, factored out of
// `sw.ts` so they unit-test without a `ServiceWorkerGlobalScope` (mirrors
// events-stream.ts's split: the parser/reconnect logic lives in a plain
// module, the browser wiring is a thin caller). See docs/ARCHITECTURE.md's
// "Web Push" and spec/README.md's "Web Push" subsection.
//
// **The copy below is the entire content of every push notification, ever.**
// The relay's push is payload-free by construction (a constant marker,
// encrypted, carrying no blob id/count/owner), and this worker cannot decrypt
// vault content anyway — the vault's keys are sealed at rest while locked, and
// a locked vault is the only state a service worker ever sees. So this is not
// a placeholder pending a richer implementation: it is the correct, final
// notification. Never change it to include a count, a category, a sender, or
// any other record-derived detail.

export const NOTIFICATION_TITLE = 'Svastha'
export const NOTIFICATION_BODY = 'Something new is waiting for you.'

/** A fixed tag collapses repeat pushes into one notification client-side too
 * — the relay already debounces server-side within its collapse window (see
 * spec/README.md's "Web Push"), so this is a second, independent layer for
 * whatever slips through (e.g. a push arriving just after the previous one
 * was dismissed, which restarts the window). */
export const NOTIFICATION_TAG = 'svastha-poke'

export interface FocusableClient {
  url?: string
  focus(): Promise<unknown> | unknown
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly FocusableClient[]>
  openWindow?: (url: string) => Promise<unknown>
}

/**
 * `notificationclick`: focus an already-open app window, or open one. The
 * app's existing on-focus/visibility pull (sync.ts's `visibilitychange`
 * handler, and `pullAll` on unlock) does the rest from there — this
 * deliberately plumbs no data of its own, matching the notification's own
 * payload-free content.
 */
export async function focusOrOpen(clients: ClientsLike): Promise<void> {
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of list) {
    if (typeof client.focus === 'function') {
      await client.focus()
      return
    }
  }
  await clients.openWindow?.('/')
}
