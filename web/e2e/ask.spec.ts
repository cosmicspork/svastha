import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logFood, RELAY } from './helpers'

// Nothing produces answers in production yet (the node's RAG is a later PR), so
// the fixture *is* a real node: a freshly-generated identity that seals a real
// `chat_msg` answer (via the wasm bindings) to the owner and deposits it through
// the live relay — the exact bytes the node will send — and seeds the owner's
// directory so the ask screen resolves it as the enrolled node. Runs the real
// client modules in the browser, like proposals.spec.ts / relay.spec.ts.

interface NodeHandle {
  ed: string
  mnemonic: string
}

/** Seed the owner's granted-identity directory with a node-kind proposer (what
 * enrollment/C1 writes in production) and return its identity so the fixture can
 * later seal an answer as that same node. */
async function seedNode(page: Page, ownerWords: string[]): Promise<NodeHandle> {
  return page.evaluate(
    async ({ words }) => {
      const { initSvastha, WasmIdentity } = await import('/src/lib/svastha.ts')
      const { put } = await import('/src/lib/db.ts')
      await initSvastha()
      // Reference the owner so the arg is used; the node is what we enroll.
      WasmIdentity.from_mnemonic(words.join(' '), '')
      const node = WasmIdentity.generate()
      await put('proposers', {
        ed: node.ed25519_public_hex,
        x25519: node.x25519_public_hex,
        label: 'Home node',
        kind: 'node',
      })
      return { ed: node.ed25519_public_hex, mnemonic: node.mnemonic ?? '' }
    },
    { words: ownerWords },
  )
}

/** Seal a `chat_msg` answer (as the enrolled node) citing `citations`, and
 * deposit it in the owner's mailbox through the live relay. */
async function depositAnswer(
  page: Page,
  ownerWords: string[],
  nodeMnemonic: string,
  text: string,
  citations: string[],
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
    { relay: RELAY, words: ownerWords, nodeMnemonic, text, citations },
  )
}

/** Re-mount the ask screen (its onMount pulls the mailbox) until `check` passes —
 * the pull and store fan-out are async, and the push channel is lossy. */
async function pullAskUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/ask'))
    await check()
  }).toPass({ timeout: 20_000 })
}

test('asks a question, receives a cited answer, and deep-links the citation', async ({ page }) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // A real, citable event in the owner's own record.
  await logFood(page, 'oatmeal')
  const eventId = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const events = (await getAll('events')) as { event: { id: string } }[]
    return events[0].event.id
  })

  const node = await seedNode(page, words)

  // Open the ask screen from Home; a node is enrolled, so the composer shows.
  await page.getByTestId('nav-ask').click()
  await expect(page.getByTestId('ask-disclaimer')).toContainText('not medical advice')

  // Ask a question — the user turn lands and the state is honestly "waiting".
  await page.getByTestId('ask-input').fill('What did I eat?')
  await page.getByTestId('ask-send').click()
  await expect(page.getByTestId('ask-turn').filter({ hasText: 'What did I eat?' })).toBeVisible()
  await expect(page.getByTestId('ask-waiting')).toBeVisible()

  // The node answers (fixture), citing the oatmeal event.
  await depositAnswer(page, words, node.mnemonic, 'You logged oatmeal on the 24th.', [eventId])
  await pullAskUntil(page, async () => {
    await expect(
      page.getByTestId('ask-turn').filter({ hasText: 'You logged oatmeal' }),
    ).toBeVisible({ timeout: 2000 })
  })

  // The citation renders and deep-links to the event on the spine, highlighted.
  const citation = page.getByTestId('citation').first()
  await expect(citation).toContainText('oatmeal')
  await citation.click()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.locator('[data-testid="spine-entry"][data-highlighted="true"]')).toContainText(
    'oatmeal',
  )
})

test('shows the no-node empty state until a processing node is enrolled', async ({ page }) => {
  await onboardViaUI(page)

  await page.getByTestId('nav-ask').click()
  await expect(page.getByTestId('ask-no-node')).toBeVisible()
  await expect(page.getByTestId('ask-go-enroll')).toBeVisible()
  // No composer while there is nothing to ask.
  await expect(page.getByTestId('ask-input')).toHaveCount(0)
})
