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

      // One hour apart starting 2026-07-20T09:00Z, computed rather than
      // templated so this scales past 10 drafts (the pagination fixtures need
      // more than a page's worth) without the day digit overflowing.
      const isoAt = (i: number): string => {
        const d = new Date(Date.UTC(2026, 6, 20, 9, 0, 0) + i * 3_600_000)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
      }

      const proposals = drafts.map((d, i) => {
        const content = {
          kind: 'observation',
          code: d.code ?? null,
          effective_at: isoAt(i),
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

/** Same as `depositProposal`, but from a single proposer identity across
 * several smaller envelopes (the relay caps a mailbox item at 4KB — see
 * `MAILBOX_MAX_BODY` in crates/relay — so a group large enough to paginate
 * has to arrive as multiple `proposal` messages, exactly as a real node
 * batching a big OCR run would send it). Drafts split across messages still
 * group under one proposer section in the inbox (grouping is by `fromEd`,
 * not by message), which is what the pagination window flattens over. */
async function depositManyProposals(
  page: Page,
  ownerWords: string[],
  drafts: DraftSpec[],
  chunkSize = 5,
  proposerMnemonic?: string,
  mailboxItemPrefix = 'proposal',
): Promise<Deposited> {
  return page.evaluate(
    async ({ relay, words, drafts, chunkSize, proposerMnemonic, mailboxItemPrefix }) => {
      const { initSvastha, WasmIdentity, event_id } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      const { fromHex } = await import('/src/lib/hex.ts')
      const { put } = await import('/src/lib/db.ts')
      await initSvastha()

      const owner = WasmIdentity.from_mnemonic(words.join(' '), '')
      const proposer = proposerMnemonic
        ? WasmIdentity.from_mnemonic(proposerMnemonic, '')
        : WasmIdentity.generate()
      const client = new RelayClient(relay, proposer)

      const isoAt = (i: number): string => {
        const d = new Date(Date.UTC(2026, 6, 20, 9, 0, 0) + i * 3_600_000)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
      }

      const allEventIds: string[] = []
      for (let start = 0; start < drafts.length; start += chunkSize) {
        const chunk = drafts.slice(start, start + chunkSize)
        const proposals = chunk.map((d, j) => {
          const i = start + j
          const content = {
            kind: 'observation',
            code: d.code ?? null,
            effective_at: isoAt(i),
            value: d.value,
            provenance: { source: 'Home node', source_doc: null },
          }
          const id = event_id(JSON.stringify(content))
          allEventIds.push(id)
          return { event: { id, ...content }, method: 'ocr', model: 'vision-1' }
        })

        const body = new TextEncoder().encode(JSON.stringify({ proposals }))
        const envelope = proposer.seal_message(
          fromHex(owner.x25519_public_hex),
          'proposal',
          Date.now(),
          body,
        )
        await client.putMailbox(
          owner.ed25519_public_hex,
          `${mailboxItemPrefix}-${start}`,
          new TextEncoder().encode(envelope),
        )
      }

      await put('proposers', {
        ed: proposer.ed25519_public_hex,
        x25519: proposer.x25519_public_hex,
        label: 'Home node',
      })

      return {
        proposerEd: proposer.ed25519_public_hex,
        proposerMnemonic: proposer.mnemonic ?? '',
        eventIds: allEventIds,
      }
    },
    { relay: RELAY, words: ownerWords, drafts, chunkSize, proposerMnemonic, mailboxItemPrefix },
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

/** Like `readProposalResult`, but for a proposer whose drafts arrived as
 * several messages (`depositManyProposals`) — one `proposal_result` is echoed
 * per resolved message, so this reads and aggregates all of them. */
async function readAllProposalResults(
  page: Page,
  proposerMnemonic: string,
): Promise<{ proposal_id: string; accepted: string[]; rejected: string[] }[]> {
  return page.evaluate(
    async ({ relay, mnemonic }) => {
      const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
      const { RelayClient } = await import('/src/lib/relay.ts')
      await initSvastha()
      const proposer = WasmIdentity.from_mnemonic(mnemonic, '')
      const client = new RelayClient(relay, proposer)
      const items = await client.listMailbox()
      const results = []
      for (const item of items) {
        if (!item.id.startsWith('proposal-result-')) continue
        const fetched = await client.getMailbox(item.id)
        if (!fetched) continue
        const envelopeJson = new TextDecoder().decode(fetched.blob)
        const body = proposer.open_message(envelopeJson)
        results.push(JSON.parse(new TextDecoder().decode(body)))
      }
      return results
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

  await syncUntil(page, async () => {
    await expect(page.getByTestId('notification-badge')).toBeVisible({ timeout: 2000 })
  })
  await page.getByTestId('nav-notifications').click()
  await expect(page.getByTestId('notifications-list')).toContainText('waiting for review')
  await page.getByTestId('notification-item').filter({ hasText: 'waiting for review' }).first().click()
  await expect(page).toHaveURL(/#\/proposals$/)

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

  await draft('Headache').getByTestId('draft-approve').click()
  await expect(draft('Headache').getByTestId('draft-decided')).toHaveText('Approved')

  await draft('Fatigue').getByTestId('draft-edit').click()
  await draft('Fatigue').getByTestId('draft-edit-value').fill('3')
  await draft('Fatigue').getByTestId('draft-save-approve').click()
  await expect(draft('Fatigue').getByTestId('draft-decided')).toHaveText('Approved')

  // Rejecting resolves the whole proposal, so the inbox empties.
  await draft('Nausea').getByTestId('draft-reject').click()
  await expect(page.getByTestId('proposals-empty')).toBeVisible()

  // Approved facts are on the spine (its own Timeline page); the rejected one is not.
  await page.evaluate(() => (window.location.hash = '#/timeline'))
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

test('paginates a large group and confirms approve-all via the sheet, including hidden drafts (M5)', async ({
  page,
}) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // One page (20) plus a partial second page (3) — enough to exercise both
  // "Show 20 more" and the count remaining after it. Split across several
  // messages (depositManyProposals) so no single mailbox item trips the
  // relay's 4KB cap; they still land under one proposer group.
  const drafts = Array.from({ length: 23 }, (_, i) => ({ value: { text: `Entry ${i}` } }))
  // "Entry 1" is a prefix of "Entry 10".."Entry 19" as plain substring text,
  // so filters below match on the whole label with a word boundary instead.
  const entry = (i: number) => page.getByTestId('proposal-draft').filter({ hasText: new RegExp(`\\bEntry ${i}\\b`) })
  const deposited = await depositManyProposals(page, words, drafts)

  await syncUntil(page, async () => {
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft')).toHaveCount(20)
  })

  await expect(page.getByTestId('proposer-show-more')).toHaveText('Show 20 more (3 left)')

  // Approving a visible draft must not shift the pagination boundary: the
  // window stays at 20 (the decided row stays put, dimmed) and "3 left" is
  // unchanged — nothing from the hidden tail jumps into view or gets skipped.
  await entry(0).getByTestId('draft-approve').click()
  await expect(page.getByTestId('proposal-draft')).toHaveCount(20)
  await expect(page.getByTestId('draft-decided')).toHaveText('Approved')
  await expect(page.getByTestId('proposer-show-more')).toHaveText('Show 20 more (3 left)')

  await page.getByTestId('proposer-show-more').click()
  await expect(page.getByTestId('proposal-draft')).toHaveCount(23)
  await expect(page.getByTestId('proposer-show-more')).toHaveCount(0)
  // No duplicates and nothing skipped: every entry still appears exactly once.
  for (let i = 0; i < 23; i++) {
    await expect(entry(i)).toHaveCount(1)
  }

  // 22 still pending (one was approved above already).
  await expect(page.getByTestId('proposer-approve-all')).toHaveText('Approve all (22)')

  // Cancel leaves everything untouched.
  await page.getByTestId('proposer-approve-all').click()
  await expect(page.getByTestId('approve-all-heading')).toHaveText('Approve 22 entries?')
  await expect(page.getByText('Each one is signed with your key')).toBeVisible()
  await page.getByTestId('approve-all-cancel').click()
  await expect(page.getByTestId('approve-all-heading')).toHaveCount(0)
  await expect(page.getByTestId('draft-decided')).toHaveCount(1) // still just the one from earlier

  // "Review one by one" is the same escape hatch, dismissing without deciding.
  await page.getByTestId('proposer-approve-all').click()
  await page.getByTestId('approve-all-review').click()
  await expect(page.getByTestId('approve-all-heading')).toHaveCount(0)
  await expect(page.getByTestId('draft-decided')).toHaveCount(1)

  // Confirming approves every pending draft in the group, including the 3
  // that were never scrolled into view.
  await page.getByTestId('proposer-approve-all').click()
  await page.getByTestId('approve-all-confirm').click()
  await expect(page.getByTestId('proposals-empty')).toBeVisible()

  const results = await readAllProposalResults(page, deposited.proposerMnemonic)
  const accepted = results.flatMap((r) => r.accepted)
  const rejected = results.flatMap((r) => r.rejected)
  expect(accepted.sort()).toEqual([...deposited.eventIds].sort())
  expect(rejected).toEqual([])

  // A completed group is removed from the pending store. When that identity
  // proposes another large batch later, its new inbox should start at page one,
  // rather than inheriting the now-absent group's expanded window.
  const followUpDrafts = Array.from({ length: 23 }, (_, i) => ({
    value: { text: `Follow-up entry ${i}` },
  }))
  await depositManyProposals(
    page,
    words,
    followUpDrafts,
    5,
    deposited.proposerMnemonic,
    'proposal-follow-up',
  )
  await syncUntil(page, async () => {
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft')).toHaveCount(20)
  })

  // A concurrent decision can make an open sheet's group disappear. That
  // abandoned confirmation must not re-open on a later batch from the same
  // identity — it was never confirmation for that batch.
  await page.getByTestId('proposer-approve-all').click()
  await expect(page.getByTestId('approve-all-heading')).toHaveText('Approve 23 entries?')
  await page.evaluate(async () => {
    // This must run in the app's browser context to simulate another client
    // updating the shared IndexedDB state.
    const { listProposals, setDraftStatus } = await import('/src/lib/proposals.ts')
    for (const record of await listProposals()) {
      for (const draft of record.drafts) {
        await setDraftStatus(record.id, draft.event.id, 'rejected')
      }
    }
  })
  await expect(page.getByTestId('proposals-empty')).toBeVisible()

  await depositManyProposals(
    page,
    words,
    [{ value: { text: 'Final entry 0' } }, { value: { text: 'Final entry 1' } }],
    5,
    deposited.proposerMnemonic,
    'proposal-final',
  )
  await syncUntil(page, async () => {
    await page.evaluate(() => (window.location.hash = '#/proposals'))
    await expect(page.getByTestId('proposal-draft')).toHaveCount(2)
  })
  await expect(page.getByTestId('approve-all-heading')).toHaveCount(0)
})
