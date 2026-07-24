import { test, expect, type Browser, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, logFood } from './helpers'

// The relay-less file share, end to end: the owner exports the same scoped,
// sealed bundle to a FILE (no relay, no link), hands it over, and a cold browser
// that never ran Svastha opens it through the picker — passphrase-protected or
// key-embedded. The whole post-decryption pipeline is the shipped viewer, so
// these assert the format seam (export → file → picker → decrypt) and the
// honest unrevocability, not the summary rendering the link specs already cover.

/** Open the share sheet's file tab and save a file; returns its path plus the
 * once-shown passphrase (null in embedded mode). Leaves the result screen up. */
async function saveShareFile(
  page: Page,
  opts: { passphrase: boolean; beforeSave?: () => Promise<void> },
): Promise<{ path: string; phrase: string | null }> {
  await page.evaluate(() => (window.location.hash = '#/share/doctor'))
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('delivery-file').click()
  if (opts.beforeSave) await opts.beforeSave()
  // The toggle defaults ON; turn it off for embedded mode.
  if (!opts.passphrase) await page.getByTestId('file-passphrase-toggle').click()

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('share-save-file').click()
  const path = await (await downloadPromise).path()

  let phrase: string | null = null
  if (opts.passphrase) {
    phrase = (await page.getByTestId('file-share-passphrase').innerText()).trim()
  }
  return { path, phrase: phrase }
}

/** A fresh, account-less context standing in for the recipient's browser, landed
 * on the file-open entry (`#/s`, no fragment). */
async function freshRecipient(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/#/s')
  await expect(page.getByTestId('share-file-open')).toBeVisible()
  return page
}

test('passphrase file: export, then open cold with the phrase and see verified data', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await onboardViaUI(ownerPage)
  await connectRelayViaUI(ownerPage)
  await logBP(ownerPage, '128', '82')
  await logFood(ownerPage, 'oatmeal')

  const { path, phrase } = await saveShareFile(ownerPage, { passphrase: true })
  expect(phrase).not.toBeNull()
  expect(phrase!.split(' ')).toHaveLength(7) // ≥ 64 bits over the 1296-word list

  // The saved file shows up in the owner's history, marked unrevocable.
  await ownerPage.getByTestId('share-done').click()
  await expect(ownerPage.getByTestId('file-share-list')).toContainText('unrevocable')

  // A fresh browser opens the file through the picker and enters the phrase.
  const docPage = await freshRecipient(browser)
  await docPage.getByTestId('file-share-input').setInputFiles(path)
  await expect(docPage.getByTestId('file-passphrase-input')).toBeVisible()
  await docPage.getByTestId('file-passphrase-input').fill(phrase!)
  await docPage.getByTestId('file-passphrase-submit').click()

  await expect(docPage.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({
    timeout: 15_000,
  })
  // BP pair (2) + food (1), all signatures verify against the owner's key.
  await expect(docPage.getByTestId('share-verify')).toContainText('3 records verified')
  await expect(docPage.getByTestId('clinician-summary')).toContainText('128/82')

  // Cold load: nothing vault-like ever booted in the recipient's tab.
  await expect(docPage.getByTestId('generate-mnemonic')).toHaveCount(0)
  await expect(docPage.getByTestId('nav-settings')).toHaveCount(0)

  await ownerContext.close()
  await docPage.context().close()
})

test('passphrase file: a wrong phrase is a friendly retry, the right one opens', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await onboardViaUI(ownerPage)
  await connectRelayViaUI(ownerPage)
  await logBP(ownerPage, '120', '80')

  const { path, phrase } = await saveShareFile(ownerPage, { passphrase: true })

  const docPage = await freshRecipient(browser)
  await docPage.getByTestId('file-share-input').setInputFiles(path)

  // Wrong phrase: the file stays closed and the retry message shows — no data.
  await docPage.getByTestId('file-passphrase-input').fill('these are not the right words at all')
  await docPage.getByTestId('file-passphrase-submit').click()
  await expect(docPage.getByTestId('file-passphrase-error')).toBeVisible()
  await expect(docPage.getByRole('heading', { name: 'Shared medical record' })).toHaveCount(0)

  // The real phrase then opens it — same input, no re-picking the file.
  await docPage.getByTestId('file-passphrase-input').fill(phrase!)
  await docPage.getByTestId('file-passphrase-submit').click()
  await expect(docPage.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({
    timeout: 15_000,
  })
  await expect(docPage.getByTestId('clinician-summary')).toContainText('120/80')

  await ownerContext.close()
  await docPage.context().close()
})

test('embedded file without a relay: possession is access, opens straight from the picker', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  // Deliberately NO relay: a file share needs none — that is the point.
  await onboardViaUI(ownerPage)
  await logBP(ownerPage, '118', '76')

  const { path, phrase } = await saveShareFile(ownerPage, {
    passphrase: false,
    // With no relay the link option is disabled and the sheet is file-only.
    beforeSave: async () => {
      await expect(ownerPage.getByTestId('delivery-link')).toBeDisabled()
    },
  })
  expect(phrase).toBeNull()
  // Embedded mode shows the honest "anyone can open it" note, no passphrase box.
  await expect(ownerPage.getByTestId('file-embedded-note')).toBeVisible()
  await expect(ownerPage.getByTestId('file-share-passphrase-box')).toHaveCount(0)

  const docPage = await freshRecipient(browser)
  await docPage.getByTestId('file-share-input').setInputFiles(path)
  // Embedded: opens directly, no passphrase prompt.
  await expect(docPage.getByTestId('file-passphrase-input')).toHaveCount(0)
  await expect(docPage.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({
    timeout: 15_000,
  })
  await expect(docPage.getByTestId('clinician-summary')).toContainText('118/76')

  await ownerContext.close()
  await docPage.context().close()
})

test('a damaged file is honestly reported, not silently rendered', async ({ browser }) => {
  const docPage = await freshRecipient(browser)
  // A file that is not a Svastha share at all.
  await docPage.getByTestId('file-share-input').setInputFiles({
    name: 'not-a-share.svashare',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('this is not a share bundle'),
  })
  await expect(docPage.getByTestId('file-share-damaged')).toBeVisible()
  await expect(docPage.getByRole('heading', { name: 'Shared medical record' })).toHaveCount(0)

  await docPage.context().close()
})
