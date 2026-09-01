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
  // Visibility, not text: the face also carries a print-only copy of the
  // coding (see the print test below), which textContent would pick up.
  const trigger = lisinopril.getByTestId('summary-row-trigger')
  await expect(lisinopril.getByTestId('summary-coding-print')).toBeHidden()
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
  // Rendered but not shown — the print stylesheet reveals it (see the print
  // test below), so on screen it is hidden rather than absent.
  await expect(page.getByTestId('summary-section-earlier-immunizations')).toBeHidden()
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

test('summary: the printed page is the whole record, codes included', async ({ page }) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  const lisinopril = meds(page).filter({ hasText: 'Lisinopril' })
  const olderImmunizations = page.getByTestId('summary-section-earlier-immunizations')

  // On screen: codes are behind the panel and the older group is collapsed.
  await expect(lisinopril.getByTestId('summary-coding-print')).toBeHidden()
  await expect(olderImmunizations).toBeHidden()

  await page.emulateMedia({ media: 'print' })

  // On paper: the code is back on the row face — paper has no panel to open,
  // and forcing every panel open turns a one-page handoff into several.
  await expect(lisinopril.getByTestId('summary-coding-print')).toContainText('RxNorm 29046')
  await expect(lisinopril.getByTestId('summary-row-panel')).toBeHidden()

  // ...and the "older than a year" rows print even though the toggle that
  // reveals them on screen does not.
  await expect(olderImmunizations.getByTestId('summary-label')).toHaveText(['Tdap'])
  await expect(page.getByTestId('immunizations-older-toggle')).toBeHidden()

  // Chrome that means nothing on paper is gone.
  await expect(page.getByTestId('summary-print')).toBeHidden()
  await expect(page.getByTestId('summary-filter')).toBeHidden()

  await page.emulateMedia({ media: null })
})

// The unnamed-row hint has three states, and getting them wrong tells the owner
// to fix something they cannot fix — or that they already have.
const NDC = 'http://hl7.org/fhir/sid/ndc'

/** Seed one NDC-coded and one RxNorm-coded medication, both display-less, so
 * neither resolves a name from the source. */
async function seedUnnamed(page: Page): Promise<void> {
  await page.evaluate(
    async ({ ndc, rxnorm, at }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      await logEvent([
        { kind: 'medication_statement', code: { system: ndc, code: '8627007701' }, effective_at: at, value: null },
        { kind: 'medication_statement', code: { system: rxnorm, code: '1719647' }, effective_at: at, value: null },
      ])
    },
    { ndc: NDC, rxnorm: RXNORM, at: daysAgo(30) },
  )
}

/** Mark the dictionary installed the way a real download leaves it: the enabled
 * pref plus a stored manifest. Nothing is faked in the hint path itself — the
 * component still reads the real store, rebuilt from disk by the real
 * `refreshDictionaryStatus`. */
async function installDictionaryCovering(page: Page, systems: string[]): Promise<void> {
  await page.evaluate(async (systems) => {
    const { put } = await import('/src/lib/db.ts')
    const { refreshDictionaryStatus } = await import('/src/lib/dictionary.ts')
    await put('prefs', true, 'dict-enabled')
    await put(
      'prefs',
      {
        version: '2026-07-27',
        generated_at: '2026-07-27T00:00:00Z',
        files: systems.map((system) => ({
          system,
          path: 'x.json',
          bytes: 1,
          sha256: 'x',
          entries: 1,
          label: system,
          attribution: 'test',
        })),
      },
      'dict-manifest',
    )
    await refreshDictionaryStatus()
  }, systems)
}

function hintFor(page: Page, code: string) {
  return page
    .getByTestId('summary-section-medications')
    .getByTestId('summary-row')
    .filter({ hasText: code })
    .getByTestId('summary-unnamed-hint')
}

test('summary: an unnamed row says the true thing about the dictionary', async ({ page }) => {
  await onboardViaUI(page)
  await seedUnnamed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  // 1. Dictionary off: point at Settings.
  await expect(hintFor(page, '8627007701')).toContainText('download the code dictionary')

  // 2. Dictionary installed, covering RxNorm but not NDC. The RxNorm code is
  //    simply absent from this edition; a later one may carry it.
  await installDictionaryCovering(page, [RXNORM])
  await expect(hintFor(page, '1719647')).toContainText('may name it after an update')

  // 3. ...but no dictionary ships for NDC at all, so promising an update would
  //    be a promise nothing can keep.
  await expect(hintFor(page, '8627007701')).toContainText('no dictionary available for NDC codes')
})

test('summary: an installed dictionary is not reported as missing on a cold start', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seedUnnamed(page)
  await installDictionaryCovering(page, [RXNORM])

  // The bug: only Settings > Data ever hydrated the status store, so a reload
  // straight to the summary read the default (disabled) and told an owner with
  // a current dictionary to go and download one.
  await page.reload()
  await unlock(page)
  await openSummary(page)

  await expect(hintFor(page, '1719647')).not.toContainText('download the code dictionary')
  await expect(hintFor(page, '1719647')).toContainText('may name it after an update')
})

/** Curate a medication concept's regimen straight through the signing path;
 * the sheet's own field-by-field behavior is summary-status.spec.ts's job. */
async function setRegimenFor(
  page: Page,
  code: string,
  regimen: { route?: string; as_needed?: boolean; schedule?: string; prescriber?: string },
): Promise<void> {
  await page.evaluate(
    async ({ rxnorm, code, regimen }) => {
      const { setRegimen } = await import('/src/lib/curation.ts')
      await setRegimen(`medication_statement|${rxnorm}|${code}`, regimen)
    },
    { rxnorm: RXNORM, code, regimen },
  )
}

test('summary: a regimen adds a sub-line, and as-needed meds split into their own sub-group', async ({
  page,
}) => {
  await onboardViaUI(page)
  await seed(page)
  // Zolpidem is as-needed; Lisinopril is scheduled. Both are current.
  await setRegimenFor(page, '39786', { as_needed: true, schedule: 'At bedtime' })
  await setRegimenFor(page, '29046', { schedule: 'Every morning', prescriber: 'Dr. Rivera' })
  await page.reload()
  await unlock(page)
  await openSummary(page)

  // The scheduled group loses the PRN med; "As needed" is a sub-group of
  // current, so nothing has moved to Past.
  await expect(meds(page).getByTestId('summary-label')).toHaveText(['amoxicillin', 'Lisinopril'])
  const prn = page.getByTestId('summary-section-as-needed')
  await expect(prn.getByTestId('summary-label')).toHaveText(['Zolpidem'])
  await expect(prn.getByTestId('summary-row').getByTestId('summary-prn-chip')).toContainText(
    'As needed',
  )
  await expect(page.getByTestId('meds-past-toggle')).toHaveCount(0)

  // The sub-line is schedule and prescriber, joined — and absent where neither
  // was recorded rather than rendered blank.
  await expect(
    meds(page).filter({ hasText: 'Lisinopril' }).getByTestId('summary-regimen-subline'),
  ).toHaveText('Every morning · Dr. Rivera')
  await expect(
    meds(page).filter({ hasText: 'amoxicillin' }).getByTestId('summary-regimen-subline'),
  ).toHaveCount(0)
})

test('summary: "All medications" leads to the medications page', async ({ page }) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)
  await openSummary(page)

  await page.getByTestId('all-medications-link').click()
  await expect(page).toHaveURL(/#\/medications$/)
  await expect(page.getByTestId('medications-page')).toBeVisible()
})

test('home: the medications glance card opens the medications page', async ({ page }) => {
  await onboardViaUI(page)
  await seed(page)
  await page.reload()
  await unlock(page)

  await page.getByTestId('glance-meds').click()
  await expect(page).toHaveURL(/#\/medications$/)
  await expect(page.getByTestId('medications-page')).toBeVisible()
})
