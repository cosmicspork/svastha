import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, openLog } from './helpers'

/** A spine entry containing `text`, scoped so assertions read naturally. */
function entryWith(page: Page, text: string) {
  return page.getByTestId('spine-entry').filter({ hasText: text })
}

/** `datetime-local` value (`YYYY-MM-DDTHH:mm`) for the Earlier time control. */
function localDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

test('cycle log flows land on the spine, one row per group', async ({ page }) => {
  await onboardViaUI(page)

  // --- flow (default pane): Moderate + clots, now ---
  await openLog(page, 'cycle')
  await page.getByTestId('flow-3').click()
  await page.getByTestId('clots-toggle').click()
  await page.getByTestId('save').click()

  await expect(page.getByTestId('day-label').first()).toHaveText('Today')
  await expect(entryWith(page, 'Moderate · clots')).toHaveCount(1)

  // --- start marker, no flow, a day earlier: its own spine row/group, not
  // folded into the flow entry above (grouping keys on effective_at) ---
  await openLog(page, 'cycle')
  await page.getByTestId('cycle-tab-start').click()
  await page.getByTestId('time-earlier').click()
  await page.getByTestId('effective-at').fill(localDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000)))
  await page.getByTestId('save').click()

  await expect(entryWith(page, 'Period started')).toHaveCount(1)
  // The start row is undecorated — it shares no timestamp with the earlier
  // flow entry, so it must not pick up "· Moderate".
  await expect(entryWith(page, 'Period started')).not.toContainText('Moderate')
})
