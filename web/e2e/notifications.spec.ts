import { test, expect } from '@playwright/test'
import { onboardViaUI } from './helpers'

// The header's notification center on the happy path: the bell rides the header
// on Home, opens the bottom sheet, and a fresh vault (no invites, no expiring
// doctor links, dictionary off) shows the honest caught-up empty state with no
// unread badge. The source derivations themselves are covered by unit tests;
// this is the render + open seam through the real UI.
test('notification bell opens the sheet and shows the caught-up empty state', async ({ page }) => {
  await onboardViaUI(page)

  const bell = page.getByTestId('nav-notifications')
  await expect(bell).toBeVisible()
  // Nothing to report on a fresh vault, so the unread badge stays hidden.
  await expect(page.getByTestId('notification-badge')).toHaveCount(0)

  await bell.click()
  await expect(page.getByTestId('notifications-empty')).toBeVisible()
})
