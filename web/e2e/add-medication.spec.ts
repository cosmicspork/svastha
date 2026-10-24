import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI } from './helpers'

// "Add something I take" on the Medications page: one self-sourced statement
// carrying the name, the regimen beside it, and no duplicate for a name already
// on the list.

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

test('add a supplement and an as-needed inhaler, and refuse a duplicate', async ({ page }) => {
  await onboardViaUI(page)
  await page.evaluate(() => (window.location.hash = '#/medications'))
  await expect(page.getByTestId('medications-page')).toBeVisible()

  await addMedication(page, { name: 'Magnesium glycinate', dose: '400 mg', schedule: 'Nightly', route: 'mouth' })
  const magnesium = row(page, 'Magnesium glycinate')
  await expect(magnesium.getByTestId('summary-origin')).toHaveText('added by you')
  await expect(magnesium.getByTestId('summary-frequency')).toHaveText('Nightly')
  await expect(magnesium).toContainText('400 mg')
  // Filed on its route's shelf, among the other medications — not a separate
  // supplements section.
  await expect(page.getByTestId('summary-section-by-mouth').getByTestId('summary-row')).toHaveCount(1)

  await addMedication(page, { name: 'Albuterol inhaler', route: 'inhaled', asNeeded: true })
  await expect(row(page, 'Albuterol inhaler').getByTestId('summary-prn-chip')).toBeVisible()

  // The same name again is not a second medication: the sheet offers the
  // existing one's details instead of writing a duplicate statement.
  await page.getByTestId('medications-add').click()
  await page.getByTestId('add-med-name').fill('Magnesium glycinate')
  await expect(page.getByTestId('add-med-duplicate')).toBeVisible()
  await expect(page.getByTestId('add-med-save')).toBeDisabled()
  await page.getByTestId('add-med-edit-existing').click()
  await expect(page.getByTestId('row-action-sheet')).toBeVisible()
  await expect(page.getByTestId('action-dose-input')).toHaveValue('400 mg')
  await page.getByTestId('action-cancel').click()

  // One statement each, carrying the name and nothing else; the dose and
  // schedule live in curation, so changing them later never moves the concept.
  const statements = await page.evaluate(async () => {
    const { allEvents } = await import('/src/lib/events.ts')
    return (await allEvents()).map((se) => ({ kind: se.event.kind, value: se.event.value, source: se.event.provenance.source }))
  })
  expect(statements).toHaveLength(2)
  expect(statements).toContainEqual({ kind: 'medication_statement', value: { text: 'Magnesium glycinate' }, source: 'self' })
  expect(statements).toContainEqual({ kind: 'medication_statement', value: { text: 'Albuterol inhaler' }, source: 'self' })

  // The summary lists them like any medication.
  await page.evaluate(() => (window.location.hash = '#/summary'))
  await expect(page.getByTestId('summary-section-medications')).toContainText('Magnesium glycinate')
  await expect(page.getByTestId('summary-section-as-needed')).toContainText('Albuterol inhaler')
})
