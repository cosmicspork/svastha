import { expect, type Page } from '@playwright/test'
import { RELAY } from './helpers'

// Synthetic content shared by the on-demand capture specs (screenshots.spec.ts
// for the README, sweep.spec.ts for the all-screens sweep). Everything here is
// invented: the fixtures under ../fixtures and a lab report drawn in-browser.

export const XDM_ZIP = '../fixtures/xdm/minimal-xdm.zip'
export const FHIR_BUNDLE = '../fixtures/fhir/bundle-minimal.json'

/** A synthetic "paper lab report" rendered in-browser — clearly fake data, but
 * shaped like the real thing so the provenance viewer screenshot reads true.
 * Replaces the page's content, so call it before onboarding. */
export async function fakeLabReportPng(page: Page): Promise<Buffer> {
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

/** Import the synthetic XDM package and FHIR bundle through the Import screen,
 * landing on the timeline. */
export async function importFixtures(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import'
  })
  await page.getByTestId('import-file-input').setInputFiles([XDM_ZIP, FHIR_BUNDLE])
  await expect(page.getByTestId('import-totals')).toContainText('22 new')
  await page.getByTestId('import-commit').click()
  await expect(page.getByTestId('import-done')).toContainText('22')
  await page.getByTestId('import-view-timeline').click()
}

/** Register a freshly generated node identity as a known proposer, the way
 * pairing would. Returns its key and mnemonic so a test can speak as it. */
export async function registerNode(page: Page): Promise<{ ed: string; mnemonic: string }> {
  return page.evaluate(async () => {
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
}

/** Deposit OCR drafts mirroring the fake lab report as a real sealed
 * `proposal` envelope through the live relay — the same shape
 * proposals.spec.ts uses — from a new proposer registered as "Home node". */
export async function depositLabProposals(page: Page, words: string[], sourceBlob: string): Promise<void> {
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
}

/** Mail the owner a cited `chat_msg` answer as the given node, as if it had
 * answered the question waiting in Search's Ask mode. */
export async function depositAnswer(
  page: Page,
  answer: { words: string[]; nodeMnemonic: string; text: string; citations: string[] },
): Promise<void> {
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
    { relay: RELAY, ...answer },
  )
}
