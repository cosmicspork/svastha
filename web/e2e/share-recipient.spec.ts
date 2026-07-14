import { test, expect } from '@playwright/test'
import { RELAY } from './helpers'

// The recipient (doctor) side: a cold-load share link opened in a browser that
// has never run Svastha. These two cases need no created share — they exercise
// the account-less boot and the honest error copy. A seeded-happy-path case
// needs owner auth to PUT a bundle, which the e2e helpers don't yet expose; it
// lands as a cross-PR integration test once the create UI merges.

/** base64url unpadded, matching the pinned link contract. */
function b64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

test('a malformed share link shows the invalid-link state, booting no vault', async ({ page }) => {
  await page.goto('/#/s/garbage')

  await expect(page.getByTestId('share-error')).toBeVisible()
  await expect(page.getByTestId('share-error')).toContainText('This link is invalid or incomplete.')

  // Cold load: none of the normal app chrome (onboarding, settings nav) boots.
  await expect(page.getByTestId('generate-mnemonic')).toHaveCount(0)
  await expect(page.getByTestId('nav-settings')).toHaveCount(0)
})

test('a well-formed link for an unknown token 404s to the invalid-link state', async ({ page }) => {
  // 26-char token in the blob-id charset, a 32-byte key, and the test relay
  // origin — well-formed, so the app fetches; the relay has never seen this
  // token, so it 404s, which the recipient maps to "invalid or incomplete".
  const token = 'abcdefghijklmnopqrstuvwxyz'
  const key = b64url(Buffer.alloc(32, 7))
  const relay = b64url(Buffer.from(RELAY))

  await page.goto(`/#/s/${token}.${key}.${relay}`)

  await expect(page.getByTestId('share-error')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('share-error')).toContainText('This link is invalid or incomplete.')
})
