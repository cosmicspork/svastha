import { test, expect } from '@playwright/test'
import { onboardViaUI, PASSPHRASE } from './helpers'

test('onboard, reload, and unlock with the same passphrase restores the same identity', async ({
  page,
}) => {
  await onboardViaUI(page, PASSPHRASE)

  await page.getByTestId('nav-settings').click()
  const fingerprintBefore = await page.getByTestId('ed25519-fingerprint').innerText()
  expect(fingerprintBefore).not.toBe('')

  // The hash (#/settings) survives the reload, so unlocking lands back on
  // Settings directly rather than Home.
  await page.reload()

  await expect(page.getByTestId('unlock-passphrase')).toBeVisible()
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()

  await expect(page.getByTestId('ed25519-fingerprint')).toBeVisible()
  const fingerprintAfter = await page.getByTestId('ed25519-fingerprint').innerText()

  expect(fingerprintAfter).toBe(fingerprintBefore)
})

test('unlocking with the wrong passphrase shows a friendly error', async ({ page }) => {
  await onboardViaUI(page, PASSPHRASE)
  await page.reload()

  await expect(page.getByTestId('unlock-passphrase')).toBeVisible()
  await page.getByTestId('unlock-passphrase').fill('definitely the wrong passphrase')
  await page.getByTestId('unlock-submit').click()

  await expect(page.getByTestId('unlock-error')).toHaveText(
    "That passphrase doesn't match. Your seed phrase can always restore access.",
  )
})
