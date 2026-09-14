import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logBP, PASSPHRASE, RELAY } from './helpers'

// Sharing from the pharmacy page reuses the doctor-share path, locked to
// medications. The lock is the point: someone who taps Share on a med list is
// sharing that list, and nothing inside the sheet may widen it to the rest of
// the record.

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

async function seedMixedRecord(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rxnorm }) => {
      const { logEvent } = await import('/src/lib/events.ts')
      const { CYCLE_START } = await import('/src/lib/codes.ts')
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
          kind: 'observation',
          code: CYCLE_START,
          effective_at: '2026-07-01T09:00:00+00:00',
          value: null,
        },
      ])
    },
    { rxnorm: RXNORM },
  )
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
}

async function openShareSheet(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/medications/pharmacy'
  })
  await expect(page.getByTestId('medications-pharmacy-page')).toBeVisible()
  await page.getByTestId('pharmacy-share').click()
  await expect(page.getByTestId('share-scope-locked')).toBeVisible()
}

test('shares medications only, with the scope fixed', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await logBP(page, '128', '82')
  await seedMixedRecord(page)
  await page.reload()
  await unlock(page)
  await openShareSheet(page)

  // No way to widen it from in here: the chips, the opt-ins and the date
  // pickers are not rendered at all, and the line says what is being shared.
  await expect(page.getByTestId('share-scope-locked')).toContainText('Meds')
  await expect(page.getByTestId('share-scope-locked')).toContainText('all dates')
  await expect(page.getByTestId('share-cat-vital')).toHaveCount(0)
  await expect(page.getByTestId('share-cat-med')).toHaveCount(0)
  await expect(page.getByTestId('optin-cycle')).toHaveCount(0)
  await expect(page.getByTestId('share-from')).toHaveCount(0)
  await expect(page.getByTestId('share-to')).toHaveCount(0)

  // Two med events, and neither the blood pressure pair nor the cycle event.
  await expect(page.getByTestId('share-count')).toContainText('2')

  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  const [token, keySeg] = link.split('/#/s/')[1].split('.')

  const bundle = await page.evaluate(
    async ({ relay, token, keySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        const bin = atob(b64 + pad)
        return Uint8Array.from(bin, (c) => c.charCodeAt(0))
      }
      const sealed = new Uint8Array(await (await fetch(`${relay}/v0/share/${token}`)).arrayBuffer())
      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      const json = new TextDecoder().decode(key.open(sealed, new TextEncoder().encode(token)))
      // A bundle event is a StoredEvent: the signed envelope wraps the event.
      const parsed = JSON.parse(json) as { events: { event: { kind: string } }[] }
      return { json, kinds: parsed.events.map((e) => e.event.kind) }
    },
    { relay: RELAY, token, keySeg },
  )

  // The sealed bundle itself, not just the sheet's count.
  expect(new Set(bundle.kinds)).toEqual(new Set(['medication_statement']))
  expect(bundle.json).not.toContain('8480-6') // systolic BP LOINC code
  expect(bundle.json).toContain('29046') // Lisinopril
})

test('a hidden medication stays out of a share minted from this page', async ({ page }) => {
  await onboardViaUI(page)
  await connectRelayViaUI(page)
  await seedMixedRecord(page)
  await page.reload()
  await unlock(page)
  // Writing curation needs an unlocked session, so wait for the unlock to land.
  await expect(page.getByTestId('nav-settings')).toBeVisible()

  const hiddenId = await page.evaluate(
    async ({ rxnorm }) => {
      const { allEvents } = await import('/src/lib/events.ts')
      const { setHidden } = await import('/src/lib/curation.ts')
      const metformin = (await allEvents()).find(
        (se) => se.event.code?.system === rxnorm && se.event.code?.code === '6809',
      )
      await setHidden(metformin!.event.id, true)
      return metformin!.event.id
    },
    { rxnorm: RXNORM },
  )

  await openShareSheet(page)
  // One med left of the two: the page does not show the hidden one, and neither
  // does the link it mints.
  await expect(page.getByTestId('share-count')).toContainText('1')

  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-link')).toBeVisible()
  const link = (await page.getByTestId('share-link').innerText()).trim()
  const [token, keySeg] = link.split('/#/s/')[1].split('.')

  const json = await page.evaluate(
    async ({ relay, token, keySeg }) => {
      const b64urlToBytes = (s: string) => {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        const bin = atob(b64 + pad)
        return Uint8Array.from(bin, (c) => c.charCodeAt(0))
      }
      const sealed = new Uint8Array(await (await fetch(`${relay}/v0/share/${token}`)).arrayBuffer())
      const { initSvastha, WasmDataKey } = await import('/src/lib/svastha.ts')
      await initSvastha()
      const key = WasmDataKey.from_bytes(b64urlToBytes(keySeg))
      return new TextDecoder().decode(key.open(sealed, new TextEncoder().encode(token)))
    },
    { relay: RELAY, token, keySeg },
  )

  expect(json).not.toContain(hiddenId)
  expect(json).not.toContain('6809') // Metformin
  expect(json).toContain('29046') // Lisinopril
})
