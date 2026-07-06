import { expect, type Page } from '@playwright/test'

export const PASSPHRASE = 'correct horse battery staple'

/** The relay origin from playwright.config.ts. */
export const RELAY = 'http://127.0.0.1:8787'

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
  await dismissInstallSheet(page)
  return words
}

/** First landing on Home shows the one-time install sheet (a test browser is
 * never standalone), and its scrim would swallow the next click. Dismiss it if
 * it appears; tolerate it not appearing (pref already persisted). */
async function dismissInstallSheet(page: Page): Promise<void> {
  const notNow = page.getByTestId('install-sheet-not-now')
  try {
    await notNow.click({ timeout: 3000 })
  } catch {
    return
  }
  await expect(notNow).toBeHidden()
}

/** Connect a relay through the Settings UI and land back on Home. Assumes an
 * unlocked session currently on Home. */
export async function connectRelayViaUI(page: Page, relayUrl: string = RELAY): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('relay-url').fill(relayUrl)
  await page.getByTestId('relay-connect').click()
  await expect(page.getByTestId('sync-pending')).toBeVisible()
  await page.getByTestId('nav-back').click()
}

/** Drive the Restore tab: seed phrase, passphrase, and (optionally) a relay
 * URL to restore records from. Lands unlocked on Home. */
export async function restoreViaUI(
  page: Page,
  words: string[],
  passphrase: string = PASSPHRASE,
  relayUrl?: string,
): Promise<void> {
  await page.goto('/')
  await page.getByTestId('tab-restore').click()
  await page.getByTestId('restore-mnemonic').fill(words.join(' '))
  await page.getByTestId('restore-passphrase').fill(passphrase)
  if (relayUrl) await page.getByTestId('restore-relay-url').fill(relayUrl)
  await page.getByTestId('restore-submit').click()
  // Unlocked-and-on-Home marker that works whether or not any records exist.
  await expect(page.getByTestId('nav-settings')).toBeVisible()
  await dismissInstallSheet(page)
}

/** Open the bloom and pick a petal — the FAB must be expanded before a
 * `log-{kind}` petal is clickable. */
export async function openLog(page: Page, kind: string): Promise<void> {
  await page.getByTestId('fab').click()
  await page.getByTestId(`log-${kind}`).click()
}

/** Log a blood pressure reading through the quick-log UI (two events). */
export async function logBP(page: Page, systolic: string, diastolic: string): Promise<void> {
  await openLog(page, 'vitals')
  await page.getByTestId('bp-systolic').fill(systolic)
  await page.getByTestId('bp-diastolic').fill(diastolic)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: `${systolic}/${diastolic}` })).toBeVisible()
}

/** Log one food item through the quick-log UI (one event). */
export async function logFood(page: Page, item: string): Promise<void> {
  await openLog(page, 'food')
  await page.getByTestId('food-input').fill(item)
  await page.getByTestId('food-input').press('Enter')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: item })).toBeVisible()
}
