import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { onboardViaUI, connectRelayViaUI, PASSPHRASE, RELAY } from './helpers'

const PNG = fileURLToPath(new URL('./fixtures/tiny.png', import.meta.url))

// Nothing produces proposals in production yet (the node is a later PR), so the
// fixture *is* a real proposer: a freshly-generated identity that seals a real
// `proposal` envelope (via the wasm bindings) to the owner and deposits it in
// the owner's mailbox through the live relay — the exact bytes the node will
// send. Runs the real client modules in the browser, like relay.spec.ts.

interface DraftSpec {
  code?: { system: string; code: string; display: string }
  value: { text: string } | { quantity: { value: string; unit: null } }
}

interface Deposited {
  proposerEd: string
  proposerMnemonic: string
  eventIds: string[]
}

/** Seal a proposal (one envelope, N drafts) to the owner and deposit it; seed
 * the owner's proposer directory so the reply can be sealed back. Returns the
 * proposer identity (mnemonic, to reconstruct and read its own mailbox later)
 * and the drafts' content ids. */
async function depositProposal(
  page: Page,
  ownerWords: string[],
  sourceBlob: string | null,
  drafts: DraftSpec[],
): Promise<Deposited> {
  return page.evaluate(
    async ({ relay, words, sourceBlob, drafts }) => {
      const { initSvastha, WasmIdentity, event_id } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      const { fromHex } = await import('/src/lib/hex.ts')
      const { put } = await import('/src/lib/db.ts')
      await initSvastha()

      const owner = WasmIdentity.from_mnemonic(words.join(' '), '')
      const proposer = WasmIdentity.generate()

      const proposals = drafts.map((d, i) => {
        const content = {
          kind: 'observation',
          code: d.code ?? null,
          effective_at: `2026-07-2${i}T09:00:00+00:00`,
          value: d.value,
          provenance: { source: 'Home node', source_doc: null },
        }
        const id = event_id(JSON.stringify(content))
        return {
          event: { id, ...content },
          ...(sourceBlob ? { source_blob: sourceBlob } : {}),
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

      // Enrollment (C1) writes this directory in production; the fixture seeds
      // it so the owner can seal the proposal_result to the proposer's X25519.
      await put('proposers', {
        ed: proposer.ed25519_public_hex,
        x25519: proposer.x25519_public_hex,
        label: 'Home node',
      })

      return {
        proposerEd: proposer.ed25519_public_hex,
        proposerMnemonic: proposer.mnemonic ?? '',
        eventIds: proposals.map((p) => p.event.id),
      }
    },
    { relay: RELAY, words: ownerWords, sourceBlob, drafts },
  )
}

/** Click "Sync now" (which runs a full pull, including the mailbox) until
 * `check` passes — the pull and the store fan-out are async. */
async function syncUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/settings/sync'))
    await page.getByTestId('sync-now').click()
    await page.waitForTimeout(300)
    await page.evaluate(() => (window.location.hash = '#/'))
    await check()
  }).toPass({ timeout: 20_000 })
}

/** Read the proposer's own mailbox and open the one `proposal_result` back to
 * it — the owner's decision echoed to the proposer. */
async function readProposalResult(
  page: Page,
  proposerMnemonic: string,
): Promise<{ proposal_id: string; accepted: string[]; rejected: string[] } | null> {
  return page.evaluate(
    async ({ relay, mnemonic }) => {
      const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      await initSvastha()
      const proposer = WasmIdentity.from_mnemonic(mnemonic, '')
      const client = new RelayClient(relay, proposer)
      const items = await client.listMailbox()
      const item = items.find((i) => i.id.startsWith('proposal-result-'))
      if (!item) return null
      const fetched = await client.getMailbox(item.id)
      if (!fetched) return null
      const envelopeJson = new TextDecoder().decode(fetched.blob)
      const body = proposer.open_message(envelopeJson)
      return JSON.parse(new TextDecoder().decode(body))
    },
    { relay: RELAY, mnemonic: proposerMnemonic },
  )
}

const HEADACHE = { system: 'http://snomed.info/sct', code: '25064002', display: 'Headache' }
const FATIGUE = { system: 'http://snomed.info/sct', code: '84229001', display: 'Fatigue' }
const NAUSEA = { system: 'http://snomed.info/sct', code: '422587007', display: 'Nausea' }

test('reviews proposed drafts with provenance, approves/edits/rejects, and echoes a result', async ({
  page,
}) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // Capture a page so a real att- source blob exists for the provenance viewer.
  await page.getByTestId('fab').click()
  const paper = page.getByTestId('log-paper')
  if ((await paper.count()) === 0) await page.getByTestId('bloom-more').click()
  await paper.click()
  await page.getByTestId('paper-file').setInputFiles(PNG)
  await expect(page.getByTestId('paper-thumbs').locator('img')).toHaveCount(1)
  await page.getByTestId('save').click()
  await expect(page.getByTestId('spine-entry')).toHaveCount(1)

  const sourceBlob = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const atts = (await getAll('attachments')) as { sha256: string }[]
    return `att-${atts[0].sha256}`
  })

  const deposited = await depositProposal(page, words, sourceBlob, [
    { code: HEADACHE, value: { quantity: { value: '6', unit: null } } },
    { code: FATIGUE, value: { quantity: { value: '5', unit: null } } },
    { code: NAUSEA, value: { quantity: { value: '4', unit: null } } },
  ])

  // The notification center / badge surfaces it; the notification deep-links.
  await syncUntil(page, async () => {
    await expect(page.getByTestId('notification-badge')).toBeVisible({ timeout: 2000 })
  })
  await page.getByTestId('nav-notifications').click()
  await expect(page.getByTestId('notifications-list')).toContainText('waiting for review')
  await page.getByTestId('notification-item').filter({ hasText: 'waiting for review' }).first().click()
  await expect(page).toHaveURL(/#\/proposals$/)

  // Three drafts, each with its extracted fact and extraction provenance.
  await expect(page.getByTestId('proposal-draft')).toHaveCount(3)
  await expect(page.getByTestId('draft-label').first()).toHaveText('Headache')
  await expect(page.getByTestId('draft-provenance').first()).toContainText('ocr')
  await expect(page.getByTestId('draft-provenance').first()).toContainText('vision-1')

  // The source page renders in the shared attachment viewer.
  await page.getByTestId('draft-view-source').first().click()
  await expect(page.getByTestId('viewer-image')).toBeVisible()
  await page.getByTestId('viewer-close').click()

  const draft = (display: string) =>
    page.getByTestId('proposal-draft').filter({ hasText: display })

  // Approve Headache as-is.
  await draft('Headache').getByTestId('draft-approve').click()
  await expect(draft('Headache').getByTestId('draft-decided')).toHaveText('Approved')

  // Edit Fatigue's value, then approve.
  await draft('Fatigue').getByTestId('draft-edit').click()
  await draft('Fatigue').getByTestId('draft-edit-value').fill('3')
  await draft('Fatigue').getByTestId('draft-save-approve').click()
  await expect(draft('Fatigue').getByTestId('draft-decided')).toHaveText('Approved')

  // Reject Nausea. That resolves the whole proposal, so the inbox empties.
  await draft('Nausea').getByTestId('draft-reject').click()
  await expect(page.getByTestId('proposals-empty')).toBeVisible()

  // Approved facts are on the spine (signed by the owner); the rejected one is not.
  await page.evaluate(() => (window.location.hash = '#/'))
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Headache' })).toBeVisible()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Fatigue' })).toBeVisible()
  await expect(page.getByTestId('spine-entry').filter({ hasText: 'Nausea' })).toHaveCount(0)

  // The decision was echoed back to the proposer as a proposal_result.
  const result = await readProposalResult(page, deposited.proposerMnemonic)
  expect(result).not.toBeNull()
  expect(result!.accepted.sort()).toEqual([deposited.eventIds[0], deposited.eventIds[1]].sort())
  expect(result!.rejected).toEqual([deposited.eventIds[2]])
})

test('proposals persist across reload and are not re-processed on re-pull', async ({ page }) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  await depositProposal(page, words, null, [
    { code: HEADACHE, value: { quantity: { value: '6', unit: null } } },
  ])

  await syncUntil(page, async () => {
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft')).toHaveCount(1)
  })

  // A second pull of the same mailbox item must not duplicate the draft.
  await page.getByTestId('nav-back').click()
  await page.evaluate(() => (window.location.hash = '#/settings/sync'))
  await page.getByTestId('sync-now').click()
  await page.waitForTimeout(500)
  await page.evaluate(() => (window.location.hash = '#/proposals'))
  await expect(page.getByTestId('proposal-draft')).toHaveCount(1)

  // Survives a reload (persisted in IndexedDB), unlike the in-memory invite list.
  await page.evaluate(() => (window.location.hash = '#/'))
  await page.reload()
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE)
  await page.getByTestId('unlock-submit').click()
  await expect(page.getByTestId('nav-settings')).toBeVisible()
  await page.evaluate(() => (window.location.hash = '#/proposals'))
  await expect(page.getByTestId('proposal-draft')).toHaveCount(1)
})
