import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, PASSPHRASE } from './helpers'

// The Summary page as a visit-time reference: medications in name order with
// their dose, sections windowed to the last year, codes off the face and behind
// a short press, and a row that can jump to its place on the timeline.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
const CVX = 'http://hl7.org/fhir/sid/cvx'

/** Dates are seeded relative to the machine clock, since the recency window is
 * "the last 12 months from now" — fixed fixture dates would age out. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, cvx, recent, refill, older, ancient }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      await logEvent([
        // Three meds, seeded newest-name-last so date order and name order
        // disagree: Zolpidem is the most recent, amoxicillin the oldest.
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '39786', display: 'Zolpidem' },
          effective_at: recent,
          value: null,
        },
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '723', display: 'amoxicillin' },
          effective_at: older,
          value: null,
        },
        // The dose is on the earlier statement; the later refill carries none.
        {
          kind: 'medication_statement',
          code: { system: rxnorm, code: '29046', display: 'Lisinopril' },
          effective_at: older,
          value: { quantity: { value: '10', unit: { system: 'http://unitsofmeasure.org', code: 'mg' } } },
        },
        {
          // A day of its own: the timeline folds same-day meds into one entry,
          // and the focus assertion below needs Zolpidem's own row.
          kind: 'medication_statement',
          code: { system: rxnorm, code: '29046', display: 'Lisinopril' },
          effective_at: refill,
          value: null,
        },
        {
          kind: 'immunization',
          code: { system: cvx, code: '140', display: 'Influenza' },
          effective_at: recent,
          value: null,
        },
        {
          kind: 'immunization',
          code: { system: cvx, code: '115', display: 'Tdap' },
          effective_at: ancient,
          value: null,
        },
      ])
    },
    {
      rxnorm: RXNORM,
      cvx: CVX,
      recent: daysAgo(20),
      refill: daysAgo(25),
      older: daysAgo(200),
      ancient: daysAgo(1500),
    },
  )
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

async function openSummary(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/summary'
  })
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
}

function meds(page: Page) {
  return page.getByTestId('summary-section-medications').getByTestId('summary-row')
}

test('summary: alphabetical dosed meds, a windowed immunization list, and a row that opens', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  // --- medications: name order, not newest-first ---
  await expect(meds(page).getByTestId('summary-label')).toHaveText([
    'amoxicillin',
    'Lisinopril',
    'Zolpidem',
  ])

  // --- the dose survives a later dose-less refill ---
  const lisinopril = meds(page).filter({ hasText: 'Lisinopril' })
  await expect(lisinopril).toContainText('10 mg')

  // --- codes are off the face, behind a short press ---
  const trigger = lisinopril.getByTestId('summary-row-trigger')
  await expect(trigger).not.toContainText('RxNorm')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(lisinopril.getByTestId('summary-coding')).toContainText('RxNorm 29046')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  // --- immunizations: the last year leads, older sits behind a toggle ---
  const immunizations = page.getByTestId('summary-section-immunizations')
  await expect(immunizations.getByTestId('summary-label')).toHaveText(['Influenza'])
  const olderToggle = page.getByTestId('immunizations-older-toggle')
  await expect(olderToggle).toContainText('1')
  await expect(page.getByTestId('summary-section-earlier-immunizations')).toHaveCount(0)
  await olderToggle.click()
  await expect(
    page.getByTestId('summary-section-earlier-immunizations').getByTestId('summary-label'),
  ).toHaveText(['Tdap'])
})

test('summary: filter narrows every section, reaching rows inside collapsed groups', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  await page.getByTestId('summary-filter').fill('zolp')
  await expect(meds(page).getByTestId('summary-label')).toHaveText(['Zolpidem'])
  await expect(page.getByTestId('summary-section-immunizations')).toHaveCount(0)

  // A match that only exists behind the "older" toggle still surfaces.
  await page.getByTestId('summary-filter').fill('tdap')
  await expect(
    page.getByTestId('summary-section-earlier-immunizations').getByTestId('summary-label'),
  ).toHaveText(['Tdap'])

  await page.getByTestId('summary-filter').fill('nothing matches this')
  await expect(page.getByTestId('summary-no-match')).toBeVisible()

  await page.getByTestId('summary-filter').fill('')
  await expect(meds(page)).toHaveCount(3)
})

test('summary: a row jumps to its own entry on the timeline', async ({ page }) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  const zolpidem = meds(page).filter({ hasText: 'Zolpidem' })
  await zolpidem.getByTestId('summary-row-trigger').click()
  await zolpidem.getByTestId('summary-row-timeline').click()

  await expect(page).toHaveURL(/#\/timeline$/)
  const highlighted = page.locator('[data-testid="spine-entry"][data-highlighted="true"]')
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toContainText('Zolpidem')
})
