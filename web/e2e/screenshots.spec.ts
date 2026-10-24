import { test, expect } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, openLog, syncUntil } from './helpers'
import {
  fakeLabReportPng,
  importFixtures,
  registerNode,
  depositLabProposals,
  depositAnswer,
} from './synthetic'

// On-demand README screenshot capture (docs/screenshots/), not a CI test:
//   cd web && SCREENSHOTS=1 bunx playwright test screenshots.spec.ts
// Drives the real app against the e2e relay with the same synthetic fixtures
// the test suite uses, at a phone viewport, and overwrites the committed
// images — re-run after UI changes so the README never drifts.
test.skip(!process.env.SCREENSHOTS, 'screenshot capture runs on demand, not in CI')

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

const OUT = '../docs/screenshots'

test('spine: imported history + logged data on one timeline', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await importFixtures(page)
  await openLog(page, 'vitals')
  await page.getByTestId('bp-systolic').fill('118')
  await page.getByTestId('bp-diastolic').fill('76')
  await page.getByTestId('save').click()
  await openLog(page, 'symptom')
  await page.getByTestId('symptom-headache').click()
  await page.getByTestId('severity').fill('3')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('day-label').first()).toHaveText('Today')
  await page.screenshot({ path: `${OUT}/spine.png` })
})

test('medications: the whole list filed by route', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await importFixtures(page)

  // The fixtures carry meds but no regimen — route and as-needed are the
  // owner's own curation, and the page's point is what it looks like once
  // filed. Filing here is a per-fixture table, not a rule: the app never
  // derives a route from a drug name, and a screenshot fixture must not be the
  // one place that pretends otherwise.
  await page.evaluate(async () => {
    const { setRegimen } = await import('/src/lib/curation.ts')
    const { allEvents } = await import('/src/lib/events.ts')
    const { conceptKey } = await import('/src/lib/summary.ts')
    const filings: Record<string, { route: string; schedule: string; as_needed?: boolean; prescriber?: string }> = {
      Lisinopril: { route: 'mouth', schedule: 'Twice daily', prescriber: 'Dr. Rivera' },
      Amoxicillin: { route: 'mouth', schedule: 'Three times daily' },
      Ondansetron: { route: 'injection', schedule: 'Up to every 8 hours', as_needed: true },
    }
    const meds = (await allEvents()).filter(
      (e: { event: { kind: string } }) => e.event.kind === 'medication_statement',
    )
    for (const stored of meds) {
      const display: string = stored.event.code?.display ?? ''
      const filing = Object.entries(filings).find(([drug]) => display.includes(drug))?.[1]
      if (filing) await setRegimen(conceptKey(stored.event), filing)
    }
  })

  await page.evaluate(() => {
    window.location.hash = '#/medications'
  })
  await expect(page.getByTestId('medications-page')).toBeVisible()
  await page.screenshot({ path: `${OUT}/medications.png` })
})

test('doctor share: what the clinician sees, opened cold', async ({ page, browser }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await importFixtures(page)
  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()

  const recipient = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  })
  const doctorPage = await recipient.newPage()
  await doctorPage.goto(link)
  await expect(doctorPage.getByTestId('clinician-summary')).toBeVisible()
  await doctorPage.screenshot({ path: `${OUT}/doctor-share.png` })
  await recipient.close()
})

test('proposal inbox: an OCR draft beside its source page', async ({ page }) => {
  const report = await fakeLabReportPng(page)
  await page.goto('/')
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  await openLog(page, 'paper')
  await page
    .getByTestId('paper-file')
    .setInputFiles({ name: 'lab-report.png', mimeType: 'image/png', buffer: report })
  await expect(page.getByTestId('paper-thumbs').locator('img')).toHaveCount(1)
  await page.getByTestId('save').click()

  const sourceBlob = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const atts = (await getAll('attachments')) as { sha256: string }[]
    return `att-${atts[0].sha256}`
  })

  await depositLabProposals(page, words, sourceBlob)

  await syncUntil(page, async () => {
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft').first()).toBeVisible({ timeout: 2000 })
  })
  await page.screenshot({ path: `${OUT}/proposal-inbox.png` })
})

test('ask: a cited answer from your own record', async ({ page }) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)
  await openLog(page, 'vitals')
  await page.getByTestId('bp-systolic').fill('118')
  await page.getByTestId('bp-diastolic').fill('76')
  await page.getByTestId('save').click()
  const eventId = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const events = (await getAll('events')) as { event: { id: string } }[]
    return events[0].event.id
  })

  const node = await registerNode(page)

  await page.getByTestId('nav-search').click()
  await page.getByTestId('search-ai-toggle').click()
  await page.getByTestId('search-input').fill('How has my blood pressure been lately?')
  await page.getByTestId('search-send').click()
  await expect(page.getByTestId('search-waiting')).toBeVisible()

  await depositAnswer(page, {
    words,
    nodeMnemonic: node.mnemonic,
    text: 'Your one recent reading, 118/76 on 24 Jul, is in the normal range.',
    citations: [eventId],
  })

  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/search'))
    await page.getByTestId('search-ai-toggle').click()
    await expect(page.getByTestId('search-turn').filter({ hasText: 'normal range' })).toBeVisible({
      timeout: 2000,
    })
  }).toPass({ timeout: 20_000 })
  await page.screenshot({ path: `${OUT}/ask.png` })
})
