import { test, expect, type Page } from '@playwright/test'
import {
  onboardViaUI,
  connectRelayViaUI,
  restoreViaUI,
  openLog,
  waitForPushed,
  RELAY,
  PASSPHRASE,
} from './helpers'

/** `datetime-local` value (`YYYY-MM-DDTHH:mm`) for the Earlier time control. */
function localDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Click "Sync now" once, from wherever the app currently is, and land back
 * on Home. */
async function syncNow(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await page.getByTestId('sync-now').click()
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
}

test('logging an input before a symptom surfaces it in Patterns, and a tag persists across reload', async ({
  page,
}) => {
  await onboardViaUI(page)

  // Food 30 hours ago, via the Earlier time control.
  await openLog(page, 'food')
  await page.getByTestId('food-input').fill('peanut butter')
  await page.getByTestId('food-input').press('Enter')
  await page.getByTestId('time-earlier').click()
  await page.getByTestId('effective-at').fill(localDatetimeInput(new Date(Date.now() - 30 * 3600 * 1000)))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'peanut butter' })).toBeVisible()

  // Headache, severity 8, now.
  await openLog(page, 'symptom')
  await page.getByTestId('symptom-headache').click()
  await page.getByTestId('severity').fill('8')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Headache' })).toBeVisible()

  // Patterns: the symptom dot is there, and tapping it opens FlarePanel.
  await page.getByTestId('nav-correlate').click()
  await expect(page.getByTestId('symptom-dot')).toBeVisible()
  await page.getByTestId('symptom-dot').click()
  await expect(page.getByTestId('flare-panel')).toBeVisible()

  // Default window is 48h — wide enough to catch the 30h-ago meal.
  await expect(page.getByTestId('flare-window-48')).toHaveAttribute('aria-pressed', 'true')
  const flareItem = page.getByTestId('flare-item').filter({ hasText: 'peanut butter' })
  await expect(flareItem).toBeVisible()
  await expect(flareItem).toContainText('30 h before')

  // Tag the symptom from FlarePanel's TagEditor.
  await page.getByTestId('tag-input').fill('flare')
  await page.getByTestId('tag-input').press('Enter')
  await expect(page.getByTestId('tag-chip')).toContainText('#flare')
  await page.getByTestId('flare-close').click()

  // Back on the spine, the tag shows on the Headache entry...
  await page.getByTestId('nav-back').click()
  const headache = page.getByTestId('spine-entry').filter({ hasText: 'Headache' })
  await expect(headache.getByTestId('spine-entry-tag')).toHaveText('#flare')

  // ...and survives a reload (it's in IndexedDB's curation store, not
  // component state).
  await page.reload()
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
  await expect(
    page.getByTestId('spine-entry').filter({ hasText: 'Headache' }).getByTestId('spine-entry-tag'),
  ).toHaveText('#flare')
})

test('curation LWW: two devices tagging the same event converge on the later write', async ({
  page,
  browser,
}) => {
  // Block the SSE push stream on BOTH devices: this test pins LWW merge
  // semantics at an explicit sync point, and pokes make pulls fire at
  // arbitrary moments (B would see A's write before its own; A would pull
  // mid-edit). With the stream blocked, the authoritative pull path is the
  // only merge point and the race is exactly the one under test.
  await page.route('**/v0/events', (route) => route.abort())
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  await openLog(page, 'symptom')
  await page.getByTestId('symptom-nausea').click()
  await page.getByTestId('save').click()
  await waitForPushed(page)

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await pageB.route('**/v0/events', (route) => route.abort())
  await restoreViaUI(pageB, words, undefined, RELAY)
  await expect(pageB.getByTestId('spine-entry').filter({ hasText: 'Nausea' })).toBeVisible()

  // Device A tags 'x' first...
  const entryA = page.getByTestId('spine-entry').filter({ hasText: 'Nausea' })
  await entryA.getByTestId('spine-entry-tag-toggle').click()
  await page.getByTestId('tag-input').fill('x')
  await page.getByTestId('tag-input').press('Enter')
  await expect(page.getByTestId('tag-chip')).toContainText('#x')
  await waitForPushed(page)

  // ...device B tags 'y' afterward (strictly later `updated_at`), on its own
  // copy of the same event.
  const entryB = pageB.getByTestId('spine-entry').filter({ hasText: 'Nausea' })
  await entryB.getByTestId('spine-entry-tag-toggle').click()
  await pageB.getByTestId('tag-input').fill('y')
  await pageB.getByTestId('tag-input').press('Enter')
  await expect(pageB.getByTestId('tag-chip')).toContainText('#y')
  await waitForPushed(pageB)

  // After A syncs, LWW converges both devices on B's later write.
  await syncNow(page)
  await expect(entryA.getByTestId('spine-entry-tag')).toHaveText('#y', { timeout: 10_000 })
  await expect(entryB.getByTestId('spine-entry-tag')).toHaveText('#y')

  await contextB.close()
})
