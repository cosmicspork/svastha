import { test, expect, type Browser, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, openLog } from './helpers'

// "I take this" versus "I took this": a standing medication added on the
// Medications page, and doses logged against it (and against nothing) from the
// Meds form — through the real signing path, onto every surface that lists a
// medication, and out through a doctor share.

const row = (page: Page, name: string) => page.getByTestId('summary-row').filter({ hasText: name })

async function addMedication(
  page: Page,
  fields: { name: string; dose?: string; schedule?: string; route?: string; asNeeded?: boolean },
): Promise<void> {
  await page.getByTestId('medications-add').click()
  await expect(page.getByTestId('add-med-sheet')).toBeVisible()
  await page.getByTestId('add-med-name').fill(fields.name)
  if (fields.dose) await page.getByTestId('add-med-dose').fill(fields.dose)
  if (fields.schedule) await page.getByTestId('add-med-schedule').fill(fields.schedule)
  if (fields.route) await page.getByTestId('add-med-route').selectOption(fields.route)
  if (fields.asNeeded) await page.getByTestId('add-med-as-needed').check()
  await page.getByTestId('add-med-save').click()
  await expect(page.getByTestId('add-med-sheet')).toHaveCount(0)
}

async function openMedications(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/medications'))
  await expect(page.getByTestId('medications-page')).toBeVisible()
}

/** Log a dose of a listed medication by its chip, optionally days in the past. */
async function logChipDose(page: Page, name: string, daysAgo = 0): Promise<void> {
  await openLog(page, 'med')
  await page.getByTestId('dose-med-chip').filter({ hasText: name }).click()
  if (daysAgo > 0) {
    await page.getByTestId('time-earlier').click()
    const earlier = await page.evaluate(async (days) => {
      const { toLocalIso } = await import('/src/lib/time.ts')
      return toLocalIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000)).slice(0, 16)
    }, daysAgo)
    await page.getByTestId('effective-at').fill(earlier)
  }
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-toast')).toBeVisible()
  // The form lands on the timeline once the toast has been read.
  await page.waitForURL(/#\/timeline$/)
}

async function mintShare(page: Page): Promise<string> {
  await page.evaluate(() => (window.location.hash = '#/share/doctor'))
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  return (await page.getByTestId('share-link').innerText()).trim()
}

async function openAsRecipient(browser: Browser, link: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({ timeout: 15_000 })
  return page
}

test('log doses of a medication you take and of a one-off, and share them', async ({ page, browser }) => {
  await onboardViaUI(page)
  await openMedications(page)

  // Two standing medications, added the way the owner adds them (see
  // add-medication.spec.ts for the sheet itself).
  await addMedication(page, { name: 'Magnesium glycinate', dose: '400 mg', schedule: 'Nightly', route: 'mouth' })
  await addMedication(page, { name: 'Albuterol inhaler', route: 'inhaled', asNeeded: true })
  await expect(row(page, 'Albuterol inhaler').getByTestId('summary-prn-chip')).toBeVisible()

  // --- "Took a dose" from the form's chip: two doses of the inhaler ---
  await logChipDose(page, 'Albuterol inhaler', 3)
  await logChipDose(page, 'Albuterol inhaler')
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Took Albuterol inhaler' }).first()).toBeVisible()

  // --- a one-off, typed by hand ---
  await openLog(page, 'med')
  await page.getByTestId('med-name').fill('Ibuprofen')
  await page.getByTestId('save').click()
  // Same minute as the inhaler's second dose, so they share a row; the
  // statements added earlier keep rows of their own.
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Ibuprofen' })).toContainText('Took ')

  // The form wrote doses — never a statement — copying the standing med's text.
  const kinds = await page.evaluate(async () => {
    const { allEvents } = await import('/src/lib/events.ts')
    return (await allEvents())
      .filter((se) => se.event.kind === 'medication_dose')
      .map((se) => (se.event.value && 'text' in se.event.value ? se.event.value.text : null))
      .sort()
  })
  expect(kinds).toEqual(['Albuterol inhaler', 'Albuterol inhaler', 'Ibuprofen'])

  // --- the summary: usage line on the standing med, the one-off under Taken recently ---
  await page.evaluate(() => (window.location.hash = '#/summary'))
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
  await expect(
    page.getByTestId('summary-section-as-needed').getByTestId('summary-row').filter({ hasText: 'Albuterol inhaler' }).getByTestId('summary-usage'),
  ).toHaveText('Used 2× in the last 30 days · last today')
  await expect(row(page, 'Magnesium glycinate').getByTestId('summary-usage')).toHaveCount(0)
  const taken = page.getByTestId('summary-section-taken-recently')
  await expect(taken.getByTestId('summary-row')).toHaveCount(1)
  await expect(taken.getByTestId('summary-row')).toContainText('Ibuprofen')
  await expect(taken.getByTestId('summary-usage')).toHaveText('1 dose in 30 days · last today')
  // Ibuprofen is not something the person is on.
  await expect(page.getByTestId('summary-section-medications')).not.toContainText('Ibuprofen')

  // --- the Medications page and the pharmacy list agree ---
  await openMedications(page)
  await expect(page.getByTestId('summary-section-taken-recently')).toContainText('Ibuprofen')
  await page.getByTestId('medications-pharmacy-link').click()
  await expect(page.getByTestId('pharmacy-row')).toHaveCount(2)
  await expect(page.getByTestId('pharmacy-row').filter({ hasText: 'Albuterol inhaler' }).getByTestId('pharmacy-usage')).toHaveText(
    'Used 2× in the last 30 days · last today',
  )
  await expect(page.getByTestId('pharmacy-taken-row')).toHaveCount(1)
  await expect(page.getByTestId('pharmacy-taken-name')).toHaveText('Ibuprofen')

  // --- a doctor share: meds and doses only, so the recipient gets the pharmacy view ---
  await connectRelayViaUI(page)
  const medsLink = await mintShare(page)
  const medsDoc = await openAsRecipient(browser, medsLink)
  await expect(medsDoc.getByTestId('pharmacy-list')).toBeVisible()
  await expect(medsDoc.getByTestId('pharmacy-row')).toHaveCount(2)
  await expect(
    medsDoc.getByTestId('pharmacy-row').filter({ hasText: 'Albuterol inhaler' }).getByTestId('pharmacy-usage'),
  ).toHaveText('Used 2× in the last 30 days · last today')
  await expect(medsDoc.getByTestId('pharmacy-row').filter({ hasText: 'Magnesium glycinate' })).toContainText('Nightly')
  await expect(medsDoc.getByTestId('pharmacy-taken-name')).toHaveText('Ibuprofen')
  await medsDoc.context().close()

  // --- with something else in the record, the recipient gets the summary ---
  await page.evaluate(() => (window.location.hash = '#/timeline'))
  await logBP(page, '118', '76')
  const fullLink = await mintShare(page)
  const fullDoc = await openAsRecipient(browser, fullLink)
  await expect(fullDoc.getByTestId('clinician-summary')).toBeVisible()
  await expect(
    fullDoc.getByTestId('summary-row').filter({ hasText: 'Albuterol inhaler' }).getByTestId('summary-usage'),
  ).toHaveText('Used 2× in the last 30 days · last today')
  await expect(fullDoc.getByTestId('summary-section-taken-recently')).toContainText('Ibuprofen')
  await expect(fullDoc.getByTestId('summary-row').filter({ hasText: 'Magnesium glycinate' }).getByTestId('summary-origin')).toHaveText(
    'added by you',
  )
  await fullDoc.context().close()
})

test('an old Meds favorite logs a dose, and the stored favorite is left as it was', async ({ page }) => {
  await onboardViaUI(page)
  // A favorite saved by the form before it logged doses: a statement template.
  await page.evaluate(async () => {
    const { addFavorite } = await import('/src/lib/favorites.ts')
    await addFavorite({
      label: 'Ibuprofen 400 mg',
      category: 'med',
      drafts: [{ kind: 'medication_statement', value: { text: 'Ibuprofen — 400 mg' } }],
    })
  })
  await openLog(page, 'med')
  await page.getByTestId('favorite-instant').click()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Took Ibuprofen — 400 mg' })).toBeVisible()

  const after = await page.evaluate(async () => {
    const { allEvents } = await import('/src/lib/events.ts')
    const { listFavorites } = await import('/src/lib/favorites.ts')
    return {
      kinds: (await allEvents()).map((se) => se.event.kind),
      favorite: (await listFavorites('med'))[0].drafts[0].kind,
    }
  })
  expect(after.kinds).toEqual(['medication_dose'])
  expect(after.favorite).toBe('medication_statement')
})
