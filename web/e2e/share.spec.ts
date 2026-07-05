import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, logFood } from './helpers'

/** Visit the Share screen, set a display name, and return this identity's
 * exchange code. Leaves the page on the Share screen. */
async function openShareAndSetName(page: Page, name: string): Promise<string> {
  await page.evaluate(() => {
    window.location.hash = '#/share'
  })
  await page.getByTestId('display-name').fill(name)
  await expect(page.getByTestId('my-code')).toContainText(encodeURIComponent(name))
  return (await page.getByTestId('my-code').innerText()).trim()
}

/** Wait (on Settings) until the outbox is fully pushed — same pattern as
 * sync.spec.ts's `waitForPushed`. */
async function waitForPushed(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings'
  })
  await expect(page.getByTestId('sync-pending')).toHaveText('0')
}

/** Force a pull cycle via Settings' "Sync now". */
async function syncNow(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings'
  })
  await page.getByTestId('sync-now').click()
  await page.waitForTimeout(300)
}

/** Bounce Home -> the person screen so it remounts and re-reads
 * `shared_events`, retrying until `text` shows up — the shared pull runs
 * asynchronously in the background (see shared.ts's `pullShared`), and
 * Person.svelte only reads its events once, on mount. Mirrors sync.spec.ts's
 * `syncUntilVisible`. */
async function personEntryVisible(page: Page, ownerEd: string, text: string): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await page.evaluate((ed) => {
      window.location.hash = `#/person/${ed}`
    }, ownerEd)
    await expect(page.getByTestId('spine-entry').filter({ hasText: text })).toBeVisible({
      timeout: 2000,
    })
  }).toPass({ timeout: 20_000 })
}

test('spousal sharing: grant, accept, read-only timeline, then revoke goes stale', async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const pageA = await contextA.newPage()
  await onboardViaUI(pageA)
  await connectRelayViaUI(pageA)

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await onboardViaUI(pageB)
  await connectRelayViaUI(pageB)

  // A logs two entries and pushes them to the relay before sharing.
  await logBP(pageA, '118', '76')
  await logFood(pageA, 'oatmeal')
  await waitForPushed(pageA)

  // Exchange codes: A grabs B's, B grabs A's (out of band, in this test just
  // read straight off each Share screen).
  const codeA = await openShareAndSetName(pageA, 'Alex')
  const codeB = await openShareAndSetName(pageB, 'Bailey')
  const ownerEdA = codeA.split(':')[1]

  await pageB.evaluate(() => {
    window.location.hash = '#/'
  })

  // A pastes B's code, confirms the fingerprint, and shares — this grants B
  // and mails B the wrapped vault key.
  await pageA.getByTestId('paste-code').fill(codeB)
  await expect(pageA.getByTestId('confirm-share')).toBeVisible()
  await expect(pageA.getByTestId('parsed-fingerprint')).toBeVisible()
  await pageA.getByTestId('confirm-share').click()
  await expect(pageA.getByTestId('share-done')).toBeVisible()

  // B revisits the Share screen (fresh mount re-checks the mailbox) and sees
  // the invite.
  await pageB.evaluate(() => {
    window.location.hash = '#/share'
  })
  await expect(pageB.getByTestId('invite-banner')).toBeVisible({ timeout: 20_000 })
  await expect(pageB.getByTestId('invite-banner')).toContainText('Alex')
  await pageB.getByTestId('invite-accept').click()
  await expect(pageB.getByTestId('invite-banner')).toHaveCount(0)

  // B's Home shows Alex's chip.
  await pageB.evaluate(() => {
    window.location.hash = '#/'
  })
  const chip = pageB.locator('[data-testid^="switch-"]').filter({ hasText: 'Alex' })
  await expect(chip).toBeVisible()
  await chip.click()

  // A's two entries render read-only on B's device, with no log bar.
  await personEntryVisible(pageB, ownerEdA, '118/76')
  await expect(pageB.getByTestId('spine-entry').filter({ hasText: 'oatmeal' })).toBeVisible()
  await expect(pageB.getByTestId('log-vitals')).toHaveCount(0)

  // A revokes; B's next shared pull 404s and the person screen goes stale
  // gracefully — it keeps showing what already synced rather than crashing.
  await pageA.evaluate(() => {
    window.location.hash = '#/share'
  })
  await pageA.locator('[data-testid^="revoke-"]').click()

  await syncNow(pageB)
  await pageB.evaluate((ed) => {
    window.location.hash = `#/person/${ed}`
  }, ownerEdA)
  await expect(pageB.getByTestId('person-stale')).toBeVisible({ timeout: 20_000 })
  await expect(pageB.getByTestId('spine-entry').filter({ hasText: '118/76' })).toBeVisible()

  await contextA.close()
  await contextB.close()
})
