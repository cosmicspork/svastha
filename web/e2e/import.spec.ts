import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI } from './helpers'

// Relative to the cwd Playwright runs from (`web/`, per playwright.config.ts's
// webServer commands) — the same fixtures crates/import's Rust tests import,
// see fixtures/README.md.
const XDM_ZIP = '../fixtures/xdm/minimal-xdm.zip'
const FHIR_BUNDLE = '../fixtures/fhir/bundle-minimal.json'

async function goToImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import'
  })
}

/** Wait (on Settings' Sync & devices sub-screen) until the outbox is fully
 * pushed — same pattern as sync.spec.ts's/share.spec.ts's `waitForPushed`. */
async function waitForPushed(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/sync'
  })
  await expect(page.getByTestId('sync-pending')).toHaveText('0')
}

test('imports an XDM package and a FHIR bundle, dedupes across formats, and re-import is a no-op', async ({
  page,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await goToImport(page)

  await page.getByTestId('import-file-input').setInputFiles([XDM_ZIP, FHIR_BUNDLE])

  // Two source documents (the XDM zip's one DOC*.XML, plus the bundle).
  await expect(page.getByTestId('import-doc')).toHaveCount(2)

  // 16 C-CDA events + 9 FHIR events, minus 3 facts (Condition, Immunization,
  // Procedure) that are the identical fact in both fixtures -- the
  // cross-format dedup the content-id scheme exists for -- leaves 22 new and
  // 3 counted as already accounted for within this same drop.
  await expect(page.getByTestId('import-totals')).toContainText('22 new')
  await expect(page.getByTestId('import-totals')).toContainText('3 already in your record')

  await page.getByTestId('import-commit').click()
  await expect(page.getByTestId('import-done')).toContainText('22')

  await page.getByTestId('import-view-timeline').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Appendectomy' })).toBeVisible()

  // The dedup promise, end to end: re-dropping the exact same files finds
  // every fact already in the log.
  await goToImport(page)
  await page.getByTestId('import-file-input').setInputFiles([XDM_ZIP, FHIR_BUNDLE])
  await expect(page.getByTestId('import-totals')).toContainText('0')
  // Every draft across both documents (16 C-CDA + 9 FHIR) is now in the log.
  await expect(page.getByTestId('import-totals')).toContainText('25 already in your record')

  // The verbatim source documents were pushed as doc- provenance blobs too
  // (see sync.ts's provenance codec) -- the outbox drains to empty either way.
  await waitForPushed(page)
})

test('opens an imported source document from the entry detail panel', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await goToImport(page)

  await page.getByTestId('import-file-input').setInputFiles([XDM_ZIP, FHIR_BUNDLE])
  await page.getByTestId('import-commit').click()
  await expect(page.getByTestId('import-done')).toContainText('22')
  await page.getByTestId('import-view-timeline').click()

  // "Temperature" (LOINC 8310-5) is only in the FHIR bundle, not the C-CDA
  // fixture, so its source document is unambiguously bundle-minimal.json.
  const trigger = page.getByTestId('spine-entry-trigger').filter({ hasText: 'Temperature' })
  await trigger.click()

  // The detail panel (`.stub-wrap`) is a DOM sibling of the row, not a
  // descendant of it (SpineEntry.svelte renders both as root elements), and
  // it's always present (even collapsed) so aria-controls resolves — scope
  // through that same id rather than `spine-entry`'s subtree.
  const stubId = await trigger.getAttribute('aria-controls')
  const sourceDocButton = page.locator(`#${stubId}`).getByTestId('spine-entry-source-doc')
  await sourceDocButton.click()

  await expect(page.getByTestId('viewer-text')).toContainText('Body temperature')
  await page.getByTestId('viewer-close').click()
  await expect(sourceDocButton).toBeFocused()
})
