import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { onboardViaUI, openLog } from './helpers'

const PNG = fileURLToPath(new URL('./fixtures/tiny.png', import.meta.url))
const PDF = fileURLToPath(new URL('./fixtures/tiny.pdf', import.meta.url))

test('captures a photo and a PDF in one record and views both', async ({ page }) => {
  await onboardViaUI(page)

  await openLog(page, 'paper')
  // Pick one at a time, waiting for each thumb, so the photo's async downscale
  // has landed before the next assertion (setInputFiles doesn't await it).
  await page.getByTestId('paper-file').setInputFiles(PNG)
  await expect(page.getByTestId('paper-thumbs').locator('img')).toHaveCount(1)
  await page.getByTestId('paper-file-pdf').setInputFiles(PDF)
  await expect(page.getByTestId('paper-thumb-pdf')).toHaveCount(1)

  await page.getByTestId('save').click()

  // Back on the spine: a mixed record uses the neutral paperclip hint. Tapping
  // the row opens the full-screen viewer.
  const entry = page.getByTestId('spine-entry').filter({ hasText: '2 items' })
  await expect(entry).toHaveCount(1)
  await entry.getByTestId('spine-entry-trigger').click()

  await expect(page.getByTestId('viewer-counter')).toContainText('of 2')

  // Page order is sha-sorted, so either the image or the PDF can be first.
  // Wait for whichever page-0 content settles, then assert both are reachable
  // and render as their kind — the PDF as a canvas inside its slot.
  const image = page.getByTestId('viewer-image')
  const pdfCanvas = page.getByTestId('viewer-pdf').locator('canvas')
  await expect(image.or(pdfCanvas)).toBeVisible()
  if (await image.isVisible()) {
    await page.getByTestId('viewer-next').click()
    await expect(pdfCanvas).toBeVisible()
  } else {
    await expect(pdfCanvas).toBeVisible()
    await page.getByTestId('viewer-next').click()
    await expect(image).toBeVisible()
  }
})

test('rejects an oversize PDF at pick time and adds nothing', async ({ page }) => {
  await onboardViaUI(page)

  await openLog(page, 'paper')
  // ~12 MiB, over the 11 MB attachment ceiling. Zero-filled bytes are fine —
  // the reject is a pick-time size check, before any parse.
  await page.getByTestId('paper-file-pdf').setInputFiles({
    name: 'huge.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(12 * 1024 * 1024),
  })

  await expect(page.getByTestId('save-error')).toContainText('over 11 MB')
  // Nothing was added, so the thumbs grid never renders.
  await expect(page.getByTestId('paper-thumbs')).toHaveCount(0)
})
