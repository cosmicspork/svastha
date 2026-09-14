import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, PASSPHRASE } from './helpers'

// The pharmacy list (`#/medications/pharmacy`): the same medication fold the
// Medications page shows, flattened into one numbered list for someone filling
// a prescription. Numbering runs across every group, past meds included, so a
// number names one line of the whole handoff.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
const SNOMED = 'http://snomed.info/sct'

/** Four coded meds plus one allergy, through the real signing path. Named so
 * route order and alphabetical order disagree. */
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
          code: { system: rxnorm, code: '745679', display: 'Albuterol' },
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

async function seedRegimens(
  page: Page,
  entries: Record<
    string,
    {
      route?: string
      as_needed?: boolean
      dose?: string
      schedule?: string
      instructions?: string
      prescriber?: string
    }
  >,
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

async function openPharmacy(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/medications/pharmacy'
  })
  await expect(page.getByTestId('medications-pharmacy-page')).toBeVisible()
}

/** Every on-screen row's number and name, in DOM order across all groups.
 * Visible-only: the past group stays in the DOM while collapsed so print can
 * reveal it, and a count that included it would pass whether or not the toggle
 * works. */
async function rowLines(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid="pharmacy-row"]:visible')
  const out: string[] = []
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i)
    out.push(`${await row.getAttribute('data-n')} ${await row.getByTestId('pharmacy-name').innerText()}`)
  }
  return out
}

test('reached from the medications page, with dose, directions and prescriber', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, {
    '29046': {
      route: 'mouth',
      dose: '10 mg tablet',
      schedule: 'once daily',
      instructions: 'in the morning',
      prescriber: 'Dr. Anita Rao',
    },
    '745679': { route: 'inhaled', as_needed: true, dose: '90 mcg inhaler' },
  })
  await page.reload()
  await unlock(page)

  await page.evaluate(() => {
    window.location.hash = '#/medications'
  })
  await expect(page.getByTestId('medications-page')).toBeVisible()
  await page.getByTestId('medications-pharmacy-link').click()
  await expect(page.getByTestId('pharmacy-list')).toBeVisible()

  const lisinopril = page.getByTestId('pharmacy-row').filter({ hasText: 'Lisinopril' })
  await expect(lisinopril.getByTestId('pharmacy-dose')).toHaveText('10 mg tablet')
  await expect(lisinopril.getByTestId('pharmacy-sig')).toHaveText('once daily · in the morning')
  await expect(lisinopril.getByTestId('pharmacy-prescriber')).toHaveText('Dr. Anita Rao')

  // As-needed is a chip on its route shelf, never a shelf of its own.
  const albuterol = page.getByTestId('pharmacy-row').filter({ hasText: 'Albuterol' })
  await expect(albuterol.getByText('As needed')).toBeVisible()
  await expect(
    page.getByTestId('pharmacy-group').filter({ has: albuterol }),
  ).toHaveAttribute('data-group', 'inhaled')

  // A med nobody filed says so in the pharmacist's words, and a prescriber
  // nobody recorded is "Not recorded" rather than a blank that reads as none.
  const metformin = page.getByTestId('pharmacy-row').filter({ hasText: 'Metformin' })
  await expect(page.getByTestId('pharmacy-group').filter({ has: metformin })).toContainText(
    'Route not recorded',
  )
  await expect(metformin.getByTestId('pharmacy-prescriber')).toHaveText('Not recorded')
})

test('numbers run continuously across groups and into past meds', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, {
    '29046': { route: 'mouth' }, // Lisinopril
    '745679': { route: 'inhaled' }, // Albuterol
  })
  await setStatusFor(page, '723', 'inactive') // Amoxicillin → past
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  // Unrouted leads, then route shelves in REGIMEN_ROUTES order, past last.
  const groupOrder = await page
    .getByTestId('pharmacy-group')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-group')))
  expect(groupOrder).toEqual(['unrouted', 'mouth', 'inhaled', 'past'])
  expect(await rowLines(page)).toEqual(['1 Metformin', '2 Lisinopril', '3 Albuterol'])

  await page.getByTestId('pharmacy-past-toggle').click()
  expect(await rowLines(page)).toEqual([
    '1 Metformin',
    '2 Lisinopril',
    '3 Albuterol',
    '4 Amoxicillin',
  ])
  await expect(
    page.getByTestId('pharmacy-row').filter({ hasText: 'Amoxicillin' }),
  ).toHaveAttribute('data-past', 'true')
})

test('leaves a hidden medication off the list', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await page.reload()
  await unlock(page)
  await openPharmacy(page)
  await expect(page.locator('[data-testid="pharmacy-row"]:visible')).toHaveCount(4)

  // Hide every event of one concept. The guarantee is that the export shows
  // what the owner's own screens show — a hidden entry is hidden everywhere.
  const hiddenName = 'Metformin'
  await page.evaluate(
    async ({ rxnorm }) => {
      const { allEvents } = await import('/src/lib/events.ts')
      const { setHidden } = await import('/src/lib/curation.ts')
      for (const stored of await allEvents()) {
        if (stored.event.code?.system === rxnorm && stored.event.code?.code === '6809') {
          await setHidden(stored.event.id, true)
        }
      }
    },
    { rxnorm: RXNORM },
  )
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  await expect(page.locator('[data-testid="pharmacy-row"]:visible')).toHaveCount(3)
  await expect(page.getByTestId('pharmacy-list')).not.toContainText(hiddenName)
  // Adversarial: numbering closes the gap rather than skipping 1, which would
  // tell a pharmacist a line is missing.
  expect(await rowLines(page)).toEqual(['1 Albuterol', '2 Amoxicillin', '3 Lisinopril'])
})

test('allergies lead the list, and an empty record never claims none', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  // Nothing recorded: the copy must not read as a cleared allergy list.
  await expect(page.getByTestId('pharmacy-allergies-none')).toContainText('None recorded')
  await expect(page.getByTestId('pharmacy-allergies-none')).toContainText('ask')

  await page.evaluate(
    async ({ snomed }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      await logEvent([
        {
          kind: 'allergy_intolerance',
          code: null,
          effective_at: '2023-05-01T00:00:00+00:00',
          value: { coded: { system: snomed, code: '91936005', display: 'Penicillin allergy' } },
        },
      ])
    },
    { snomed: SNOMED },
  )
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  await expect(page.getByTestId('pharmacy-allergies')).toContainText('Penicillin')
  await expect(page.getByTestId('pharmacy-allergies-none')).toHaveCount(0)
})

test('stacks the row on a phone and keeps it side by side on a wide screen', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, { '29046': { route: 'mouth', prescriber: 'Dr. Anita Rao' } })
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  const row = page.getByTestId('pharmacy-row').filter({ hasText: 'Lisinopril' })
  const name = row.getByTestId('pharmacy-name')
  const prescriber = row.getByTestId('pharmacy-prescriber')

  await page.setViewportSize({ width: 1024, height: 900 })
  const wideName = await name.boundingBox()
  const widePrescriber = await prescriber.boundingBox()
  expect(widePrescriber!.x).toBeGreaterThan(wideName!.x + wideName!.width)

  await page.setViewportSize({ width: 390, height: 844 })
  const narrowName = await name.boundingBox()
  const narrowPrescriber = await prescriber.boundingBox()
  expect(narrowPrescriber!.y).toBeGreaterThan(narrowName!.y + narrowName!.height - 1)
})

test('printing carries the past meds and drops the on-screen chrome', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, { '29046': { route: 'mouth' } })
  await setStatusFor(page, '723', 'inactive') // Amoxicillin → past
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  const past = page.getByTestId('pharmacy-group').filter({ hasText: 'Amoxicillin' })
  await expect(past).toBeHidden()

  await page.emulateMedia({ media: 'print' })

  // Paper has no toggle: a printed list that silently dropped the recently
  // stopped meds is the one a pharmacist most needs.
  await expect(past).toBeVisible()
  await expect(page.getByTestId('pharmacy-past-toggle')).toBeHidden()
  await expect(page.getByTestId('pharmacy-print')).toBeHidden()
  // Numbering is unchanged by the reveal — the same line is still number 4.
  // Only Lisinopril is filed here, so the other two lead as unrouted.
  expect(await rowLines(page)).toEqual([
    '1 Albuterol',
    '2 Metformin',
    '3 Lisinopril',
    '4 Amoxicillin',
  ])

  await page.emulateMedia({ media: 'screen' })
  await expect(past).toBeHidden()
})

test('counter size enlarges the list and is remembered', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  const name = page
    .getByTestId('pharmacy-row')
    .filter({ hasText: 'Lisinopril' })
    .getByTestId('pharmacy-name')
  const fontSize = () => name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

  await expect(page.getByTestId('pharmacy-list')).toHaveAttribute('data-size', 'standard')
  const standard = await fontSize()

  await page.getByTestId('pharmacy-size-counter').click()
  await expect(page.getByTestId('pharmacy-list')).toHaveAttribute('data-size', 'counter')
  expect(await fontSize()).toBeGreaterThan(standard)

  // Persisted, not per-visit: someone who reads this across a counter needs it
  // at that size every time.
  await page.reload()
  await unlock(page)
  await openPharmacy(page)
  await expect(page.getByTestId('pharmacy-list')).toHaveAttribute('data-size', 'counter')
  await expect(page.getByTestId('pharmacy-size-counter')).toHaveAttribute('aria-pressed', 'true')

  // The control is chrome, so it stays off the paper.
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByTestId('pharmacy-size-counter')).toBeHidden()
  await page.emulateMedia({ media: 'screen' })
})

test('shares the list as a PDF, downloading where the OS has no share sheet', async ({ page }) => {
  await onboardViaUI(page)
  await seedMeds(page)
  await seedRegimens(page, { '29046': { route: 'mouth', dose: '10 mg tablet' } })
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  // Hide one med first: whatever leaves this page must show what the page shows.
  await page.evaluate(
    async ({ rxnorm }) => {
      const { allEvents } = await import('/src/lib/events.ts')
      const { setHidden } = await import('/src/lib/curation.ts')
      for (const stored of await allEvents()) {
        if (stored.event.code?.system === rxnorm && stored.event.code?.code === '6809') {
          await setHidden(stored.event.id, true)
        }
      }
    },
    { rxnorm: RXNORM },
  )
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  // Chromium on Linux has no Web Share API, so this exercises the fallback.
  await page.getByTestId('pharmacy-share').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('pharmacy-share-pdf').click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/^svastha-medications-\d{4}-\d{2}-\d{2}\.pdf$/)
  const path = await download.path()
  const bytes = (await import('node:fs')).readFileSync(path!)
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')

  // The words actually in the file, read back through the app's own PDF text
  // layer — a header check alone would pass on an empty document.
  const text = await page.evaluate(async (data) => {
    const { textLayer } = await import('/src/lib/pdf.ts')
    const lines = await textLayer(new Uint8Array(data))
    return lines.map((l) => l.text).join('\n')
  }, [...bytes])

  expect(text).toContain('Lisinopril')
  expect(text).toContain('10 mg tablet')
  expect(text).toContain('1. ')
  // The hidden med is absent from the file, as it is from the page.
  expect(text).not.toContain('Metformin')
  await expect(page.getByTestId('pharmacy-pdf-error')).toHaveCount(0)
})

test('uses the OS share sheet when the browser has one', async ({ page }) => {
  // Stub Web Share before any app code runs, and record what it receives.
  await page.addInitScript(() => {
    const w = window as unknown as { __shared?: { name: string; type: string }[] }
    w.__shared = []
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files?: File[] }) => {
        for (const f of data.files ?? []) w.__shared!.push({ name: f.name, type: f.type })
      },
    })
  })

  await onboardViaUI(page)
  await seedMeds(page)
  await page.reload()
  await unlock(page)
  await openPharmacy(page)

  let downloaded = false
  page.on('download', () => (downloaded = true))

  await page.getByTestId('pharmacy-share').click()
  await page.getByTestId('pharmacy-share-pdf').click()

  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length),
    )
    .toBe(1)
  const shared = await page.evaluate(
    () => (window as unknown as { __shared: { name: string; type: string }[] }).__shared[0],
  )
  expect(shared.type).toBe('application/pdf')
  expect(shared.name).toMatch(/^svastha-medications-/)
  // Shared, so never also saved to disk.
  expect(downloaded).toBe(false)
})
