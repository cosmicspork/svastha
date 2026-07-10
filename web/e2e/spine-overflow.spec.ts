import { expect, test } from '@playwright/test'
import { onboardViaUI, openLog } from './helpers'

// A long free-text mood note used to overflow the spine on narrow phones: the
// value span was `white-space: nowrap`, so it pushed the page wider than the
// viewport and produced horizontal scrolling. Regression guard at the iPhone
// 16 Pro logical width (393px).
test('spine does not overflow horizontally with a long free-text value', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await onboardViaUI(page)

  await openLog(page, 'mind')
  await page.getByTestId('mind-tab-mood').click()
  await page.getByTestId('mood-3').click()
  await page.getByTestId('mood-note').fill(
    'felt unusually settled after the long walk by the river this morning and a slow unhurried breakfast',
  )
  await page.getByTestId('save').click()

  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Mood' })).toBeVisible()

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))
  expect(overflow.doc).toBeLessThanOrEqual(0)
  expect(overflow.body).toBeLessThanOrEqual(0)
})
