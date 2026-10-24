import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, PASSPHRASE } from './helpers'

// How often each medication is taken, on every surface that lists one: the
// owner's own schedule wins, else the record's dosage ("As prescribed"), else
// an explicit gap. Dosages are signed through the real wasm path, so core
// validates every string seeded here.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

const NO_DOSAGE_FIELDS = {
  dose: null,
  text: null,
  frequency: null,
  period: null,
  period_unit: null,
  when: null,
  as_needed: null,
}

async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, none }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      const med = (code: string, display: string, value: unknown) => ({
        kind: 'medication_statement' as const,
        code: { system: rxnorm, code, display },
        effective_at: '2024-02-01T00:00:00+00:00',
        value: value as never,
      })
      await logEvent([
        // Structured timing only: rendered, not typed out by anyone.
        med('29046', 'Lisinopril', {
          dosage: { ...none, frequency: '2', period: '1', period_unit: 'd', when: 'AC' },
        }),
        // Has a record sig AND an owner schedule (set through the sheet below).
        med('6809', 'Metformin', { dosage: { ...none, text: 'Take 1 tablet twice daily' } }),
        // A dose and nothing about timing.
        med('11289', 'Warfarin', {
          dosage: {
            ...none,
            dose: { value: '5', unit: { system: 'http://unitsofmeasure.org', code: 'mg' } },
          },
        }),
        med('723', 'Amoxicillin', null),
      ])
    },
    { rxnorm: RXNORM, none: NO_DOSAGE_FIELDS },
  )
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

const row = (page: Page, name: string) =>
  page.getByTestId('summary-row').filter({ hasText: name })

/** Owner sets Metformin's schedule through the row's action sheet. */
async function curateMetformin(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/summary'))
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
  const metformin = row(page, 'Metformin')
  await metformin.getByTestId('summary-row-trigger').click()
  await metformin.getByTestId('summary-row-curate').click()
  await page.getByTestId('action-schedule-input').fill('Morning and evening')
  await page.getByTestId('action-save').click()
  await expect(page.getByTestId('row-action-sheet')).toHaveCount(0)
}

test('frequency chain on the summary, medications page and pharmacy list', async ({ page }) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await curateMetformin(page)

  // --- summary ---
  await expect(row(page, 'Metformin').getByTestId('summary-frequency')).toHaveText('Morning and evening')
  await expect(row(page, 'Lisinopril').getByTestId('summary-frequency')).toHaveText(
    'As prescribed: twice daily, before meals',
  )
  // A bare dose says nothing about timing, so it is a gap, as is no dosage.
  await expect(row(page, 'Warfarin').getByTestId('summary-frequency-missing')).toHaveText('Frequency not recorded')
  await expect(row(page, 'Amoxicillin').getByTestId('summary-frequency-missing')).toHaveText('Frequency not recorded')
  // Seeded through logEvent, so the owner logged them.
  await expect(row(page, 'Lisinopril').getByTestId('summary-origin')).toHaveText('added by you')

  // The gap is a tap target for the owner and opens the regimen editor.
  await row(page, 'Warfarin').getByTestId('summary-frequency-missing').click()
  await expect(page.getByTestId('row-action-sheet')).toBeVisible()
  await expect(page.getByTestId('action-schedule-input')).toBeVisible()
  // Tapping it did not also expand the row.
  await expect(row(page, 'Warfarin').getByTestId('summary-row-trigger')).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-action-sheet')).toHaveCount(0)

  // The prescriber is in the panel only, never on the row face.
  await expect(row(page, 'Metformin').getByTestId('summary-frequency-line')).not.toContainText('Dr.')

  // --- medications page ---
  await page.evaluate(() => (window.location.hash = '#/medications'))
  await expect(page.getByTestId('medications-page')).toBeVisible()
  await expect(row(page, 'Metformin').getByTestId('summary-frequency')).toHaveText('Morning and evening')
  await expect(row(page, 'Lisinopril').getByTestId('summary-frequency')).toHaveText(
    'As prescribed: twice daily, before meals',
  )
  await expect(row(page, 'Warfarin').getByTestId('summary-frequency-missing')).toBeVisible()

  // --- pharmacy list ---
  await page.getByTestId('medications-pharmacy-link').click()
  await expect(page.getByTestId('pharmacy-list')).toBeVisible()
  const pharm = (name: string) => page.getByTestId('pharmacy-row').filter({ hasText: name })
  await expect(pharm('Metformin').getByTestId('pharmacy-sig')).toHaveText('Morning and evening')
  await expect(pharm('Lisinopril').getByTestId('pharmacy-sig')).toHaveText(
    'As prescribed: twice daily, before meals',
  )
  await expect(pharm('Warfarin').getByTestId('pharmacy-frequency-missing')).toHaveText(
    'Frequency not recorded — ask',
  )
  await expect(pharm('Warfarin').getByTestId('pharmacy-sig')).toHaveCount(0)
})

test('a doctor-share recipient sees the record dosage and a plain gap', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  await onboardViaUI(owner)
  await seed(owner)
  // A vital keeps the share from being a meds-only (pharmacy) handoff.
  await logBP(owner, '120', '80')
  await connectRelayViaUI(owner)
  await owner.evaluate(() => (window.location.hash = '#/share/doctor'))
  await owner.getByTestId('new-doctor-link').click()
  await owner.getByTestId('share-create').click()
  await expect(owner.getByTestId('share-link')).toBeVisible()
  const link = (await owner.getByTestId('share-link').innerText()).trim()

  const context = await browser.newContext()
  const doc = await context.newPage()
  await doc.goto(link)
  await expect(doc.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({ timeout: 15_000 })

  await expect(row(doc, 'Lisinopril').getByTestId('summary-frequency')).toHaveText(
    'As prescribed: twice daily, before meals',
  )
  await expect(row(doc, 'Metformin').getByTestId('summary-frequency')).toHaveText(
    'As prescribed: Take 1 tablet twice daily',
  )
  // Provenance rides in the bundle, so the recipient sees the same chip.
  await expect(row(doc, 'Lisinopril').getByTestId('summary-origin')).toHaveText('added by you')
  // The gap reads as plain text: no affordance for someone who cannot edit.
  const gap = row(doc, 'Warfarin').getByTestId('summary-frequency-missing')
  await expect(gap).toHaveText('Frequency not recorded')
  await expect(gap).not.toHaveAttribute('role', 'button')
  await expect(doc.locator('[data-testid="summary-frequency-missing"][role="button"]')).toHaveCount(0)

  await context.close()
  await ownerContext.close()
})
