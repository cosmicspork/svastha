import { test, expect, type Locator, type Page } from '@playwright/test'
import { onboardViaUI, PASSPHRASE } from './helpers'

// Owner-side curation over the clinician summary: mark a medication "past" and
// see it leave Current for the collapsed Past group (and stay there across a
// reload — the status is a signed `cur-` record on disk), then rename a concept
// and see the override lead the row with its source code demoted beneath it.
// Curation is owner-only, so this drives the real signing path end to end.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

/** Seed two coded medications straight through the signing path (the quick-log
 * form only writes free-text meds, which carry no code line to demote). */
async function seedCodedMeds(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rxnorm }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      await logEvent([
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '29046', display: 'Lisinopril' },
          effective_at: '2024-01-01T00:00:00+00:00',
          value: null,
        },
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '6809', display: 'Metformin' },
          effective_at: '2024-02-01T00:00:00+00:00',
          value: null,
        },
      ])
    },
    { rxnorm: RXNORM },
  )
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

async function openSummary(page: Page): Promise<void> {
  // Summary is its own page now (the Home view-toggle is gone).
  await page.evaluate(() => {
    window.location.hash = '#/summary'
  })
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
}

// The Current meds group is the SummarySection titled "Medications"; the Past
// group is its sibling, titled "Past". Both live under the (untestid'd)
// split-group wrapper.
function currentMeds(page: Page) {
  return page.getByTestId('summary-section-medications').getByTestId('summary-row')
}
function pastMeds(page: Page) {
  return page.getByTestId('summary-section-past').getByTestId('summary-row')
}

/** Expand a row and open its status/name sheet from the panel. */
async function openCurate(row: Locator): Promise<void> {
  await row.getByTestId('summary-row-trigger').click()
  await row.getByTestId('summary-row-curate').click()
  await expect(row.page().getByTestId('row-action-sheet')).toBeVisible()
}

test('curate the clinician summary: mark a med past (persistent) and rename a concept', async ({ page }) => {
  await onboardViaUI(page)
  await seedCodedMeds(page)

  // Reload so the freshly-seeded events hydrate the summary from IndexedDB.
  await page.reload()
  await unlock(page)
  await openSummary(page)

  await expect(currentMeds(page).filter({ hasText: 'Lisinopril' })).toHaveCount(1)
  await expect(currentMeds(page).filter({ hasText: 'Metformin' })).toHaveCount(1)

  // A short press expands the row; the action sheet is behind the panel's
  // curate button (or a swipe right).
  await openCurate(currentMeds(page).filter({ hasText: 'Lisinopril' }))
  await page.getByTestId('action-toggle-status').click()

  await expect(currentMeds(page).filter({ hasText: 'Lisinopril' })).toHaveCount(0)
  const pastToggle = page.getByTestId('meds-past-toggle')
  await expect(pastToggle).toContainText('1 past')
  await pastToggle.click()
  await expect(pastMeds(page).filter({ hasText: 'Lisinopril' })).toHaveCount(1)

  // --- persists across a reload (signed cur- record on disk) ---
  await page.reload()
  await unlock(page)
  await openSummary(page)
  await expect(currentMeds(page).filter({ hasText: 'Lisinopril' })).toHaveCount(0)
  await page.getByTestId('meds-past-toggle').click()
  await expect(pastMeds(page).filter({ hasText: 'Lisinopril' })).toHaveCount(1)

  await openCurate(currentMeds(page).filter({ hasText: 'Metformin' }))
  await page.getByTestId('action-name-input').fill('BP + sugar combo')
  await page.getByTestId('action-save').click()

  const renamed = currentMeds(page).filter({ hasText: 'BP + sugar combo' })
  await expect(renamed).toHaveCount(1)
  // The source code is off the row's face now, but still there in the panel —
  // still open from openCurate, since the rename kept the same concept key.
  // Visibility, not text: the face carries a print-only copy of the coding.
  const trigger = renamed.getByTestId('summary-row-trigger')
  await expect(renamed.getByTestId('summary-coding-print')).toBeHidden()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(renamed.getByTestId('summary-coding')).toContainText('RxNorm')
  await expect(renamed.getByTestId('summary-coding')).toContainText('6809')

  await page.reload()
  await unlock(page)
  await openSummary(page)
  await expect(currentMeds(page).filter({ hasText: 'BP + sugar combo' })).toHaveCount(1)
})

/** The `regimen:` curation keys currently in the vault — the diff-before-write
 * guard is only observable at this layer. */
async function regimenKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { allCurationByPrefix } = await import('/src/lib/curation.ts')
    return (await allCurationByPrefix('regimen:')).map((r: { key: string }) => r.key)
  })
}

test('edit a medication regimen from the action sheet', async ({ page }) => {
  await onboardViaUI(page)
  await seedCodedMeds(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  // A name-only save must not mint a regimen record: the sheet writes each
  // namespace only when its own value changed. Without that guard every rename
  // would push a fresh mutable `cur-` blob for a regimen nobody edited.
  await openCurate(currentMeds(page).filter({ hasText: 'Metformin' }))
  await page.getByTestId('action-name-input').fill('Metformin XR')
  await page.getByTestId('action-save').click()
  await expect(currentMeds(page).filter({ hasText: 'Metformin XR' })).toHaveCount(1)
  expect(await regimenKeys(page)).toEqual([])

  // --- fill a regimen ---
  // Either current group: ticking "as needed" moves the row from Medications to
  // the "As needed" sub-group beside it — same current status, different
  // heading — and clearing the field moves it back.
  const lisinopril = () =>
    page
      .getByTestId('summary-section-medications')
      .or(page.getByTestId('summary-section-as-needed'))
      .getByTestId('summary-row')
      .filter({ hasText: 'Lisinopril' })
  await openCurate(lisinopril())
  await page.getByTestId('action-dose-input').fill('2 tablets')
  await page.getByTestId('action-schedule-input').fill('Every morning')
  await page.getByTestId('action-route-select').selectOption('mouth')
  await page.getByTestId('action-as-needed').check()
  await page.getByTestId('action-prescriber-input').fill('Dr. Rivera')
  await page.getByTestId('action-started-input').fill('2024-03-01')
  await page.getByTestId('action-stopped-input').fill('2024-09-01')
  await page.getByTestId('action-instructions-input').fill('Take with food')
  await page.getByTestId('action-save').click()

  expect(await regimenKeys(page)).toHaveLength(1)

  // The curated dose leads the row (it outranks a recorded dose quantity), and
  // the panel — still open from openCurate — carries the rest.
  await expect(lisinopril()).toContainText('2 tablets')
  await expect(lisinopril().getByTestId('summary-regimen-schedule')).toContainText('Every morning')
  await expect(lisinopril().getByTestId('summary-regimen-route')).toContainText('By mouth')
  await expect(lisinopril().getByTestId('summary-regimen-as-needed')).toContainText('Yes')
  await expect(lisinopril().getByTestId('summary-regimen-prescriber')).toContainText('Dr. Rivera')
  await expect(lisinopril().getByTestId('summary-regimen-started')).toContainText('2024')
  await expect(lisinopril().getByTestId('summary-regimen-stopped')).toContainText('2024')
  await expect(lisinopril().getByTestId('summary-regimen-instructions')).toContainText('Take with food')

  // --- persists across a reload, and the sheet reopens seeded ---
  await page.reload()
  await unlock(page)
  await openSummary(page)
  await openCurate(lisinopril())
  await expect(page.getByTestId('action-dose-input')).toHaveValue('2 tablets')
  await expect(page.getByTestId('action-route-select')).toHaveValue('mouth')
  await expect(page.getByTestId('action-as-needed')).toBeChecked()
  await expect(page.getByTestId('action-started-input')).toHaveValue('2024-03-01')

  // Saving an untouched sheet is not an edit either.
  const before = await regimenKeys(page)
  await page.getByTestId('action-save').click()
  expect(await regimenKeys(page)).toEqual(before)

  // --- clearing every field removes the panel rows ---
  await openCurate(lisinopril())
  for (const field of [
    'action-dose-input',
    'action-schedule-input',
    'action-prescriber-input',
    'action-started-input',
    'action-stopped-input',
    'action-instructions-input',
  ]) {
    await page.getByTestId(field).fill('')
  }
  await page.getByTestId('action-route-select').selectOption('')
  await page.getByTestId('action-as-needed').uncheck()
  await page.getByTestId('action-save').click()

  await expect(lisinopril().getByTestId('summary-regimen-schedule')).toHaveCount(0)
  await expect(lisinopril().getByTestId('summary-regimen-route')).toHaveCount(0)
  await expect(lisinopril().getByTestId('summary-regimen-instructions')).toHaveCount(0)
})
