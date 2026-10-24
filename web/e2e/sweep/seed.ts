import { expect, type Browser, type Page } from '@playwright/test'
import {
  onboardViaUI,
  connectRelayViaUI,
  openLog,
  logBP,
  logFood,
  syncNowAndWait,
  syncUntil,
  waitForPushed,
} from '../helpers'
import {
  fakeLabReportPng,
  importFixtures,
  registerNode,
  depositLabProposals,
  depositAnswer,
} from '../synthetic'

// One rich synthetic vault for the whole sweep (onboarding through the UI is
// the slow part, so it happens once): the imported fixtures, a spread of
// entries logged through the real forms over the last few days, curation made
// through the real sheets, a proposal, a cited answer, two partners (one
// accepted, one still pending), and a doctor link.

const HOUR = 3600 * 1000

/** `datetime-local` value (`YYYY-MM-DDTHH:mm`) for the Earlier time control. */
function localDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Save the open log form, optionally backdated, and wait for the timeline it
 * lands on after its confirmation linger. */
async function save(page: Page, hoursAgo = 0): Promise<void> {
  if (hoursAgo) {
    await page.getByTestId('time-earlier').click()
    await page.getByTestId('effective-at').fill(localDatetimeInput(new Date(Date.now() - hoursAgo * HOUR)))
  }
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/#\/timeline$/)
}

async function logEntries(page: Page, labReport: Buffer): Promise<void> {
  for (const [sys, dia, ago] of [
    ['118', '76', 72],
    ['126', '82', 26],
    ['121', '78', 0],
  ] as const) {
    await openLog(page, 'vitals')
    await page.getByTestId('bp-systolic').fill(sys)
    await page.getByTestId('bp-diastolic').fill(dia)
    await save(page, ago)
  }
  await openLog(page, 'vitals')
  await page.getByTestId('vital-hr').click()
  await page.getByTestId('vital-value').fill('68')
  await save(page, 5)

  await openLog(page, 'med')
  await page.getByTestId('med-name').fill('Vitamin D3')
  await page.getByTestId('med-dose').fill('1000')
  await save(page, 8)

  await openLog(page, 'food')
  for (const item of ['oatmeal', 'coffee']) {
    await page.getByTestId('food-input').fill(item)
    await page.getByTestId('food-input').press('Enter')
  }
  await save(page, 34)
  await openLog(page, 'food')
  await page.getByTestId('food-input').fill('peanut butter toast')
  await page.getByTestId('food-input').press('Enter')
  await save(page, 4)

  await openLog(page, 'symptom')
  await page.getByTestId('symptom-headache').click()
  await page.getByTestId('severity').fill('7')
  await save(page, 30)
  await openLog(page, 'symptom')
  await page.getByTestId('symptom-fatigue').click()
  await page.getByTestId('severity').fill('3')
  await save(page, 2)

  await openLog(page, 'exercise')
  await page.getByTestId('exercise-activity').fill('Walk')
  await page.getByTestId('exercise-minutes').fill('30')
  await save(page, 6)

  await openLog(page, 'mind')
  await page.getByTestId('mind-tab-mood').click()
  await page.getByTestId('mood-4').click()
  await page.getByTestId('mood-note').fill('Calm afternoon')
  await save(page, 3)
  await openLog(page, 'mind')
  await page.getByTestId('mind-tab-gratitude').click()
  await page.getByTestId('gratitude-input').fill('A long call with a friend')
  await page.getByTestId('gratitude-input').press('Enter')
  await save(page, 1)

  await openLog(page, 'cycle')
  await page.getByTestId('cycle-tab-start').click()
  await save(page, 98)
  await openLog(page, 'cycle')
  await page.getByTestId('flow-3').click()
  await save(page, 74)

  await openLog(page, 'note')
  await page.getByTestId('note-body').fill('Felt steadier after the walk. Ask about the morning headaches.')
  await save(page, 1)

  await openLog(page, 'visit')
  await page.getByTestId('visit-provider').fill('Dr. Rivera')
  await page.getByTestId('visit-reason').fill('Annual check-up')
  await page.getByTestId('visit-note').fill('Blood pressure fine. Recheck A1c in six months.')
  await save(page, 50)

  await openLog(page, 'paper')
  await page
    .getByTestId('paper-file')
    .setInputFiles({ name: 'lab-report.png', mimeType: 'image/png', buffer: labReport })
  await expect(page.getByTestId('paper-thumbs').locator('img')).toHaveCount(1)
  await page.getByTestId('save').click()
  // A paper record offers to read the page; decline when it asks.
  const decline = page.getByTestId('bulk-read-import-decline')
  await decline.click({ timeout: 3000 }).catch(() => undefined)
  await expect(page).toHaveURL(/#\/timeline$/)
}

/** Expand a summary row (on Summary or Medications) and open its sheet. */
async function openCurate(page: Page, label: string): Promise<void> {
  const row = page.getByTestId('summary-row').filter({ hasText: label }).first()
  const trigger = row.getByTestId('summary-row-trigger')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await row.getByTestId('summary-row-curate').click()
  await expect(page.getByTestId('row-action-sheet')).toBeVisible()
}

async function saveSheet(page: Page): Promise<void> {
  await page.getByTestId('action-save').click()
  await expect(page.getByTestId('row-action-sheet')).toBeHidden()
}

async function curate(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/medications'))
  await expect(page.getByTestId('medications-page')).toBeVisible()

  await openCurate(page, 'Lisinopril')
  await page.getByTestId('action-dose-input').fill('10 mg')
  await page.getByTestId('action-schedule-input').fill('Twice daily')
  await page.getByTestId('action-route-select').selectOption('mouth')
  await page.getByTestId('action-prescriber-input').fill('Dr. Rivera')
  await saveSheet(page)

  await openCurate(page, 'Ondansetron')
  await page.getByTestId('action-schedule-input').fill('Up to every 8 hours')
  await page.getByTestId('action-route-select').selectOption('injection')
  await page.getByTestId('action-as-needed').check()
  await saveSheet(page)

  await openCurate(page, 'Amoxicillin')
  await page.getByTestId('action-toggle-status').click()
  await expect(page.getByTestId('page-past-toggle')).toContainText('1 past')

  await page.evaluate(() => (window.location.hash = '#/summary'))
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
  await openCurate(page, 'Hypertension')
  await page.getByTestId('action-name-input').fill('High blood pressure')
  await page.getByTestId('action-priority-pinned').click()
  await saveSheet(page)

  // A job with its exposures, so "Work & exposures" has a row. Logged as the
  // Work form writes it (one event per component, one timestamp) rather than
  // through the form, which the sweep shoots on its own.
  await page.evaluate(async () => {
    const { logEvent } = await import('/src/lib/events.ts')
    const loinc = (code: string, display: string) => ({ system: 'http://loinc.org', code, display })
    const at = '2019-01-01T00:00:00+00:00'
    await logEvent([
      { kind: 'observation', code: loinc('11341-5', 'History of Occupation'), effective_at: at, value: { text: 'Registered nurse' } },
      { kind: 'observation', code: loinc('87729-0', 'History of Occupational hazard'), effective_at: at, value: { text: 'needlesticks' } },
      { kind: 'observation', code: loinc('87729-0', 'History of Occupational hazard'), effective_at: at, value: { text: 'night shifts' } },
    ])
  })
}

async function seedProposal(page: Page, words: string[]): Promise<void> {
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
}

async function seedAnswer(page: Page, words: string[]): Promise<void> {
  const citation = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const events = (await getAll('events')) as { event: { id: string; code?: { display?: string } } }[]
    return (events.find((e) => /systolic/i.test(e.event.code?.display ?? '')) ?? events[0]).event.id
  })
  const node = await registerNode(page)
  await page.evaluate(() => (window.location.hash = '#/search'))
  await page.getByTestId('search-ai-toggle').click()
  await page.getByTestId('search-input').fill('How has my blood pressure been lately?')
  await page.getByTestId('search-send').click()
  await expect(page.getByTestId('search-waiting')).toBeVisible()
  await depositAnswer(page, {
    words,
    nodeMnemonic: node.mnemonic,
    text: 'Your readings this week ran 118/76 to 126/82, all within the normal range.',
    citations: [citation],
  })
  // No pokes reach this page (see seedVault), so pull the answer explicitly.
  await expect(async () => {
    await syncNowAndWait(page)
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/search'))
    await page.getByTestId('search-ai-toggle').click()
    await expect(page.getByTestId('search-turn').filter({ hasText: 'normal range' })).toBeVisible({
      timeout: 2000,
    })
  }).toPass({ timeout: 30_000 })
}

/** Set this identity's display name on Your people and return its exchange
 * code (`…:<ed25519 hex>:…`). */
async function exchangeCode(page: Page, name: string): Promise<string> {
  await page.evaluate(() => (window.location.hash = '#/share/people'))
  await page.getByTestId('display-name').fill(name)
  await expect(page.getByTestId('my-code')).toContainText(encodeURIComponent(name))
  return (await page.getByTestId('my-code').innerText()).trim()
}

/** Share this identity's record with whoever owns `code`. */
async function shareWith(page: Page, code: string): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/share/people'))
  await page.getByTestId('enroll-paste').fill(code)
  await expect(page.getByTestId('enroll-fingerprint')).toBeVisible()
  await page.getByTestId('enroll-submit').click()
  await expect(page.getByTestId('enroll-done')).toBeVisible()
}

/** Bailey shares their record with the owner and the owner accepts (so the
 * person routes have content and Your people shows both directions); Casey's
 * invite is left pending so Home, Sharing and Notifications show one. Returns
 * Bailey's key. */
async function seedPeople(page: Page, browser: Browser): Promise<string> {
  const ownerCode = await exchangeCode(page, 'Alex')

  const bailey = await browser.newContext()
  const bp = await bailey.newPage()
  await onboardViaUI(bp)
  await connectRelayViaUI(bp)
  await logBP(bp, '132', '84')
  await logFood(bp, 'lentil soup')
  await waitForPushed(bp)
  const baileyCode = await exchangeCode(bp, 'Bailey')
  await shareWith(bp, ownerCode)

  const casey = await browser.newContext()
  const cp = await casey.newPage()
  await onboardViaUI(cp)
  await connectRelayViaUI(cp)
  await exchangeCode(cp, 'Casey')
  await shareWith(cp, ownerCode)

  await shareWith(page, baileyCode)

  const baileyEd = baileyCode.split(':')[1]
  await expect(async () => {
    await syncNowAndWait(page)
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/share'))
    await expect(page.getByTestId('invite-banner').filter({ hasText: 'Bailey' })).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('invite-banner').filter({ hasText: 'Casey' })).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  await page.getByTestId('invite-banner').filter({ hasText: 'Bailey' }).getByTestId('invite-accept').click()
  // Accepting unwraps and stores the vault key before the banner goes; under a
  // busy relay that outlasts the default 5s.
  await expect(page.getByTestId('invite-banner').filter({ hasText: 'Bailey' })).toHaveCount(0, {
    timeout: 30_000,
  })

  // The shared pull lands blob by blob in the background; wait until a single
  // mount shows all of Bailey's entries (see share.spec.ts).
  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate((ed) => (window.location.hash = `#/person/${ed}`), baileyEd)
    for (const text of ['132/84', 'lentil soup']) {
      await expect(page.getByTestId('spine-entry').filter({ hasText: text })).toBeVisible({ timeout: 2000 })
    }
  }).toPass({ timeout: 30_000 })

  await bailey.close()
  await casey.close()
  return baileyEd
}

/** Create a doctor link with the default scope and return its fragment. */
async function seedDoctorLink(page: Page): Promise<string> {
  await page.evaluate(() => (window.location.hash = '#/share/doctor'))
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  await page.getByTestId('share-done').click()
  const frag = link.split('#/s/')[1]
  if (!frag) throw new Error(`unexpected doctor link shape: ${link}`)
  return frag
}

/** Build the vault on `page` and return the route vars the manifest needs. */
export async function seedVault(page: Page, browser: Browser): Promise<Record<string, string>> {
  const labReport = await fakeLabReportPng(page)
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)
  await importFixtures(page)
  await logEntries(page, labReport)
  await curate(page)
  await seedProposal(page, words)
  await seedAnswer(page, words)
  const ed = await seedPeople(page, browser)
  const frag = await seedDoctorLink(page)
  await waitForPushed(page)
  return { ed, frag }
}
