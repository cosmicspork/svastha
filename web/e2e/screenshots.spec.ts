import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, openLog, RELAY } from './helpers'

// On-demand README screenshot capture (docs/screenshots/), not a CI test:
//   cd web && SCREENSHOTS=1 bunx playwright test screenshots.spec.ts
// Drives the real app against the e2e relay with the same synthetic fixtures
// the test suite uses, at a phone viewport, and overwrites the committed
// images — re-run after UI changes so the README never drifts.
test.skip(!process.env.SCREENSHOTS, 'screenshot capture runs on demand, not in CI')

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

const OUT = '../docs/screenshots'
const XDM_ZIP = '../fixtures/xdm/minimal-xdm.zip'
const FHIR_BUNDLE = '../fixtures/fhir/bundle-minimal.json'

/** A synthetic "paper lab report" rendered in-browser — clearly fake data, but
 * shaped like the real thing so the provenance viewer screenshot reads true. */
async function fakeLabReportPng(page: Page): Promise<Buffer> {
  await page.setContent(`
    <div style="width:780px;padding:48px;font-family:Georgia,serif;background:#fff;color:#1a1a1a">
      <div style="display:flex;justify-content:space-between;border-bottom:3px solid #1a1a1a;padding-bottom:12px">
        <div><b style="font-size:20px">RIVERSIDE CLINICAL LABORATORY</b><br>
        <span style="font-size:13px">40 Sample Way &middot; Synthetic City</span></div>
        <div style="font-size:13px;text-align:right">Collected: 21 Jul 2026<br>Reported: 22 Jul 2026</div>
      </div>
      <p style="font-size:14px">Patient: <b>Alex Example</b> &nbsp; DOB: 01 Jan 1980 &nbsp; MRN: 000-0000</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="border-bottom:1px solid #999;text-align:left">
          <th style="padding:6px 0">Test</th><th>Result</th><th>Units</th><th>Reference</th></tr>
        <tr><td style="padding:6px 0">Hemoglobin A1c</td><td><b>5.6</b></td><td>%</td><td>4.0 – 5.6</td></tr>
        <tr><td style="padding:6px 0">Total cholesterol</td><td><b>182</b></td><td>mg/dL</td><td>&lt; 200</td></tr>
        <tr><td style="padding:6px 0">Vitamin D, 25-OH</td><td><b>31</b></td><td>ng/mL</td><td>30 – 100</td></tr>
      </table>
      <p style="font-size:11px;color:#777;margin-top:40px">Synthetic sample for documentation — not a real record.</p>
    </div>`)
  const shot = await page.locator('div').first().screenshot({ type: 'png' })
  await page.goto('about:blank')
  return shot
}

async function importFixtures(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import'
  })
  await page.getByTestId('import-file-input').setInputFiles([XDM_ZIP, FHIR_BUNDLE])
  await expect(page.getByTestId('import-totals')).toContainText('22 new')
  await page.getByTestId('import-commit').click()
  await expect(page.getByTestId('import-done')).toContainText('22')
  await page.getByTestId('import-view-timeline').click()
}

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

  // The same deposit shape proposals.spec.ts uses: a real sealed `proposal`
  // envelope through the live relay, drafts mirroring the fake report.
  await page.evaluate(
    async ({ relay, words, sourceBlob }) => {
      const { initSvastha, WasmIdentity, event_id } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      const { fromHex } = await import('/src/lib/hex.ts')
      const { put } = await import('/src/lib/db.ts')
      await initSvastha()
      const owner = WasmIdentity.from_mnemonic(words.join(' '), '')
      const proposer = WasmIdentity.generate()
      const drafts = [
        { code: { system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }, v: '5.6' },
        { code: { system: 'http://loinc.org', code: '2093-3', display: 'Total cholesterol' }, v: '182' },
      ]
      const proposals = drafts.map((d) => {
        const content = {
          kind: 'observation',
          code: d.code,
          effective_at: '2026-07-21T09:00:00+00:00',
          value: { quantity: { value: d.v, unit: null } },
          provenance: { source: 'Home node', source_doc: null },
        }
        return {
          event: { id: event_id(JSON.stringify(content)), ...content },
          source_blob: sourceBlob,
          method: 'ocr',
          model: 'vision-1',
        }
      })
      const body = new TextEncoder().encode(JSON.stringify({ proposals }))
      const envelope = proposer.seal_message(
        fromHex(owner.x25519_public_hex),
        'proposal',
        Date.now(),
        body,
      )
      const client = new RelayClient(relay, proposer)
      await client.putMailbox(
        owner.ed25519_public_hex,
        `proposal-${Date.now()}`,
        new TextEncoder().encode(envelope),
      )
      await put('proposers', {
        ed: proposer.ed25519_public_hex,
        x25519: proposer.x25519_public_hex,
        label: 'Home node',
        kind: 'node',
      })
    },
    { relay: RELAY, words, sourceBlob },
  )

  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/settings/sync'))
    await page.getByTestId('sync-now').click()
    await page.waitForTimeout(300)
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft').first()).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
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

  const node = await page.evaluate(async () => {
    const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
    const { put } = await import('/src/lib/db.ts')
    await initSvastha()
    const n = WasmIdentity.generate()
    await put('proposers', {
      ed: n.ed25519_public_hex,
      x25519: n.x25519_public_hex,
      label: 'Home node',
      kind: 'node',
    })
    return { ed: n.ed25519_public_hex, mnemonic: n.mnemonic ?? '' }
  })

  await page.getByTestId('nav-ask').click()
  await page.getByTestId('ask-input').fill('How has my blood pressure been lately?')
  await page.getByTestId('ask-send').click()
  await expect(page.getByTestId('ask-waiting')).toBeVisible()

  await page.evaluate(
    async ({ relay, words, nodeMnemonic, text, citations }) => {
      const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      const { fromHex } = await import('/src/lib/hex.ts')
      await initSvastha()
      const owner = WasmIdentity.from_mnemonic(words.join(' '), '')
      const node = WasmIdentity.from_mnemonic(nodeMnemonic, '')
      const body = new TextEncoder().encode(JSON.stringify({ role: 'answer', text, citations }))
      const envelope = node.seal_message(
        fromHex(owner.x25519_public_hex),
        'chat_msg',
        Date.now(),
        body,
      )
      const client = new RelayClient(relay, node)
      await client.putMailbox(
        owner.ed25519_public_hex,
        `chat-${Date.now()}`,
        new TextEncoder().encode(envelope),
      )
    },
    {
      relay: RELAY,
      words,
      nodeMnemonic: node.mnemonic,
      text: 'Your one recent reading, 118/76 on 24 Jul, is in the normal range.',
      citations: [eventId],
    },
  )

  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/ask'))
    await expect(page.getByTestId('ask-turn').filter({ hasText: 'normal range' })).toBeVisible({
      timeout: 2000,
    })
  }).toPass({ timeout: 20_000 })
  await page.screenshot({ path: `${OUT}/ask.png` })
})
