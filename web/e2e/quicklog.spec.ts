import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, openLog, PASSPHRASE } from './helpers'

/** A spine entry containing `text`, scoped so assertions read naturally. */
function entryWith(page: Page, text: string) {
  return page.getByTestId('spine-entry').filter({ hasText: text })
}

test('quick-log flows land on the spine, grouped, flared, and persistent', async ({ page }) => {
  await onboardViaUI(page)

  // --- blood pressure: two signed events, one grouped spine entry ---
  await openLog(page, 'vitals')
  await page.getByTestId('bp-systolic').fill('118')
  await page.getByTestId('bp-diastolic').fill('76')
  await page.getByTestId('save').click()

  await expect(page.getByTestId('day-label').first()).toHaveText('Today')
  await expect(entryWith(page, '118/76')).toHaveCount(1)
  await expect(entryWith(page, '118/76')).toContainText('Blood pressure')

  // --- symptom with severity 8: flare-marked ---
  await openLog(page, 'symptom')
  await page.getByTestId('symptom-headache').click()
  await page.getByTestId('severity').fill('8')
  await page.getByTestId('save').click()

  const headache = entryWith(page, 'Headache')
  await expect(headache).toHaveCount(1)
  await expect(headache).toContainText('8/10')
  await expect(headache).toHaveAttribute('data-flare', 'true')

  // --- food: two chips, one grouped entry ---
  await openLog(page, 'food')
  await page.getByTestId('food-input').fill('oatmeal')
  await page.getByTestId('food-input').press('Enter')
  await page.getByTestId('food-input').fill('coffee')
  await page.getByTestId('food-input').press('Enter')
  await expect(page.getByTestId('food-item')).toHaveCount(2)
  await page.getByTestId('save').click()

  await expect(entryWith(page, 'coffee, oatmeal')).toHaveCount(1)

  // --- reload: everything persisted, spine rebuilt from IndexedDB ---
  await page.reload()
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()

  await expect(entryWith(page, '118/76')).toHaveCount(1)
  await expect(entryWith(page, 'Headache')).toHaveAttribute('data-flare', 'true')
  await expect(entryWith(page, 'coffee, oatmeal')).toHaveCount(1)
})
