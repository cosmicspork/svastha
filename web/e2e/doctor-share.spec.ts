import { test, expect } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, RELAY } from './helpers'

// Owner-side doctor share, end to end against the live relay: log an event,
// mint a share through the real UI, then confirm the relay serves the sealed
// bundle by its bearer token and that it opens under the link's key with the
// AAD the contract pins (the token bytes). This is the seal + upload half of
// the pinned share contract the recipient view consumes.
test('create a doctor share and fetch the sealed bundle from the relay', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '128', '82')

  await page.evaluate(() => {
    window.location.hash = '#/share'
  })
  await page.getByTestId('open-doctor-share').click()

  // Default scope (everything), default 7-day expiry.
  await page.getByTestId('share-create').click()

  await expect(page.getByTestId('share-link')).toBeVisible()
  await expect(page.getByTestId('share-qr').locator('svg')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()

  // Link shape: {origin}/#/s/{token}.{key}.{relay}, three dot segments.
  const frag = link.split('/#/s/')[1]
  const [token, keySeg, relaySeg] = frag.split('.')
  expect(token.length).toBeGreaterThanOrEqual(22)
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/)

  // The relay serves the bundle unauthenticated by token, and it opens under
  // the key + token-AAD from the link into the pinned bundle JSON.
  const bundle = await page.evaluate(
    async ({ relay, token, keySeg, relaySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        const bin = atob(b64 + pad)
        return Uint8Array.from(bin, (c) => c.charCodeAt(0))
      }
      const relayOrigin = new TextDecoder().decode(b64urlToBytes(relaySeg))
      const res = await fetch(`${relayOrigin}/v0/share/${token}`)
      if (res.status !== 200) return { status: res.status }
      const sealed = new Uint8Array(await res.arrayBuffer())

      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      const aad = new TextEncoder().encode(token)
      const json = new TextDecoder().decode(key.open(sealed, aad))
      const parsed = JSON.parse(json)
      return {
        status: 200,
        relayMatches: relayOrigin === relay,
        v: parsed.v,
        signerLen: b64urlToBytes(parsed.signer).length,
        eventCount: parsed.events.length,
        firstAuthorIsHex: /^[0-9a-f]{64}$/.test(parsed.events[0]?.author ?? ''),
      }
    },
    { relay: RELAY, token, keySeg, relaySeg },
  )

  expect(bundle.status).toBe(200)
  expect(bundle.relayMatches).toBe(true)
  expect(bundle.v).toBe(1)
  expect(bundle.signerLen).toBe(32) // 32-byte Ed25519 public key
  expect(bundle.eventCount).toBeGreaterThanOrEqual(2) // the BP pair
  expect(bundle.firstAuthorIsHex).toBe(true)

  // Revoke, and the relay stops serving the bundle (410 Gone). The manage list
  // lives on the create screen, so step back from the result screen first.
  await page.getByTestId('share-another').click()
  await page.getByTestId(`revoke-${token}`).click()
  await expect(page.getByTestId(`share-status-${token}`)).toHaveText('revoked')
  const afterRevoke = await page.request.get(`${RELAY}/v0/share/${token}`, { failOnStatusCode: false })
  expect(afterRevoke.status()).toBe(410)
})
