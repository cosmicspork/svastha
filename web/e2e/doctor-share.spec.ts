import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, logFood, PASSPHRASE, RELAY } from './helpers'

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

// Relative to the cwd Playwright runs from (`web/`), same fixture import.spec.ts
// uses.
const FHIR_BUNDLE = '../fixtures/fhir/bundle-minimal.json'

// Owner-side doctor share, end to end against the live relay: log an event,
// mint a share through the real UI, then confirm the relay serves the sealed
// bundle by its bearer token and that it opens under the link's key with the
// AAD the contract pins (the token bytes). This is the seal + upload half of
// the pinned share contract the recipient view consumes.
test('create a doctor share and fetch the sealed bundle from the relay', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '128', '82')

  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()

  // Default scope (everything), default 7-day expiry.
  await page.getByTestId('share-create').click()

  await expect(page.getByTestId('share-link')).toBeVisible()
  await expect(page.getByTestId('share-qr').locator('svg')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()

  // Link shape: {origin}/#/s/{token}.{key}.{relay}, three dot segments.
  const frag = link.split('/#/s/')[1]
  const [token, keySeg, relaySeg] = frag.split('.')
  expect(token.length).toBeGreaterThanOrEqual(22)
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/)

  // The relay serves the bundle unauthenticated by token, and it opens under
  // the key + token-AAD from the link into the pinned bundle JSON.
  const bundle = await page.evaluate(
    async ({ relay, token, keySeg, relaySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        const bin = atob(b64 + pad)
        return Uint8Array.from(bin, (c) => c.charCodeAt(0))
      }
      const relayOrigin = new TextDecoder().decode(b64urlToBytes(relaySeg))
      const res = await fetch(`${relayOrigin}/v0/share/${token}`)
      if (res.status !== 200) return { status: res.status }
      const sealed = new Uint8Array(await res.arrayBuffer())

      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      const aad = new TextEncoder().encode(token)
      const json = new TextDecoder().decode(key.open(sealed, aad))
      const parsed = JSON.parse(json)
      return {
        status: 200,
        relayMatches: relayOrigin === relay,
        v: parsed.v,
        signerLen: b64urlToBytes(parsed.signer).length,
        eventCount: parsed.events.length,
        firstAuthorIsHex: /^[0-9a-f]{64}$/.test(parsed.events[0]?.author ?? ''),
      }
    },
    { relay: RELAY, token, keySeg, relaySeg },
  )

  expect(bundle.status).toBe(200)
  expect(bundle.relayMatches).toBe(true)
  expect(bundle.v).toBe(1)
  expect(bundle.signerLen).toBe(32) // 32-byte Ed25519 public key
  expect(bundle.eventCount).toBeGreaterThanOrEqual(2) // the BP pair
  expect(bundle.firstAuthorIsHex).toBe(true)

  // Revoke, and the relay stops serving the bundle (410 Gone). The manage list
  // lives on the Doctor screen now, so close the sheet (Done) to reveal it.
  await page.getByTestId('share-done').click()
  await page.getByTestId(`revoke-${token}`).click()
  await expect(page.getByTestId(`share-status-${token}`)).toHaveText('revoked')
  const afterRevoke = await page.request.get(`${RELAY}/v0/share/${token}`, { failOnStatusCode: false })
  expect(afterRevoke.status()).toBe(410)
})

// Sensitive-by-default: cycle rides along only when the owner opts it in. The
// default share must not carry a period-start event, and the preview must not
// grow a cycle section until the opt-in toggle is on. This is the privacy
// guarantee of the sensitive-sharing work, exercised end to end against the
// live relay.
test('doctor share opt-in: cycle is excluded by default and included only when toggled on', async ({
  page,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '118', '76')

  // The cycle log form lands in a sibling PR, so seed a period-start event
  // through the same signed-append path the UI uses (logEvent), not the DB
  // directly — a real signed StoredEvent is what the share must exclude.
  await page.evaluate(async () => {
    const { logEvent } = await import('/src/lib/events.ts')
    const { CYCLE_START } = await import('/src/lib/codes.ts')
    await logEvent([
      { kind: 'observation', code: CYCLE_START, effective_at: '2026-07-01T09:00:00+00:00', value: null },
    ])
  })

  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()

  // Default scope (all non-sensitive chips selected, opt-in off): the preview
  // carries no cycle section.
  await page.getByTestId('share-preview-toggle').click()
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
  await expect(page.getByTestId('summary-section-cycle')).toHaveCount(0)

  // Create the default share and confirm the sealed bundle carries no cycle event.
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  const frag = link.split('/#/s/')[1]
  const [token, keySeg, relaySeg] = frag.split('.')

  const defaultBundle = await page.evaluate(
    async ({ token, keySeg, relaySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0))
      }
      const relayOrigin = new TextDecoder().decode(b64urlToBytes(relaySeg))
      const res = await fetch(`${relayOrigin}/v0/share/${token}`)
      const sealed = new Uint8Array(await res.arrayBuffer())
      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      const json = new TextDecoder().decode(key.open(sealed, new TextEncoder().encode(token)))
      const parsed = JSON.parse(json)
      return {
        eventCount: parsed.events.length,
        hasCycle: parsed.events.some((e: { event?: { code?: { code?: string } } }) => e?.event?.code?.code === 'cycle-start'),
      }
    },
    { token, keySeg, relaySeg },
  )

  expect(defaultBundle.hasCycle).toBe(false) // the privacy guarantee
  expect(defaultBundle.eventCount).toBeGreaterThanOrEqual(2) // the BP pair, cycle excluded

  // Turn Cycle on and the preview grows a cycle section over the same events.
  await page.getByTestId('share-another').click()
  await page.getByTestId('optin-cycle').click()
  await page.getByTestId('share-preview-toggle').click()
  await expect(page.getByTestId('summary-section-cycle')).toBeVisible()
})

// The create half above and share-recipient.spec.ts's cold-load half were each
// written on their own branch, so neither could exercise the seam: a real
// share minted through the UI, opened by a browser that never ran Svastha, and
// reading data it actually decrypted. This is that seam, plus revocation
// closing the door on an already-open recipient tab.
test('doctor share: create in one browser, read decrypted data in a fresh one, then revoke closes the door', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await onboardViaUI(ownerPage)
  await connectRelayViaUI(ownerPage)

  // Two events of different kinds so the shared bundle is more than the BP
  // pair alone.
  await logBP(ownerPage, '128', '82')
  await logFood(ownerPage, 'oatmeal')

  await ownerPage.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await ownerPage.getByTestId('new-doctor-link').click()
  await ownerPage.getByTestId('share-create').click()

  await expect(ownerPage.getByTestId('share-link')).toBeVisible()
  const link = (await ownerPage.getByTestId('share-link').innerText()).trim()
  const token = link.split('/#/s/')[1].split('.')[0]

  // A fresh context, standing in for the doctor's browser: it has never run
  // Svastha and holds no vault of its own.
  const doctorContext = await browser.newContext()
  const doctorPage = await doctorContext.newPage()
  await doctorPage.goto(link)

  await expect(doctorPage.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({
    timeout: 15_000,
  })
  // The BP (2 events) plus the food log (1 event): all three verify.
  await expect(doctorPage.getByTestId('share-verify')).toContainText('3 records verified')
  await expect(doctorPage.getByTestId('clinician-summary')).toContainText('128/82')

  // Cold load: nothing vault-like ever booted in the doctor's tab.
  await expect(doctorPage.getByTestId('generate-mnemonic')).toHaveCount(0)
  await expect(doctorPage.getByTestId('nav-settings')).toHaveCount(0)

  // Owner revokes from the manage list on the Doctor screen (close the result
  // sheet with Done first, same as the create-only test above).
  await ownerPage.getByTestId('share-done').click()
  await ownerPage.getByTestId(`revoke-${token}`).click()
  await expect(ownerPage.getByTestId(`share-status-${token}`)).toHaveText('revoked')

  // The doctor's already-open tab, reloaded, now gets the honest
  // expired-or-withdrawn state instead of data.
  await doctorPage.reload()
  await expect(doctorPage.getByTestId('share-error')).toBeVisible({ timeout: 15_000 })
  await expect(doctorPage.getByTestId('share-error')).toContainText('expired or was withdrawn')

  await ownerContext.close()
  await doctorContext.close()
})

// The split puts management first: existing links live on the Doctor screen,
// not behind the create sheet. A fresh visit lists them and revokes in place —
// no need to open "New link" at all.
test('the Doctor screen lists and revokes an existing link without opening the create sheet', async ({
  page,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '118', '76')

  // Mint one link, then close the sheet so only the manage list remains.
  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  const token = link.split('/#/s/')[1].split('.')[0]
  await page.getByTestId('share-done').click()

  // Re-enter the screen cold: the create sheet is not open (no create button on
  // screen), yet the link is listed and shows the honest revocation caveat.
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await expect(page.getByTestId(`share-status-${token}`)).toHaveText('active')
  await expect(page.getByTestId('share-create')).toHaveCount(0)
  await expect(page.getByTestId('doctor-honest')).toBeVisible()

  // Copy link and Show QR work straight from the list.
  await expect(page.getByTestId(`reshow-copy-${token}`)).toBeVisible()
  await page.getByTestId(`reshow-qr-${token}`).click()
  await expect(page.getByTestId(`reshow-qr-svg-${token}`).locator('svg')).toBeVisible()

  // Revoke in place — the row flips to revoked and the relay stops serving it.
  await page.getByTestId(`revoke-${token}`).click()
  await expect(page.getByTestId(`share-status-${token}`)).toHaveText('revoked')
  const afterRevoke = await page.request.get(`${RELAY}/v0/share/${token}`, {
    failOnStatusCode: false,
  })
  expect(afterRevoke.status()).toBe(410)
})

// The finale: the owner's signed concept curation crosses the vault boundary
// inside a share, and the recipient renders the owner's real Current/Past split
// and name override — verified against the same signer that signed the events.
// Exercises the whole chain end to end: mark a med past and rename another
// through the owner's summary (real signed `cur-` writes), then mint two shares
// (default current-only, and include-past) and read each in a fresh browser.
test('doctor share carries verified curation: current-only by default, past on opt-in, and a name override', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await onboardViaUI(ownerPage)

  // Two coded meds (the quick-log form only writes free-text meds, which carry
  // no code line to demote under a rename), seeded through the signing path.
  await ownerPage.evaluate(
    async ({ rxnorm }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      await logEvent([
        { kind: 'medication_statement', code: { system: rxnorm, code: '29046', display: 'Lisinopril' }, effective_at: '2024-01-01T00:00:00+00:00', value: null },
        { kind: 'medication_statement', code: { system: rxnorm, code: '6809', display: 'Metformin' }, effective_at: '2024-02-01T00:00:00+00:00', value: null },
      ])
    },
    { rxnorm: RXNORM },
  )

  // Reload so the seeded events hydrate the summary from IndexedDB, then curate.
  await ownerPage.reload()
  await unlock(ownerPage)
  await openSummary(ownerPage)
  await expect(currentMeds(ownerPage).filter({ hasText: 'Lisinopril' })).toHaveCount(1)

  // Mark Lisinopril past (leaves Current for the collapsed Past group).
  await currentMeds(ownerPage).filter({ hasText: 'Lisinopril' }).click()
  await ownerPage.getByTestId('action-toggle-status').click()
  await expect(currentMeds(ownerPage).filter({ hasText: 'Lisinopril' })).toHaveCount(0)

  // Rename Metformin — the override leads, the code line stays demoted.
  await currentMeds(ownerPage).filter({ hasText: 'Metformin' }).click()
  await ownerPage.getByTestId('action-name-input').fill('BP + sugar combo')
  await ownerPage.getByTestId('action-save-name').click()
  await expect(currentMeds(ownerPage).filter({ hasText: 'BP + sugar combo' })).toHaveCount(1)

  // Connect the relay now (after curating) and open the share screen.
  await connectRelayViaUI(ownerPage)
  await ownerPage.evaluate(() => (window.location.hash = '#/share/doctor'))

  // --- Default scope: current-only. The recipient sees the renamed current med
  // and NO past med at all. ---
  await ownerPage.getByTestId('new-doctor-link').click()
  await ownerPage.getByTestId('share-create').click()
  await expect(ownerPage.getByTestId('share-link')).toBeVisible()
  const defaultLink = (await ownerPage.getByTestId('share-link').innerText()).trim()

  const defaultDoc = await openAsRecipient(browser, defaultLink)
  const defaultMeds = defaultDoc.getByTestId('summary-section-medications')
  await expect(defaultMeds).toContainText('BP + sugar combo')
  // The override leads with the source code demoted beneath it (#86 rendering,
  // now threaded through the read-only recipient path).
  await expect(defaultMeds).toContainText('RxNorm')
  await expect(defaultMeds).toContainText('6809')
  // Lisinopril is past — excluded entirely from the default share.
  await expect(defaultDoc.getByTestId('clinician-summary')).not.toContainText('Lisinopril')
  await expect(defaultDoc.getByTestId('meds-past-toggle')).toHaveCount(0)
  await defaultDoc.context().close()

  // --- Include past on: the recipient now sees a Past group with Lisinopril. ---
  await ownerPage.getByTestId('share-another').click()
  await ownerPage.getByTestId('share-include-past-meds').click()
  await ownerPage.getByTestId('share-create').click()
  await expect(ownerPage.getByTestId('share-link')).toBeVisible()
  const pastLink = (await ownerPage.getByTestId('share-link').innerText()).trim()

  const pastDoc = await openAsRecipient(browser, pastLink)
  await expect(pastDoc.getByTestId('summary-section-medications')).toContainText('BP + sugar combo')
  const pastToggle = pastDoc.getByTestId('meds-past-toggle')
  await expect(pastToggle).toContainText('1 past')
  await pastToggle.click()
  await expect(
    pastDoc.getByTestId('summary-section-past').getByTestId('summary-row').filter({ hasText: 'Lisinopril' }),
  ).toHaveCount(1)
  // Nothing failed verification — no dropped-curation warning.
  await expect(pastDoc.getByTestId('share-curation-warning')).toHaveCount(0)
  await pastDoc.context().close()

  await ownerContext.close()
})

// The imported source document (a `doc-` blob) rides along in a doctor share
// the same way a captured paper record (`att-`) already does: the recipient
// gets a "Source documents" row and can open the same in-app viewer over the
// bundle's inlined bytes, with no vault key or relay access of their own.
test('doctor share carries the imported source document, openable by a cold recipient', async ({
  page,
  browser,
}) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)

  await page.evaluate(() => {
    window.location.hash = '#/import'
  })
  await page.getByTestId('import-file-input').setInputFiles([FHIR_BUNDLE])
  await page.getByTestId('import-commit').click()
  await expect(page.getByTestId('import-done')).toBeVisible()

  await page.evaluate(() => {
    window.location.hash = '#/share/doctor'
  })
  await page.getByTestId('new-doctor-link').click()

  // The source document rides along by default (no category/date narrowing
  // excludes it), and the create screen counts it honestly alongside the
  // entry count.
  await expect(page.getByTestId('share-documents')).toContainText('1 document')

  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()

  const doctorPage = await openAsRecipient(browser, link)
  const docRow = doctorPage.getByTestId('share-source-doc-row')
  await expect(docRow).toContainText('bundle-minimal.json')
  await docRow.click()

  // Rendered as text (application/json, pretty-printed) — the same viewer the
  // owner's own Spine uses, over the bundle's inlined bytes rather than the
  // local `provenance` store.
  await expect(doctorPage.getByTestId('viewer-text')).toContainText('Body temperature')
  await doctorPage.getByTestId('viewer-close').click()

  await doctorPage.context().close()
})

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

async function openSummary(page: Page): Promise<void> {
  await page.getByTestId('view-summary').click()
  await expect(page.getByTestId('clinician-summary')).toBeVisible()
}

/** The Current meds group is the SummarySection titled "Medications". */
function currentMeds(page: Page) {
  return page.getByTestId('summary-section-medications').getByTestId('summary-row')
}

/** Open a share link in a fresh, account-less browser context and wait for the
 * decrypted record to render. Returns the recipient page (close its context). */
async function openAsRecipient(
  browser: import('@playwright/test').Browser,
  link: string,
): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Shared medical record' })).toBeVisible({
    timeout: 15_000,
  })
  return page
}
