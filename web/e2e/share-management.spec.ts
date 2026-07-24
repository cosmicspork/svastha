import { test, expect } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, restoreViaUI, logBP, PASSPHRASE, RELAY } from './helpers'

// Cross-device doctor-share management and history clearing, end to end
// against the live relay: the design is "ask the relay for what it already
// holds," never sync share records through the vault, so these exercise the
// seam a unit test can't — a share created on one device, discovered and
// revoked from a second device that has no local record for it at all.

test('cross-device: a share made on one device is listed (reduced view) and revocable from a second, restored device', async ({
  browser,
}) => {
  const deviceA = await browser.newContext()
  const pageA = await deviceA.newPage()
  const words = await onboardViaUI(pageA)
  await connectRelayViaUI(pageA)
  await logBP(pageA, '128', '82')

  await pageA.evaluate(() => (window.location.hash = '#/share/doctor'))
  await pageA.getByTestId('new-doctor-link').click()
  await pageA.getByTestId('share-create').click()
  await expect(pageA.getByTestId('share-link')).toBeVisible()
  const link = (await pageA.getByTestId('share-link').innerText()).trim()
  const token = link.split('/#/s/')[1].split('.')[0]
  await pageA.getByTestId('share-done').click()

  // A second device restored from the same mnemonic + relay — it never ran
  // the create flow, so it holds no `doctor_shares` record for this token at
  // all; the relay is the only place it can learn this share exists.
  const deviceB = await browser.newContext()
  const pageB = await deviceB.newPage()
  await restoreViaUI(pageB, words, PASSPHRASE, RELAY)
  await pageB.evaluate(() => (window.location.hash = '#/share/doctor'))

  // The honest reduced view: a fingerprint and timing, clearly labeled as
  // made elsewhere — never the scope summary, since this device was never
  // told it.
  await expect(pageB.getByTestId(`remote-fingerprint-${token}`)).toBeVisible()
  await expect(pageB.getByTestId('remote-share-list')).toContainText('made on another device')

  // Revoke from device B — the same tombstone DELETE by token, from a device
  // that never created it.
  await pageB.getByTestId(`revoke-remote-${token}`).click()
  await expect(pageB.getByTestId(`remote-fingerprint-${token}`)).toHaveCount(0)

  // The relay stops serving the bundle to anyone, confirming the revoke was
  // real, not just a local list update.
  const afterRevoke = await pageB.request.get(`${RELAY}/v0/share/${token}`, { failOnStatusCode: false })
  expect(afterRevoke.status()).toBe(410)

  await deviceA.close()
  await deviceB.close()
})

test('offline/no-relay: the cross-device section is absent, not empty-and-misleading', async ({ page }) => {
  // Deliberately no relay connected — local doctor-share management (were
  // there any records) must keep working with no cross-device section at all.
  await onboardViaUI(page)
  await page.evaluate(() => (window.location.hash = '#/share/doctor'))
  await expect(page.getByTestId('remote-share-list')).toHaveCount(0)
  await expect(page.getByTestId('cross-device-unavailable')).toHaveCount(0)
})

// History clearing: an inactive record clears only once the relay confirms it
// no longer serves the token. Revocation tombstones immediately, so the gate
// opens right away — no waiting on real time the way an expiry would need.
test('history clearing: a revoked share clears individually and in bulk once the relay confirms it, and a file share clears with its own confirmation', async ({
  page,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '118', '76')

  async function createAndRevokeShare(): Promise<string> {
    await page.evaluate(() => (window.location.hash = '#/share/doctor'))
    await page.getByTestId('new-doctor-link').click()
    await page.getByTestId('share-create').click()
    await expect(page.getByTestId('share-link')).toBeVisible()
    const link = (await page.getByTestId('share-link').innerText()).trim()
    const token = link.split('/#/s/')[1].split('.')[0]
    await page.getByTestId('share-done').click()
    await page.getByTestId(`revoke-${token}`).click()
    await expect(page.getByTestId(`share-status-${token}`)).toHaveText('revoked')
    return token
  }

  const tokenA = await createAndRevokeShare()

  // Individual clear: enabled the moment the relay's tombstone lands, no wait.
  await expect(page.getByTestId(`clear-${tokenA}`)).toBeEnabled()
  await page.getByTestId(`clear-${tokenA}`).click()
  await expect(page.getByTestId(`share-status-${tokenA}`)).toHaveCount(0)

  // Bulk clear over a second revoked share.
  const tokenB = await createAndRevokeShare()
  await expect(page.getByTestId('clear-inactive-history')).toBeEnabled()
  await page.getByTestId('clear-inactive-history').click()
  await expect(page.getByTestId(`share-status-${tokenB}`)).toHaveCount(0)
  await expect(page.getByTestId('clear-inactive-history')).toHaveCount(0)

  // A file share's history entry deletes with its own confirmation copy —
  // no relay gate (it's unrevocable by construction), but an honest warning
  // that this only removes the local trace, not the handed-over copy.
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('delivery-file').click()
  await page.getByTestId('file-passphrase-toggle').click() // embedded mode: no phrase to juggle here
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('share-save-file').click()
  await downloadPromise
  await page.getByTestId('share-done').click()
  await expect(page.getByTestId('file-share-list')).toContainText('unrevocable')

  const deleteFileBtn = page.locator('[data-testid^="delete-file-share-"]')
  await deleteFileBtn.click()
  await expect(page.getByTestId('file-delete-confirm')).toBeVisible()
  await expect(page.getByTestId('file-delete-confirm')).toContainText("doesn't un-hand-over the file")
  await page.getByTestId('file-delete-confirm-yes').click()
  await expect(page.getByTestId('file-share-list')).toHaveCount(0)
})
