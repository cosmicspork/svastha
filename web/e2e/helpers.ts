import { expect, type Page } from '@playwright/test'

export const PASSPHRASE = 'correct horse battery staple'

/** Drive the real onboarding UI: generate a mnemonic, confirm the randomly
 * chosen words, set a passphrase, and land on the home screen. Returns the
 * generated mnemonic (for reference; not needed by callers today). */
export async function onboardViaUI(page: Page, passphrase: string = PASSPHRASE): Promise<string[]> {
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
