import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, restoreViaUI, logBP, logFood, waitForPushed, RELAY } from './helpers'

/** A spine entry containing `text`. */
function entryWith(page: Page, text: string) {
  return page.getByTestId('spine-entry').filter({ hasText: text })
}

/** Click "Sync now" until `text` shows up on the spine. The pull is
 * asynchronous and the spine reads IndexedDB on mount, so each round trips
 * Settings -> pull -> Home; hash navigation avoids a reload (which would
 * lock the session). */
async function syncUntilVisible(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => {
      window.location.hash = '#/settings/sync'
    })
    await page.getByTestId('sync-now').click()
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await expect(entryWith(page, text)).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
}

test('events pushed to the relay restore on a fresh device from mnemonic + relay URL', async ({
  page,
  browser,
}) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // Three events: a BP pair plus one food item.
  await logBP(page, '118', '76')
  await logFood(page, 'oatmeal')
  await waitForPushed(page)

  // "Wipe": a fresh browser context has empty IndexedDB — same as a new or
  // reset device. Restore from the mnemonic plus the relay URL.
  const restored = await browser.newContext()
  const pageB = await restored.newPage()
  await restoreViaUI(pageB, words, undefined, RELAY)

  await expect(entryWith(pageB, '118/76')).toBeVisible()
  await expect(entryWith(pageB, 'oatmeal')).toBeVisible()
  await restored.close()
})

test('two connected devices converge: log on A, Sync now on B', async ({ page, browser }) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await restoreViaUI(pageB, words, undefined, RELAY)

  await logBP(page, '121', '79')
  await waitForPushed(page)

  // "Sync now" instead of waiting out the five-minute pull interval.
  await syncUntilVisible(pageB, '121/79')
  await contextB.close()
})
