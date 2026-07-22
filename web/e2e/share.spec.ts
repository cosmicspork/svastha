import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, logFood, PASSPHRASE } from './helpers'

/** Visit the "Your people" screen, set a display name, and return this
 * identity's exchange code. Leaves the page on that screen. */
async function openShareAndSetName(page: Page, name: string): Promise<string> {
  await page.evaluate(() => {
    window.location.hash = '#/share/people'
  })
  await page.getByTestId('display-name').fill(name)
  await expect(page.getByTestId('my-code')).toContainText(encodeURIComponent(name))
  return (await page.getByTestId('my-code').innerText()).trim()
}

/** Wait (on Settings' Sync & devices sub-screen) until the outbox is fully
 * pushed — same pattern as sync.spec.ts's `waitForPushed`. */
async function waitForPushed(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await expect(page.getByTestId('sync-pending')).toHaveText('0')
}

/** Force a pull cycle via Settings' "Sync now". */
async function syncNow(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await page.getByTestId('sync-now').click()
  await page.waitForTimeout(300)
}

/** Bounce Home -> the person screen so it remounts and re-reads
 * `shared_events`, retrying until every `text` shows up in a SINGLE mount — the
 * shared pull runs asynchronously in the background (see shared.ts's
 * `pullShared`, kicked by `acceptInvite`) and writes the owner's ev- blobs one
 * at a time, while Person.svelte reads its events just once, on mount. Asserting
 * one entry via this retry and a second with a plain check would sample a
 * mid-pull snapshot: the first-written blob can be present while a later one
 * (here the food event, pushed after the BP pair) has not landed yet. Requiring
 * all of them in one mounted view waits for the pull to fully converge. Mirrors
 * sync.spec.ts's `syncUntilVisible`. */
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

  // B opens the sharing home (fresh mount re-checks the mailbox) and sees the
  // invite in "Waiting for you".
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

  // A's two entries render read-only on B's device, with no log bar. Both
  // arrive via the same background shared pull, so wait for a single mounted
  // view to show both rather than sampling a mid-pull snapshot.
  await personEntriesVisible(pageB, ownerEdA, ['118/76', 'oatmeal'])
  await expect(pageB.getByTestId('log-vitals')).toHaveCount(0)

  // A revokes from the "Your people" screen (where active grants live); B's
  // next shared pull 404s and the person screen goes stale gracefully — it
  // keeps showing what already synced rather than crashing.
  await pageA.evaluate(() => {
    window.location.hash = '#/share/people'
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

test('a scanned share link prefills the confirm box, surviving a locked-vault reload', async ({
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
  const codeB = await openShareAndSetName(pageB, 'Bailey')

  // Simulate a camera app opening A's link to B's QR: a genuine fresh
  // document load (a same-document hash-only `goto` wouldn't reset the
  // in-memory session — bouncing through about:blank forces a real one), so
  // the vault is locked exactly as it would be on a real cold app-open. The
  // QR still targets the public `#/share` entry; the unlock flow must land
  // there and be redirected into "Your people" with the code intact.
  await pageA.goto('about:blank')
  await pageA.goto(`/#/share?code=${encodeURIComponent(codeB)}`)

  await expect(pageA.getByTestId('unlock-passphrase')).toBeVisible()
  await pageA.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await pageA.getByTestId('unlock-submit').click()

  await expect(pageA.getByTestId('paste-code')).toHaveValue(codeB)
  await expect(pageA.getByTestId('confirm-share')).toBeVisible()
  await expect(pageA.getByTestId('parsed-fingerprint')).toBeVisible()

  // The `#/share?code=…` link is redirected into the people screen and the
  // param is consumed and stripped, so a refresh won't re-trigger it.
  await expect(pageA).toHaveURL(/#\/share\/people$/)

  await contextA.close()
  await contextB.close()
})

test('the sharing home reaches both audiences: cards with counts, plus the Home chip', async ({
  page,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)

  // The Home switcher chip is the front door — visible on a fresh vault.
  await expect(page.getByTestId('nav-share')).toBeVisible()
  await page.getByTestId('nav-share').click()
  await expect(page).toHaveURL(/#\/share$/)

  // Both navigation cards render, each with its zero-state count sub-line.
  await expect(page.getByTestId('card-people')).toBeVisible()
  await expect(page.getByTestId('card-doctor')).toBeVisible()
  await expect(page.getByTestId('people-counts')).toContainText('0 active grants')
  await expect(page.getByTestId('people-counts')).toContainText('0 shared with you')
  await expect(page.getByTestId('doctor-counts')).toContainText('0 links')
  await expect(page.getByTestId('doctor-counts')).toContainText('0 active')

  // The cards route to their respective screens.
  await page.getByTestId('card-people').click()
  await expect(page).toHaveURL(/#\/share\/people$/)
  await expect(page.getByTestId('my-code')).toBeVisible()

  await page.evaluate(() => {
    window.location.hash = '#/share'
  })
  await page.getByTestId('card-doctor').click()
  await expect(page).toHaveURL(/#\/share\/doctor$/)
  await expect(page.getByTestId('doctor-empty')).toBeVisible()
})
