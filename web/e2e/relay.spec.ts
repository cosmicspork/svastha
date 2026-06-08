import { test, expect } from '@playwright/test'

// The relay origin from playwright.config.ts. Cross-origin to the web app, so
// this also exercises the relay's CORS handling end to end.
const RELAY = 'http://127.0.0.1:8787'

test('seal, upload, list, and restore a blob through the relay', async ({ page }) => {
  await page.goto('/')

  // Drive the real client module in the browser against the live relay. Vite
  // serves the source in dev, so the page can import it directly.
  const result = await page.evaluate(async (relay) => {
    const { initSvastha, WasmIdentity, WasmDataKey } = await import('/src/lib/svastha.ts')
    const { RelayClient } = await import('/src/lib/relay.ts')
    await initSvastha()

    const identity = WasmIdentity.generate()
    const client = new RelayClient(relay, identity)

    const key = WasmDataKey.generate()
    const aad = new Uint8Array()
    const plaintext = 'blood pressure 118/76'

    const sealed = key.seal(new TextEncoder().encode(plaintext), aad)
    await client.putBlob('demo-1', sealed)

    const ids = await client.listBlobs()
    const fetched = await client.getBlob('demo-1')
    const recovered = fetched ? new TextDecoder().decode(key.open(fetched, aad)) : null

    return { ids, recovered, plaintext }
  }, RELAY)

  expect(result.ids).toContain('demo-1')
  expect(result.recovered).toBe(result.plaintext)
})

test('relay rejects an unauthenticated request', async ({ request }) => {
  const res = await request.get(`${RELAY}/v0/blobs/demo-1`, { failOnStatusCode: false })
  expect(res.status()).toBe(401)
})
