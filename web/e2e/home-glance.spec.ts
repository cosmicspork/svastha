import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, openLog } from './helpers'

/** Log through the quick-log UI and wait for the save-toast — proof
 * `logEvent` (IndexedDB) has resolved — before doing anything else. Save's
 * click handler fires `void saveDrafts(...)`, so a click alone races the
 * write; "Save & another" (`stay: true`) also skips the 900ms auto-navigate
 * timer that "Save" schedules, which would otherwise fire mid-test and yank
 * the page back to #/timeline out from under later assertions. */
async function saveAndWait(page: Page): Promise<void> {
  await page.getByTestId('save-another').click()
  await expect(page.getByTestId('save-toast')).toBeVisible()
}

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
  await saveAndWait(page)

  await page.evaluate(() => {
    window.location.hash = '#/'
  })

  const card = page.getByTestId('glance-activity')
  await expect(card).toBeVisible()
  const row = card.locator('li').filter({ hasText: 'Gratitude' })
  await expect(row).toBeVisible()

  await card.screenshot({ path: process.env.HOME_GLANCE_SHOT ?? 'test-results/home-glance.png' })

  // The label column must stay wide enough to hold "Gratitude" on one line —
  // a crushed column measures a few px (one glyph per line). Behavioral,
  // not a specific CSS property: the label just needs to actually be there.
  const label = row.locator('.llabel')
  const labelBox = await label.boundingBox()
  expect(labelBox?.width ?? 0).toBeGreaterThan(40)

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

// Regression guard for the mirror case: a long *label*, not a long value.
// recentActivity() labels aren't guaranteed short — exercise activity names,
// joined food/med items, and imported code.display text are all free-form —
// so a naive `flex: none; white-space: nowrap` fix (label always keeps its
// full natural width) would let a long label itself overflow the row or push
// the timestamp out at a narrow width. 320px (iPhone SE) is the narrowest
// common target.
test('home glance does not overflow with a long recently-logged label', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await onboardViaUI(page)

  const longLabel =
    'Synthetic test activity: an unusually long free-text description of a workout, written the way a user might actually type one in a hurry without thinking about how it will render on a phone screen'

  await openLog(page, 'exercise')
  await page.getByTestId('exercise-activity').fill(longLabel)
  await saveAndWait(page)

  await page.evaluate(() => {
    window.location.hash = '#/'
  })

  const card = page.getByTestId('glance-activity')
  await expect(card).toBeVisible()
  const row = card.locator('li').filter({ hasText: 'Synthetic test activity' })
  await expect(row).toBeVisible()

  // No horizontal overflow anywhere from the card down to the document —
  // same shape of check as e2e/spine-overflow.spec.ts's regression guard.
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cardEl: (() => {
      const el = document.querySelector('[data-testid="glance-activity"]') as HTMLElement | null
      return el ? el.scrollWidth - el.clientWidth : 0
    })(),
  }))
  expect(overflow.doc).toBeLessThanOrEqual(0)
  expect(overflow.cardEl).toBeLessThanOrEqual(0)

  // The timestamp stays a visible, non-crushed column inside the card —
  // not pushed past the card's right edge by the long label.
  const cardBox = await card.boundingBox()
  const timeBox = await row.locator('.lago').boundingBox()
  expect(timeBox?.width ?? 0).toBeGreaterThan(20)
  expect((timeBox?.x ?? 0) + (timeBox?.width ?? 0)).toBeLessThanOrEqual((cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1)
})
