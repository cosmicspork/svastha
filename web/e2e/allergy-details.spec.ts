import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, PASSPHRASE, RELAY } from './helpers'

// An allergy's category, reaction and severity are the owner's own record (import
// drops all three and the category is never guessed), so this drives the real
// action sheet and signing path, then follows the result to the summary, a cold
// doctor-share recipient, and the pharmacy list and PDF.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
const SNOMED = 'http://snomed.info/sct'

async function seedAllergies(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, snomed }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      const at = '2024-01-01T00:00:00+00:00'
      await logEvent([
        { kind: 'allergy_intolerance', code: null, effective_at: at, value: { coded: { system: rxnorm, code: '7980', display: 'Penicillin' } } },
        { kind: 'allergy_intolerance', code: null, effective_at: at, value: { coded: { system: snomed, code: '227493005', display: 'Cashew nuts' } } },
        { kind: 'allergy_intolerance', code: null, effective_at: at, value: { coded: { system: snomed, code: '111088007', display: 'Latex' } } },
      ])
    },
    { rxnorm: RXNORM, snomed: SNOMED },
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

function allergyRows(page: Page) {
  return page.getByTestId('summary-section-allergies').getByTestId('summary-row')
}

async function openRowSheet(page: Page, row: ReturnType<Page['getByTestId']>): Promise<void> {
  const trigger = row.getByTestId('summary-row-trigger')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await row.getByTestId('summary-row-curate').click()
  await expect(page.getByTestId('row-action-sheet')).toBeVisible()
}

async function describeAllergy(
  page: Page,
  name: string,
  d: { category: string; reaction: string; severity: string },
): Promise<void> {
  await openRowSheet(page, allergyRows(page).filter({ hasText: name }))
  await page.getByTestId(`action-allergy-category-${d.category}`).click()
  await page.getByTestId('action-allergy-reaction').fill(d.reaction)
  await page.getByTestId(`action-allergy-severity-${d.severity}`).click()
  await page.getByTestId('action-save').click()
  await expect(page.getByTestId('row-action-sheet')).toHaveCount(0)
}

async function expectSummaryShape(root: Page): Promise<void> {
  const section = root.getByTestId('summary-section-allergies')
  // Severe Cashew leads the flat order (Cashew, Penicillin, Latex) but the
  // groups split Medications / Other.
  await expect(section.getByTestId('summary-group-medications')).toHaveText('Medications')
  await expect(section.getByTestId('summary-group-other')).toHaveText('Other')
  const labels = section.getByTestId('summary-label')
  await expect.poll(() => labels.allInnerTexts()).toEqual(['Penicillin', 'Cashew nuts', 'Latex'])

  const cashew = allergyRows(root).filter({ hasText: 'Cashew nuts' })
  await expect(cashew.getByTestId('summary-severe-chip')).toHaveText('Severe')
  await expect(cashew.getByTestId('summary-allergy-line')).toHaveText('Food · throat swelling')

  // Moderate is panel-only; the face carries no chip.
  const penicillin = allergyRows(root).filter({ hasText: 'Penicillin' })
  await expect(penicillin.getByTestId('summary-severe-chip')).toHaveCount(0)
  await expect(penicillin.getByTestId('summary-allergy-line')).toHaveText('rash')
  await expect(penicillin.getByTestId('summary-allergy-severity')).toContainText('Moderate')

  await expect(allergyRows(root).filter({ hasText: 'Latex' }).getByTestId('summary-allergy-line')).toHaveText(
    'Not categorized',
  )
}

test('record an allergy\'s details; they order the summary, persist, and reach a share and the pharmacy list', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const page = await ownerContext.newPage()
  await onboardViaUI(page)
  await seedAllergies(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  // Nothing categorized yet: alphabetical, and no sub-headings.
  await expect.poll(() => allergyRows(page).getByTestId('summary-label').allInnerTexts()).toEqual([
    'Cashew nuts',
    'Latex',
    'Penicillin',
  ])
  await expect(page.getByTestId('summary-group-medications')).toHaveCount(0)

  await describeAllergy(page, 'Cashew nuts', { category: 'food', reaction: 'throat swelling', severity: 'severe' })
  await describeAllergy(page, 'Penicillin', { category: 'medication', reaction: 'rash', severity: 'moderate' })
  await expectSummaryShape(page)

  // Persists: the details are signed `cur-` records, not view state.
  await page.reload()
  await unlock(page)
  await openSummary(page)
  await expectSummaryShape(page)

  // The sheet is seeded from what was saved.
  await openRowSheet(page, allergyRows(page).filter({ hasText: 'Cashew nuts' }))
  await expect(page.getByTestId('action-allergy-reaction')).toHaveValue('throat swelling')
  await expect(page.getByTestId('action-allergy-category-food')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('action-allergy-severity-severe')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('action-cancel').click()

  // Pharmacy list: reaction and severe marker, in the summary's order.
  await page.evaluate(() => {
    window.location.hash = '#/medications/pharmacy'
  })
  await expect(page.getByTestId('medications-pharmacy-page')).toBeVisible()
  const chips = page.getByTestId('pharmacy-allergy-chip')
  await expect
    .poll(() => chips.allInnerTexts())
    .toEqual(['Cashew nuts — throat swelling (severe)', 'Penicillin — rash', 'Latex'])

  await page.getByTestId('pharmacy-share').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('pharmacy-share-pdf').click()
  const download = await downloadPromise
  const bytes = (await import('node:fs')).readFileSync((await download.path())!)
  const text = await page.evaluate(async (data) => {
    const { textLayer } = await import('/src/lib/pdf.ts')
    const lines = await textLayer(new Uint8Array(data))
    return lines.map((l) => l.text).join(' ')
  }, [...bytes])
  expect(text).toContain('Cashew nuts — throat swelling (severe)')
  expect(text).toContain('Penicillin — rash')

  // A doctor share carries the details to a keyless recipient.
  await connectRelayViaUI(page)
  await page.evaluate(() => (window.location.hash = '#/share/doctor'))
  await page.getByTestId('new-doctor-link').click({ timeout: 15_000 })
  await page.getByTestId('share-preview-toggle').click()
  await expect(page.getByTestId('share-preview').getByTestId('summary-severe-chip')).toHaveCount(1)

  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  const [token, keySeg] = link.split('/#/s/')[1].split('.')
  const keys = await page.evaluate(
    async ({ relay, token, keySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0))
      }
      const sealed = new Uint8Array(await (await fetch(`${relay}/v0/share/${token}`)).arrayBuffer())
      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      const json = new TextDecoder().decode(key.open(sealed, new TextEncoder().encode(token)))
      return ((JSON.parse(json) as { curation?: { key: string }[] }).curation ?? []).map((r) => r.key).sort()
    },
    { relay: RELAY, token, keySeg },
  )
  expect(keys).toEqual([
    `allergy:allergy_intolerance|${SNOMED}|227493005`,
    `allergy:allergy_intolerance|${RXNORM}|7980`,
  ].sort())

  const context = await browser.newContext()
  const doc = await context.newPage()
  await doc.goto(link)
  await expect(doc.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({ timeout: 15_000 })
  await expectSummaryShape(doc)
  await expect(doc.getByTestId('share-curation-warning')).toHaveCount(0)

  await context.close()
  await ownerContext.close()
})
