import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, openLog, connectRelayViaUI, PASSPHRASE } from './helpers'

// Work history end to end: log a job and its exposures through the real form,
// see the "Work & exposures" section on the summary, mark the job past (a
// signed `status:` record keyed on the job's value-keyed concept), and see both
// in a doctor-share preview, which a default scope must include.

async function openSummary(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/summary'
  })
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
}

test('log a job with exposures, see it on the summary, mark it past, and share it', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)

  // A lab result and an immunization, so the section's position is observable.
  await page.evaluate(async () => {
    const { logEvent } = await import('/src/lib/events.ts')
    const now = new Date().toISOString()
    await logEvent([
      {
        kind: 'observation',
        code: { system: 'http://loinc.org', code: '2093-3', display: 'Cholesterol' },
        effective_at: now,
        value: { quantity: { value: '5.1', unit: null } },
      },
      { kind: 'immunization', effective_at: now, value: { text: 'flu shot' } },
    ])
  })

  await openLog(page, 'work')
  await page.getByTestId('work-title').fill('Welder')
  await page.getByTestId('work-year').fill('2019')
  await page.getByTestId('work-exposure').filter({ hasText: 'asbestos' }).click()
  await page.getByTestId('work-exposure-input').fill('fumes')
  await page.getByTestId('work-exposure-input').press('Enter')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-toast')).toBeVisible()

  // A second job in the same start year must not steal the first's exposures.
  await openLog(page, 'work')
  await page.getByTestId('work-title').fill('Cook')
  await page.getByTestId('work-year').fill('2019')
  await page.getByTestId('work-exposure').filter({ hasText: 'noise' }).click()
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-toast')).toBeVisible()

  await openSummary(page)
  const section = page.getByTestId('summary-section-work-&-exposures')
  await expect(section).toBeVisible()
  const welder = section.getByTestId('summary-row').filter({ hasText: 'Welder' })
  await expect(welder).toContainText('since 2019')
  await expect(welder).toContainText('asbestos, fumes')
  await expect(welder.getByTestId('summary-status-chip')).toHaveText('current')
  const cook = section.getByTestId('summary-row').filter({ hasText: 'Cook' })
  await expect(cook).toContainText('noise')
  await expect(cook).not.toContainText('asbestos')

  // Placement: between Recent results and Immunizations (design review D6).
  const order = await page
    .locator('[data-testid^="summary-section-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  const at = order.indexOf('summary-section-work-&-exposures')
  expect(at).toBeGreaterThan(order.indexOf('summary-section-recent-results'))
  expect(at).toBeLessThan(order.indexOf('summary-section-immunizations'))
  await expect(page.getByTestId('summary-section-recent-results')).not.toContainText('Welder')

  // Mark the welder job past through the row action sheet.
  const trigger = welder.getByTestId('summary-row-trigger')
  await trigger.click()
  await welder.getByTestId('summary-row-curate').click()
  await expect(page.getByTestId('action-toggle-status')).toHaveText('Mark as past')
  await page.getByTestId('action-toggle-status').click()
  await expect(welder.getByTestId('summary-status-chip')).toHaveText('past')
  await expect(cook.getByTestId('summary-status-chip')).toHaveText('current')

  // Persists across a reload.
  await page.reload()
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
  await openSummary(page)
  await expect(
    page
      .getByTestId('summary-section-work-&-exposures')
      .getByTestId('summary-row')
      .filter({ hasText: 'Welder' })
      .getByTestId('summary-status-chip'),
  ).toHaveText('past')

  // A default-scope doctor share previews the section, past chip included.
  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('share-preview-toggle').click()
  const preview = page.getByTestId('share-preview')
  const shared = preview.getByTestId('summary-section-work-&-exposures')
  await expect(shared).toBeVisible()
  await expect(shared.getByTestId('summary-row').filter({ hasText: 'Welder' })).toContainText('asbestos, fumes')
  await expect(
    shared.getByTestId('summary-row').filter({ hasText: 'Welder' }).getByTestId('summary-status-chip'),
  ).toHaveText('past')
})
