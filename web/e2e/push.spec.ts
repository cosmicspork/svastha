import { test, expect } from '@playwright/test'
import { onboardViaUI } from './helpers'

// The relay origin from playwright.config.ts. The webServer entry there starts
// the relay with no SVASTHA_RELAY_VAPID_* env vars, so Web Push stays
// unconfigured — exactly the "relay doesn't offer push" case these tests
// exercise against the real binary (see spec/README.md's "Web Push": the
// `/v0/push*` endpoints answer `503` and nothing else changes).
const RELAY = 'http://127.0.0.1:8787'

test('push endpoints answer the honest feature-off state against a relay with no VAPID key', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async (relay) => {
    const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
    const { RelayClient } = await import('/src/lib/relay.ts')
    await initSvastha()

    const identity = WasmIdentity.generate()
    const client = new RelayClient(relay, identity)

    const vapidKey = await client.getPushKey()
    const putResult = await client.putPushSubscription({
      endpoint: 'https://push.example/test',
      keys: { p256dh: 'p', auth: 'a' },
    })
    const deleteResult = await client.deletePushSubscription()

    return { vapidKey, putResult, deleteResult }
  }, RELAY)

  // `null`/'unsupported' are the client's own honest translation of the
  // relay's 503 — never a thrown error a settings screen would have to catch
  // and misrepresent as a network failure.
  expect(result.vapidKey).toBeNull()
  expect(result.putResult).toBe('unsupported')
  expect(result.deleteResult).toBe('unsupported')
})

// The dev server (this harness's `webServer`, see playwright.config.ts) never
// registers a service worker — main.ts's `registerSW` call is explicitly
// gated on `import.meta.env.PROD` so a dev preview never has a build to
// register. That is a real, honestly-reachable state (also covers "the SW
// hasn't finished registering yet"), not a test artifact, so the Notifications
// settings screen is expected to show it deterministically rather than hang
// on `navigator.serviceWorker.ready`. The full enable/disable subscribe flow
// needs a real installed service worker and PushManager, which this
// dev-server-backed harness cannot provide — that state machine is unit
// tested instead (see src/lib/__tests__/push.test.ts).
test('notifications settings shows the honest not-ready state without a built service worker', async ({ page }) => {
  await onboardViaUI(page)

  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-row-notifications').click()

  await expect(page.getByTestId('push-not-ready')).toBeVisible()
  await expect(page.getByTestId('push-enable')).toHaveCount(0)
})
