import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, logFood } from './helpers'

/** Visit "Your people", set a display name, and return this identity's exchange
 * code (`svastha1:{ed}:{x}:{label}`). */
async function openShareAndSetName(page: Page, name: string): Promise<string> {
  await page.evaluate(() => {
    window.location.hash = '#/share/people'
  })
  await page.getByTestId('display-name').fill(name)
  await expect(page.getByTestId('my-code')).toContainText(encodeURIComponent(name))
  return (await page.getByTestId('my-code').innerText()).trim()
}

async function waitForPushed(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await expect(page.getByTestId('sync-pending')).toHaveText('0')
}

async function syncNow(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await page.getByTestId('sync-now').click()
  await page.waitForTimeout(300)
}

async function personEntriesVisible(page: Page, ownerEd: string, texts: string[]): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await page.evaluate((ed) => {
      window.location.hash = `#/person/${ed}`
    }, ownerEd)
    for (const text of texts) {
      await expect(page.getByTestId('spine-entry').filter({ hasText: text })).toBeVisible({
        timeout: 2000,
      })
    }
  }).toPass({ timeout: 20_000 })
}

test('devices & grants: enroll a grantee, then revoke-and-rotate cuts off future access', async ({
  browser,
}) => {
  // Owner A and grantee B, each a fresh identity on the same relay.
  const contextA = await browser.newContext()
  const pageA = await contextA.newPage()
  await onboardViaUI(pageA)
  await connectRelayViaUI(pageA)

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await onboardViaUI(pageB)
  await connectRelayViaUI(pageB)

  // A logs an entry and pushes it before sharing.
  await logBP(pageA, '120', '80')
  await waitForPushed(pageA)

  // A sets a name; B's code is grabbed out of band (read off B's screen here).
  await openShareAndSetName(pageA, 'Alex')
  const codeB = await openShareAndSetName(pageB, 'Bailey')
  const edB = codeB.split(':')[1]
  await pageB.evaluate(() => {
    window.location.hash = '#/'
  })

  // A enrolls B as a household grantee from the Devices & grants screen: scoped
  // grant + wrapped-keyring handoff.
  await pageA.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await pageA.getByTestId('enroll-paste').fill(codeB)
  await expect(pageA.getByTestId('enroll-fingerprint')).toBeVisible()
  await expect(pageA.getByTestId('enroll-kind-household')).toBeChecked()
  await pageA.getByTestId('enroll-submit').click()
  await expect(pageA.getByTestId('enroll-done')).toBeVisible()

  // B accepts the invite and reads A's entry (access works before revocation).
  const ownerEdA = (await openShareAndSetName(pageA, 'Alex')).split(':')[1]
  await pageB.evaluate(() => {
    window.location.hash = '#/share'
  })
  await expect(pageB.getByTestId('invite-banner')).toBeVisible({ timeout: 20_000 })
  await pageB.getByTestId('invite-accept').click()
  await expect(pageB.getByTestId('invite-banner')).toHaveCount(0)
  await personEntriesVisible(pageB, ownerEdA, ['120/80'])

  // A revokes B and rotates in one action, confirming the honest caveat.
  await pageA.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await pageA.getByTestId(`grant-revoke-${edB}`).click()
  await expect(pageA.getByTestId('rotate-confirm')).toBeVisible()
  await expect(pageA.getByTestId('revoke-caveat')).toContainText('already been decrypted')
  await pageA.getByTestId('rotate-confirm-yes').click()
  await expect(pageA.getByTestId('rotate-confirm')).toHaveCount(0)
  // B is gone from the outgoing grant list.
  await expect(pageA.getByTestId(`grant-${edB}`)).toHaveCount(0)

  // A logs a NEW entry AFTER the rotation — it seals under the new epoch.
  await logFood(pageA, 'post-rotation-apple')
  await waitForPushed(pageA)

  // B's next pull 404s (grant revoked): the share goes stale, keeps what already
  // synced (120/80), and never receives the post-rotation entry.
  await syncNow(pageB)
  await pageB.evaluate((ed) => {
    window.location.hash = `#/person/${ed}`
  }, ownerEdA)
  await expect(pageB.getByTestId('person-stale')).toBeVisible({ timeout: 20_000 })
  await expect(pageB.getByTestId('spine-entry').filter({ hasText: '120/80' })).toBeVisible()
  await expect(pageB.getByTestId('spine-entry').filter({ hasText: 'post-rotation-apple' })).toHaveCount(0)

  await contextA.close()
  await contextB.close()
})
