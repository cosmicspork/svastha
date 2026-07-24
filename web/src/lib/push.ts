// Web Push registration/enable/disable/re-assert — the client half of
// docs/ARCHITECTURE.md's "Web Push" (spec/README.md's "Web Push" subsection).
// Mirrors sync.ts's injected-boundary style (its `BlobClient`/`SealKey`): the
// browser's `PushManager` and the relay client are passed in as narrow
// structural interfaces, so this whole state machine unit-tests with mocks —
// no browser, no wasm, no network.
//
// This module's job stops at registering/unregistering the *capability*. The
// service worker (sw.ts, push-sw.ts) can never decrypt a push's content —
// and the relay's push carries none anyway (payload-free by construction) —
// so nothing here ever touches record content either.
import { get, put } from './db'
import { base64UrlToBytes } from './base64'

const PREF_KEY = 'pushEnabled'

/** The subset of `PushSubscriptionJSON` this module reads. Both `endpoint` and
 * `keys` are optional in the DOM type (a malformed or pre-VAPID subscription
 * technically has neither), so every caller narrows before use — see
 * {@link toSubscriptionBody}. */
export interface PushSubscriptionJSON {
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
}

export interface PushSubscriptionLike {
  endpoint: string
  toJSON(): PushSubscriptionJSON
  unsubscribe(): Promise<boolean>
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  // `BufferSource` (not `Uint8Array`): TS's DOM lib types
  // `PushSubscriptionOptionsInit.applicationServerKey` this way, and a
  // `Uint8Array`'s generic buffer parameter doesn't structurally match it
  // directly — the real `PushManager.subscribe` is what this satisfies.
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<PushSubscriptionLike>
}

/** The relay surface this needs — narrower than `RelayClient` (mirrors
 * sync.ts's `BlobClient`), so tests supply a fake without fighting
 * `RelayClient`'s private-field nominal typing. `RelayClient` satisfies this
 * structurally. */
export interface PushRelayClient {
  getPushKey(): Promise<string | null>
  putPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<'ok' | 'unsupported'>
  deletePushSubscription(endpoint?: string): Promise<'ok' | 'unsupported'>
}

export type EnableFailureReason = 'permission-denied' | 'relay-unsupported' | 'subscribe-failed'

export type EnableResult = { ok: true } | { ok: false; reason: EnableFailureReason; message: string }

function toSubscriptionBody(
  sub: PushSubscriptionLike,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

/**
 * Turn push on: ask Notification permission, fetch the relay's VAPID key,
 * subscribe, and register the subscription with the relay. Persists the "on"
 * preference only once every step has actually succeeded, so a failure partway
 * through never leaves the setting reading "on" for a subscription that isn't
 * really registered anywhere.
 */
export async function enablePush(
  pushManager: PushManagerLike,
  relay: PushRelayClient,
  requestPermission: () => Promise<NotificationPermission>,
): Promise<EnableResult> {
  const permission = await requestPermission()
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'permission-denied',
      message: 'Notifications permission was not granted.',
    }
  }

  const vapidKey = await relay.getPushKey()
  if (!vapidKey) {
    return {
      ok: false,
      reason: 'relay-unsupported',
      message: "This relay doesn't offer push notifications.",
    }
  }

  let sub: PushSubscriptionLike
  try {
    sub = await pushManager.subscribe({
      userVisibleOnly: true,
      // Cast for the same reason relay.ts casts a body to `BodyInit`: TS's
      // typed-array generics (`Uint8Array<ArrayBufferLike>`) don't structurally
      // satisfy `BufferSource` even though a plain `Uint8Array` always does at
      // runtime.
      applicationServerKey: base64UrlToBytes(vapidKey) as BufferSource,
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'subscribe-failed',
      message: err instanceof Error ? err.message : 'Could not subscribe to push notifications.',
    }
  }

  const body = toSubscriptionBody(sub)
  if (!body) {
    await sub.unsubscribe().catch(() => {})
    return {
      ok: false,
      reason: 'subscribe-failed',
      message: 'The browser did not return usable subscription keys.',
    }
  }

  const result = await relay.putPushSubscription(body)
  if (result === 'unsupported') {
    // Registered locally but the relay can't take it — the operator turned
    // push off between the key fetch and now. Undo the local subscription so
    // state stays consistent rather than an orphaned browser subscription no
    // relay ever hears about.
    await sub.unsubscribe().catch(() => {})
    return {
      ok: false,
      reason: 'relay-unsupported',
      message: "This relay doesn't offer push notifications.",
    }
  }

  await put('prefs', true, PREF_KEY)
  return { ok: true }
}

/**
 * Turn push off: unsubscribe locally and tell the relay to drop this one
 * subscription. Always clears the local "on" preference first, even if a
 * later step fails — a half-disabled state (still "on" locally after the user
 * asked to turn it off) is worse than a dead subscription lingering
 * server-side, which is harmless and self-heals (the relay prunes it once a
 * send reports it gone).
 */
export async function disablePush(pushManager: PushManagerLike, relay: PushRelayClient): Promise<void> {
  await put('prefs', false, PREF_KEY)
  const sub = await pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  await relay.deletePushSubscription(endpoint).catch(() => {})
}

/** Whether the user has turned push on. Persisted independent of whether a
 * live browser subscription still backs it — {@link reassertPush} is what
 * keeps those two in sync. */
export async function isPushEnabledPref(): Promise<boolean> {
  return (await get<boolean>('prefs', PREF_KEY)) ?? false
}

/**
 * Re-register whatever subscription `pushManager` currently holds with the
 * relay. Called on every app start that has a relay configured (see
 * vault.ts's `connectRelay`, via {@link reassertPushOnStart} below) — Web
 * Push subscriptions rot (the browser or OS can drop one silently), so this
 * is a cheap, idempotent `PUT` that keeps the relay's copy honest.
 *
 * Deliberately does nothing if the user has push off, and deliberately never
 * asks permission or subscribes fresh: a browser subscription that's gone
 * means the user re-enables from Settings (an explicit action that can ask
 * permission again), not a silent background re-subscribe.
 */
export async function reassertPush(pushManager: PushManagerLike, relay: PushRelayClient): Promise<void> {
  if (!(await isPushEnabledPref())) return
  const sub = await pushManager.getSubscription()
  if (!sub) return
  const body = toSubscriptionBody(sub)
  if (!body) return
  await relay.putPushSubscription(body).catch(() => {})
}

/**
 * Browser-glue wrapper around {@link reassertPush}: resolves the current
 * service-worker registration (if any) and reasserts through it. This is the
 * one function in this module that touches `navigator` directly — everything
 * else takes its browser surface as a parameter — so it's excluded from the
 * unit-tested state machine above and instead exercised indirectly (a
 * `navigator`-less environment, like vitest's `node` environment, makes the
 * guard below false and this resolves immediately).
 */
export async function reassertPushOnStart(relay: PushRelayClient): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration?.pushManager) return
    await reassertPush(registration.pushManager, relay)
  } catch {
    // Best-effort — never blocks app boot, and the next start (or an
    // explicit re-enable) retries.
  }
}
