import { test, expect, type Page } from '@playwright/test'

const PASSPHRASE = 'correct horse battery staple'

/** Drive the real onboarding UI: generate a mnemonic, confirm the randomly
 * chosen words, set a passphrase, and land on the home screen. Returns the
 * generated mnemonic (for reference; not needed by callers today). */
async function onboardViaUI(page: Page, passphrase: string): Promise<string[]> {
  await page.goto('/')
  await page.getByTestId('generate-mnemonic').click()

  const words: string[] = []
  for (let i = 1; i <= 24; i++) {
    words.push((await page.getByTestId(`mnemonic-word-${i}`).innerText()).trim())
  }

  await page.getByTestId('wrote-it-down').click()

  const confirmInputs = page.locator('[data-testid^="confirm-word-"]')
  const count = await confirmInputs.count()
  for (let i = 0; i < count; i++) {
    const input = confirmInputs.nth(i)
    const testId = await input.getAttribute('data-testid')
    const position = Number(testId!.replace('confirm-word-', ''))
    await input.fill(words[position - 1])
  }
  await page.getByTestId('confirm-words-submit').click()

  await page.getByTestId('passphrase').fill(passphrase)
  await page.getByTestId('passphrase-confirm').fill(passphrase)
  await page.getByTestId('set-passphrase-submit').click()

  await expect(page.getByTestId('empty-state')).toBeVisible()
  return words
}

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
