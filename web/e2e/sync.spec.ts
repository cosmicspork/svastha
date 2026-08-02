import { test, expect, type Page } from '@playwright/test'
import {
  onboardViaUI,
  connectRelayViaUI,
  restoreViaUI,
  logBP,
  logFood,
  waitForPushed,
  syncUntil,
  RELAY,
} from './helpers'

function entryWith(page: Page, text: string) {
  return page.getByTestId('spine-entry').filter({ hasText: text })
}

/** Pull until `text` shows up on the spine. The spine reads IndexedDB on
 * mount, so each round re-enters Timeline; hash navigation avoids a reload
 * (which would lock the session). */
async function syncUntilVisible(page: Page, text: string): Promise<void> {
  await syncUntil(page, async () => {
    await page.evaluate(() => {
      window.location.hash = '#/timeline'
    })
    await expect(entryWith(page, text)).toBeVisible({ timeout: 2000 })
  })
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

  // The spine lives on the Timeline page now (Home is a dashboard).
  await pageB.evaluate(() => {
    window.location.hash = '#/timeline'
  })
  await expect(entryWith(pageB, '118/76')).toBeVisible()
  await expect(entryWith(pageB, 'oatmeal')).toBeVisible()
  await restored.close()
})

test('a cold restore above the batch threshold pulls pages, not per-id GETs', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // 23 events (21 food + one BP pair): enough distinct ev- blobs to clear
  // BATCH_PULL_THRESHOLD (20) so the restore takes the framed include=body
  // walk instead of the per-id loop the test below this one still exercises.
  for (let i = 0; i < 21; i++) {
    await logFood(page, `meal-${i}`)
  }
  await logBP(page, '117', '75')
  await waitForPushed(page)

  const restored = await browser.newContext()
  const pageB = await restored.newPage()
  // The proof is on the wire: the restore walks framed pages and never fetches
  // an ev- blob by id. Counting requests (rather than asserting on timing or
  // totals) keeps the test stable however the page walk splits.
  let batchPages = 0
  let perIdEvGets = 0
  pageB.on('request', (req) => {
    if (req.method() !== 'GET') return
    if (req.url().includes('include=body')) batchPages++
    if (req.url().includes('/v0/blobs/ev-')) perIdEvGets++
  })
  await restoreViaUI(pageB, words, undefined, RELAY)

  await pageB.evaluate(() => {
    window.location.hash = '#/timeline'
  })
  await expect(entryWith(pageB, 'meal-0')).toBeVisible({ timeout: 15_000 })
  // Snapshot the counters the moment the restore's pull has demonstrably
  // landed: the assertion is about that pull, and a later background pull
  // between two `toBeVisible` awaits would otherwise fold into it.
  const duringRestore = { batchPages, perIdEvGets }
  await expect(entryWith(pageB, 'meal-20')).toBeVisible()
  await expect(entryWith(pageB, '117/75')).toBeVisible()
  expect(duringRestore.batchPages).toBeGreaterThan(0)
  expect(duringRestore.perIdEvGets).toBe(0)
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
