import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { onboardViaUI, openLog } from './helpers'

const PDF = fileURLToPath(new URL('./fixtures/tiny.pdf', import.meta.url))
const PDF_BYTES = readFileSync(PDF)
const endpointFor = (page: Page) => new URL('/stub/v1', page.url()).href

const FINDING = JSON.stringify({
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
const NOTHING_FOUND = JSON.stringify({ findings: [] })

async function configureEndpoint(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/settings/ai'))
  await page.getByTestId('inference-endpoint').fill(endpointFor(page))
  await page.getByTestId('inference-model').fill('stub-model')
  await page.getByTestId('inference-save').click()
  await page.getByTestId('inference-consent-accept').click()
  await expect(page.getByTestId('inference-status')).toBeVisible()
  await page.evaluate(() => (window.location.hash = '#/'))
}

test('bulk reader stops after its current page, keeps drafts, and resumes the remaining synthetic backlog', async ({ page }) => {
  let requests = 0
  let releaseFirst: (() => void) | undefined
  const firstRequest = new Promise<void>((resolve) => (releaseFirst = resolve))
  await page.route('**/stub/v1/chat/completions', async (route) => {
    requests++
    if (requests === 1) {
      await firstRequest
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: FINDING } }] }),
      })
      return
    }
    const content = requests === 2 ? 'synthetic malformed answer' : NOTHING_FOUND
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    })
  })

  await onboardViaUI(page)
  await configureEndpoint(page)
  await openLog(page, 'paper')
  await page.getByTestId('paper-file-pdf').setInputFiles(
    ['one', 'two', 'three'].map((name) => ({
      name: `${name}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.concat([PDF_BYTES, Buffer.from(`\n% synthetic-${name}\n`)]),
    })),
  )
  await expect(page.getByTestId('paper-thumb-pdf')).toHaveCount(3)
  await page.getByTestId('paper-caption').fill('Synthetic report')
  await page.getByTestId('save').click()

  // D6's import entry point offers the backlog exactly where the attachments arrived.
  await expect(page.getByTestId('bulk-read-import-offer')).toBeVisible()
  await page.getByTestId('bulk-read-import-start').click()
  await expect(page.getByTestId('bulk-read-current')).toHaveText(/Page 1 of 3 · Synthetic report/)
  await page.getByTestId('bulk-read-stop').click()
  releaseFirst?.()

  await expect(page.getByTestId('bulk-read-summary')).toHaveText('1 read, 0 nothing-found, 0 unreadable.')
  await expect(page.getByTestId('bulk-read-stopped')).toHaveText('Stopped after this page.')
  await page.getByTestId('bulk-read-close').click()

  await page.evaluate(() => (window.location.hash = '#/proposals'))
  await expect(page.getByTestId('proposal-draft')).toHaveCount(1)

  await page.evaluate(() => (window.location.hash = '#/settings/ai'))
  await expect(page.getByTestId('bulk-read-card')).toBeVisible()
  await expect(page.getByTestId('bulk-read-count')).toHaveText("2 pages haven't been read yet.")
  await page.getByTestId('bulk-read-start').click()

  await expect(page.getByTestId('bulk-read-summary')).toHaveText('0 read, 1 nothing-found, 1 unreadable.')
  await expect(page.getByTestId('bulk-read-close')).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
})
