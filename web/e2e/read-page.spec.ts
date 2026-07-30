import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { onboardViaUI, openLog } from './helpers'

const PDF = fileURLToPath(new URL('./fixtures/tiny.pdf', import.meta.url))

/** The stub endpoint, on the app's own origin: loopback (so it passes the
 * http check) and same-origin (so the POST needs no CORS preflight). Only the
 * endpoint is stubbed — the PDF text layer, the prompt, the source-line guard
 * and the proposal store are all the real path, which is the point of driving
 * this end to end. */
const endpointFor = (page: Page) => new URL('/stub/v1', page.url()).href

/** One finding that quotes back to the fixture's only line ("Hello PDF"), so
 * the guard verifies it instead of dropping it. */
const CODED = JSON.stringify({
  findings: [
    {
      kind: 'observation',
      source_line: 1,
      display: 'Hello',
      value_text: 'Hello PDF',
      effective_at: '2026-03-12',
    },
  ],
})

async function stubEndpoint(page: Page, content: string): Promise<void> {
  await page.route('**/stub/v1/chat/completions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    }),
  )
}

/** Point this device at the stub through the real Settings → AI form. */
async function configureEndpoint(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/settings/ai'))
  await page.getByTestId('inference-endpoint').fill(endpointFor(page))
  await page.getByTestId('inference-model').fill('stub-model')
  await page.getByTestId('inference-save').click()
  await page.getByTestId('inference-consent-accept').click()
  await expect(page.getByTestId('inference-status')).toBeVisible()
  await page.evaluate(() => (window.location.hash = '#/'))
}

/** Capture the fixture PDF as a paper record and open its viewer. */
async function openCapturedPdf(page: Page): Promise<void> {
  await openLog(page, 'paper')
  await page.getByTestId('paper-file-pdf').setInputFiles(PDF)
  await expect(page.getByTestId('paper-thumb-pdf')).toHaveCount(1)
  await page.getByTestId('save').click()

  await page.getByTestId('spine-entry').getByTestId('spine-entry-trigger').click()
  await expect(page.getByTestId('viewer-pdf').locator('canvas')).toBeVisible()
}

test('a read reports inside the viewer, and re-reading updates', async ({ page }) => {
  await stubEndpoint(page, CODED)
  await onboardViaUI(page)
  await configureEndpoint(page)
  await openCapturedPdf(page)

  await page.getByTestId('viewer-read').click()

  // The outcome is drawn over the page it belongs to, not behind the viewer.
  const notice = page.getByTestId('viewer-stage').getByTestId('read-notice')
  await expect(notice).toBeVisible()
  await expect(page.getByTestId('read-notice-text')).toHaveText(
    'Proposed 1 entry from this page.',
  )

  // Success asks; it does not walk the owner off the document.
  await expect(page.getByTestId('viewer-stage')).toBeVisible()
  await page.getByRole('button', { name: 'Keep reading' }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.getByTestId('viewer-read')).toHaveText('Read again')

  // The re-read lands: same page, same group, replaced drafts.
  await page.getByTestId('viewer-read').click()
  await expect(page.getByTestId('read-notice-text')).toHaveText('Updated 1 proposal.')

  await page.getByRole('button', { name: 'Review proposals' }).click()
  await expect(page.getByTestId('proposal-draft')).toHaveCount(1)
})

test('an endpoint failure is named inside the viewer', async ({ page }) => {
  await page.route('**/stub/v1/chat/completions', (route) => route.fulfill({ status: 503 }))
  await onboardViaUI(page)
  await configureEndpoint(page)
  await openCapturedPdf(page)

  await page.getByTestId('viewer-read').click()

  await expect(page.getByTestId('viewer-stage').getByTestId('read-notice')).toBeVisible()
  await expect(page.getByTestId('read-notice-text')).toHaveText(
    'The inference endpoint answered 503.',
  )
  // The document is still there behind the message.
  await expect(page.getByTestId('viewer-pdf').locator('canvas')).toBeVisible()
})

test("an answer that isn't findings is retryable, not a blank page", async ({ page }) => {
  await stubEndpoint(page, 'I could not read the image.')
  await onboardViaUI(page)
  await configureEndpoint(page)
  await openCapturedPdf(page)

  await page.getByTestId('viewer-read').click()

  await expect(page.getByTestId('read-notice-text')).toHaveText(
    "Your endpoint's answer couldn't be read. Try again.",
  )
})
