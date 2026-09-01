import { test, expect, type Locator, type Page } from '@playwright/test'
import { onboardViaUI, PASSPHRASE } from './helpers'

// The medications page (`#/medications`): the whole med list filed by route,
// with as-needed as a chip rather than a shelf and past meds folded away.
// Shelving reads the owner's `regimen:` curation and nothing else — the app
// never parses a route out of a drug name — so an unfiled med sits in the
// unlabelled catch-all at the top until someone files it.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

/** Four coded meds, seeded through the real signing path. Named so that route
 * order and alphabetical order disagree — a page that merely echoed the fold
 * would pass an order assertion by accident. */
async function seedMeds(page: Page): Promise<void> {
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
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '39786', display: 'Zolpidem' },
          effective_at: '2024-03-01T00:00:00+00:00',
          value: null,
        },
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '723', display: 'Amoxicillin' },
          effective_at: '2024-04-01T00:00:00+00:00',
          value: null,
        },
      ])
    },
    { rxnorm: RXNORM },
  )
}

/** Write the regimen curation directly: the sheet's own path is covered by
 * summary-status.spec.ts and by the assign-a-route test below, so the shelf
 * tests seed state rather than re-driving eight form fields four times. */
async function seedRegimens(
  page: Page,
  entries: Record<string, { route?: string; as_needed?: boolean; schedule?: string; prescriber?: string }>,
): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, entries }) => {
      const { setRegimen } = await import('/src/lib/curation.ts')
      for (const [code, regimen] of Object.entries(entries)) {
        await setRegimen(`medication_statement|${rxnorm}|${code}`, regimen)
      }
    },
    { rxnorm: RXNORM, entries },
  )
}

async function setStatusFor(page: Page, code: string, status: 'active' | 'inactive'): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, code, status }) => {
      const { setStatus } = await import('/src/lib/curation.ts')
      await setStatus(`medication_statement|${rxnorm}|${code}`, status)
    },
    { rxnorm: RXNORM, code, status },
  )
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

async function openMedications(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/medications'
  })
  await expect(page.getByTestId('medications-page')).toBeVisible()
}

/** The page's shelves, in DOM order, by their accessible heading text. A shelf
 * heading is a SummarySection h3 — the catch-all's is visually hidden but still
 * in the tree, which is exactly the guarantee `headingHidden` claims. */
function shelfHeadings(page: Page): Locator {
  return page.getByTestId('medications-page').locator('h3')
}

function shelf(page: Page, testid: string): Locator {
  return page.getByTestId(testid).getByTestId('summary-row')
}

/** Expand a row and open its curation sheet from the panel. */
async function openCurate(row: Locator): Promise<void> {
  await row.getByTestId('summary-row-trigger').click()
  await row.getByTestId('summary-row-curate').click()
  await expect(row.page().getByTestId('row-action-sheet')).toBeVisible()
}

test('medications page: route shelves in fixed order, alphabetical within', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  // Seeded out of both route order and name order.
  await seedRegimens(page, {
    '723': { route: 'skin' }, // Amoxicillin
    '6809': { route: 'mouth' }, // Metformin
    '29046': { route: 'mouth' }, // Lisinopril
    '39786': { route: 'nose' }, // Zolpidem
  })
  await page.reload()
  await unlock(page)
  await openMedications(page)

  await expect(shelfHeadings(page)).toHaveText(['By mouth', 'Nose', 'Skin'])
  await expect(shelf(page, 'summary-section-by-mouth').getByTestId('summary-label')).toHaveText([
    'Lisinopril',
    'Metformin',
  ])
  await expect(shelf(page, 'summary-section-nose').getByTestId('summary-label')).toHaveText([
    'Zolpidem',
  ])
  await expect(shelf(page, 'summary-section-skin').getByTestId('summary-label')).toHaveText([
    'Amoxicillin',
  ])
  // Shelves nothing is filed on do not render as empty headings.
  await expect(page.getByTestId('summary-section-eyes')).toHaveCount(0)
  await expect(page.getByTestId('summary-section-other')).toHaveCount(0)
  // Nothing unrouted, so no catch-all and no caption.
  await expect(page.getByTestId('summary-section-needs-a-route')).toHaveCount(0)
  await expect(page.getByTestId('medications-unrouted-caption')).toHaveCount(0)
})

test('medications page: unrouted meds lead in an unlabelled catch-all, and a route files them', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, { '6809': { route: 'mouth' } }) // Metformin only
  await page.reload()
  await unlock(page)
  await openMedications(page)

  const catchAll = page.getByTestId('summary-section-needs-a-route')
  await expect(catchAll.getByTestId('summary-label')).toHaveText([
    'Amoxicillin',
    'Lisinopril',
    'Zolpidem',
  ])
  // The catch-all is first in the DOM: the unfiled meds are the ones asking for
  // attention, not the leftovers.
  await expect(page.getByTestId('medications-page').locator('section').first()).toHaveAttribute(
    'data-testid',
    'summary-section-needs-a-route',
  )
  // Its heading is unlabelled on screen but present for a screen reader.
  const catchAllHeading = catchAll.locator('h3')
  await expect(catchAllHeading).toHaveText('Needs a route')
  await expect(catchAllHeading).not.toBeInViewport()
  await expect(page.getByTestId('medications-unrouted-caption')).toContainText('No route set')

  // --- assigning a route moves the row onto its shelf ---
  await openCurate(catchAll.getByTestId('summary-row').filter({ hasText: 'Zolpidem' }))
  await page.getByTestId('action-route-select').selectOption('inhaled')
  await page.getByTestId('action-save').click()

  await expect(catchAll.getByTestId('summary-label')).toHaveText(['Amoxicillin', 'Lisinopril'])
  await expect(shelf(page, 'summary-section-inhaled').getByTestId('summary-label')).toHaveText([
    'Zolpidem',
  ])
  // And it stays filed — the regimen is a signed `cur-` record on disk.
  await page.reload()
  await unlock(page)
  await openMedications(page)
  await expect(shelf(page, 'summary-section-inhaled').getByTestId('summary-label')).toHaveText([
    'Zolpidem',
  ])
})

test('medications page: as-needed is a chip on a current row, never a shelf of its own', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, {
    '39786': { route: 'mouth', as_needed: true, schedule: 'At bedtime', prescriber: 'Dr. Rivera' },
    '29046': { route: 'mouth' },
  })
  await page.reload()
  await unlock(page)
  await openMedications(page)

  const zolpidem = shelf(page, 'summary-section-by-mouth').filter({ hasText: 'Zolpidem' })
  await expect(zolpidem).toHaveCount(1)
  await expect(zolpidem.getByTestId('summary-prn-chip')).toContainText('As needed')
  // The sub-line carries schedule and prescriber, joined — not a second row.
  await expect(zolpidem.getByTestId('summary-regimen-subline')).toHaveText('At bedtime · Dr. Rivera')
  // A scheduled med on the same shelf carries neither.
  const lisinopril = shelf(page, 'summary-section-by-mouth').filter({ hasText: 'Lisinopril' })
  await expect(lisinopril.getByTestId('summary-prn-chip')).toHaveCount(0)
  await expect(lisinopril.getByTestId('summary-regimen-subline')).toHaveCount(0)
  // No "As needed" shelf exists on this page — the chip is the whole story.
  await expect(page.getByTestId('summary-section-as-needed')).toHaveCount(0)
  await expect(page.getByTestId('page-past-toggle')).toHaveCount(0)
})

test('medications page: past meds fold behind a toggle and a row jumps to the timeline', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, { '723': { route: 'mouth', as_needed: true } })
  // An as-needed med marked past is past: the chip does not out-vote status.
  await setStatusFor(page, '723', 'inactive')
  await setStatusFor(page, '6809', 'inactive')
  await page.reload()
  await unlock(page)
  await openMedications(page)

  await expect(shelf(page, 'summary-section-by-mouth')).toHaveCount(0)
  const toggle = page.getByTestId('page-past-toggle')
  await expect(toggle).toContainText('2 past')
  await expect(page.getByTestId('summary-section-past')).toBeHidden()
  await toggle.click()
  await expect(shelf(page, 'summary-section-past').getByTestId('summary-label')).toHaveText([
    'Amoxicillin',
    'Metformin',
  ])

  // --- a row jumps to its own entry on the timeline, focused ---
  const lisinopril = page
    .getByTestId('summary-section-needs-a-route')
    .getByTestId('summary-row')
    .filter({ hasText: 'Lisinopril' })
  await lisinopril.getByTestId('summary-row-trigger').click()
  await lisinopril.getByTestId('summary-row-timeline').click()

  await expect(page).toHaveURL(/#\/timeline$/)
  const highlighted = page.locator('[data-testid="spine-entry"][data-highlighted="true"]')
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toContainText('Lisinopril')
})

test('medications page: printing reveals the collapsed past meds', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await setStatusFor(page, '6809', 'inactive')
  await page.reload()
  await unlock(page)
  await openMedications(page)

  const past = page.getByTestId('summary-section-past')
  await expect(past).toBeHidden()

  await page.emulateMedia({ media: 'print' })

  // Paper has no toggle, so a printed med list must carry the past group — the
  // group is in the DOM all along, hidden by a screen-only rule.
  await expect(past).toBeVisible()
  await expect(page.getByTestId('page-past-toggle')).toBeHidden()
  await expect(page.getByTestId('medications-print')).toBeHidden()

  await page.emulateMedia({ media: 'screen' })
  await expect(past).toBeHidden()
})
