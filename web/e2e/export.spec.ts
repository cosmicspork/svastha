import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, restoreViaUI, logBP, logFood } from './helpers'

/** A spine entry containing `text`. */
function entryWith(page: Page, text: string) {
  return page.getByTestId('spine-entry').filter({ hasText: text })
}

// No relay is involved at all: the encrypted backup is a plain file channel,
// so the import path is proven against a fresh device that never connects to
// a relay.
test('encrypted backup round-trips to a fresh device from the seed alone, and re-import dedupes', async ({
  page,
  browser,
}) => {
  const words = await onboardViaUI(page)

  // A couple of events plus a tag, so the backup carries ev- and cur- blobs.
  await logBP(page, '118', '76')
  await logFood(page, 'oatmeal')

  const oatmeal = entryWith(page, 'oatmeal')
  await oatmeal.getByTestId('spine-entry-tag-toggle').click()
  await page.getByTestId('tag-input').fill('breakfast')
  await page.getByTestId('tag-input').press('Enter')
  await expect(page.getByTestId('tag-chip')).toContainText('#breakfast')

  // Download the encrypted backup from Settings (ciphertext — no confirm sheet).
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-row-data').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-encrypted').click()
  const backupPath = await (await downloadPromise).path()

  // Fresh device: empty IndexedDB, same seed phrase, NO relay URL. Import the
  // backup file through Settings.
  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await restoreViaUI(pageB, words)

  await pageB.getByTestId('nav-settings').click()
  await pageB.getByTestId('settings-row-data').click()
  await pageB.getByTestId('import-backup-input').setInputFiles(backupPath)

  const resultB = pageB.getByTestId('import-backup-result')
  await expect(resultB).toContainText('new event')
  await expect(resultB).toContainText('curation record')

  // The imported events (and the tag) show on the fresh device's timeline.
  // A sub-screen's header shows only Back; a single click reaches Home.
  await pageB.getByTestId('nav-back').click()
  await expect(entryWith(pageB, '118/76')).toBeVisible()
  const oatmealB = entryWith(pageB, 'oatmeal')
  await expect(oatmealB).toBeVisible()
  await expect(oatmealB.getByTestId('spine-entry-tag')).toHaveText('#breakfast')

  // Re-importing the exact same file finds everything already present: zero new.
  await pageB.getByTestId('nav-settings').click()
  await pageB.getByTestId('settings-row-data').click()
  await pageB.getByTestId('import-backup-input').setInputFiles(backupPath)
  await expect(resultB).toContainText('0 new events')
  await expect(resultB).toContainText('already present')

  await contextB.close()
})
