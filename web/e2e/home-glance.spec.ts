import { test, expect } from '@playwright/test'
import { onboardViaUI, openLog } from './helpers'

// Regression guard for the "Recently logged" glance card: a long free-text
// value (a gratitude entry, a document note) used to crush the label to
// letter-per-line wrapping because .llabel was `flex: 1; min-width: 0` with
// no shrink protection, so the value's flex-basis:auto content ate all the
// row's width. iPhone-ish viewport, since that's where it was reported.
test('home glance keeps the recently-logged label beside a long free-text value', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await onboardViaUI(page)

  const longEntry =
    'Synthetic test entry: grateful for a slow unhurried morning, a long walk by the river with no particular destination, an old friend who called just to talk, and a quiet evening with nothing scheduled.'

  await openLog(page, 'mind')
  await page.getByTestId('mind-tab-gratitude').click()
  await page.getByTestId('gratitude-input').fill(longEntry)
  await page.getByTestId('save').click()

  await page.evaluate(() => {
    window.location.hash = '#/'
  })

  const card = page.getByTestId('glance-activity')
  await expect(card).toBeVisible()
  const row = card.locator('li').filter({ hasText: 'Gratitude' })
  await expect(row).toBeVisible()

  await card.screenshot({ path: process.env.HOME_GLANCE_SHOT ?? 'test-results/home-glance.png' })

  // The label column must stay wide enough to hold "Gratitude" on one line —
  // a crushed column measures a few px (one glyph per line).
  const label = row.locator('.llabel')
  const labelBox = await label.boundingBox()
  expect(labelBox?.width ?? 0).toBeGreaterThan(40)
  await expect(label).toHaveCSS('white-space', 'nowrap')

  // The value must clamp to ~2 lines rather than pour the whole entry into
  // the card — assert its rendered height stays within ~2 lines, not the
  // 4+ lines this synthetic entry would take unclamped.
  const value = row.locator('.lvalue')
  const { height, lineHeight } = await value.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(cs.lineHeight) }
  })
  expect(height / lineHeight).toBeLessThan(2.5)
})
