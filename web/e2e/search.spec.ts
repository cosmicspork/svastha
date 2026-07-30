import { test, expect, type Page } from '@playwright/test'
import { onboardViaUI, connectRelayViaUI, logFood, RELAY } from './helpers'

// Search's local half is always available; its AI half routes to an enrolled
// processing node. Nothing produces answers in production yet (the node's RAG is
// a later PR), so the fixture *is* a real node: a freshly-generated identity that
// seals a real `chat_msg` answer (via the wasm bindings) to the owner and
// deposits it through the live relay — the exact bytes the node will send — and
// seeds the owner's directory so Search resolves it as the enrolled node.

interface NodeHandle {
  ed: string
  mnemonic: string
}

/** Seed the owner's granted-identity directory with a node-kind proposer (what
 * enrollment writes in production) and return its identity so the fixture can
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
      const envelope = node.seal_message(fromHex(owner.x25519_public_hex), 'chat_msg', Date.now(), body)
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

/** Re-mount Search (its onMount pulls the mailbox) and re-enable AI mode until
 * `check` passes — the pull and store fan-out are async, and the push channel is
 * lossy. A fresh mount defaults to local mode, so the toggle is flipped on each
 * retry to reveal the transcript. */
async function pullSearchUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => (window.location.hash = '#/'))
    await page.evaluate(() => (window.location.hash = '#/search'))
    await page.getByTestId('search-ai-toggle').click()
    await check()
  }).toPass({ timeout: 20_000 })
}

test('local search finds a record entry; AI search returns a cited answer', async ({ page }) => {
  const words = await onboardViaUI(page)
  await connectRelayViaUI(page)

  // A real, citable event in the owner's own record.
  await logFood(page, 'oatmeal')
  const eventId = await page.evaluate(async () => {
    const { getAll } = await import('/src/lib/db.ts')
    const events = (await getAll('events')) as { event: { id: string } }[]
    return events[0].event.id
  })

  // Enroll the node before opening Search, so a single mount sees both the
  // record (local search) and the node (AI toggle).
  const node = await seedNode(page, words)

  await page.getByTestId('nav-search').click()
  await page.getByTestId('search-input').fill('oatmeal')
  await expect(page.getByTestId('search-hit').filter({ hasText: 'oatmeal' })).toBeVisible()
  await expect(page.getByTestId('search-mode')).toHaveText('On-device')

  await page.getByTestId('search-ai-toggle').click()
  await expect(page.getByTestId('search-mode')).toContainText('Node')

  await page.getByTestId('search-input').fill('What did I eat?')
  await page.getByTestId('search-send').click()
  await expect(page.getByTestId('search-turn').filter({ hasText: 'What did I eat?' })).toBeVisible()
  await expect(page.getByTestId('search-waiting')).toBeVisible()

  await depositAnswer(page, words, node.mnemonic, 'You logged oatmeal on the 24th.', [eventId])
  await pullSearchUntil(page, async () => {
    await expect(
      page.getByTestId('search-turn').filter({ hasText: 'You logged oatmeal' }),
    ).toBeVisible({ timeout: 2000 })
  })

  const citation = page.getByTestId('citation').first()
  await expect(citation).toContainText('oatmeal')
  await citation.click()
  await expect(page).toHaveURL(/#\/timeline$/)
  await expect(page.locator('[data-testid="spine-entry"][data-highlighted="true"]')).toContainText(
    'oatmeal',
  )
})

test('with no node enrolled, search stays local and offers no AI toggle', async ({ page }) => {
  await onboardViaUI(page)

  await page.getByTestId('nav-search').click()
  await expect(page.getByTestId('search-mode')).toHaveText('On-device')
  // No processing node → no AI switch at all.
  await expect(page.getByTestId('search-ai-toggle')).toHaveCount(0)

  // Which is exactly why the hint card is here: with no toggle to notice, it is
  // the only evidence on this screen that answering exists at all.
  const hint = page.getByTestId('search-ai-hint')
  await expect(hint).toContainText('Ask AI')
  await expect(hint).toContainText('cites your own entries')
  await page.getByTestId('search-ai-setup').click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
})

/** Point this device at an endpoint that will not answer. Written straight to
 * `prefs`, the way Settings → AI stores it. */
async function configureEndpoint(page: Page, endpoint: string): Promise<void> {
  await page.evaluate(async (url) => {
    const { put } = await import('/src/lib/db.ts')
    await put('prefs', url, 'inferenceUrl')
    await put('prefs', 'test-model', 'inferenceModel')
  }, endpoint)
}

test('a failed local answer keeps the question and leaves nothing pending behind', async ({
  page,
}) => {
  await onboardViaUI(page)
  await logFood(page, 'oatmeal')
  await configureEndpoint(page, 'https://llama.home.arpa/v1')
  // Refusing the request makes the failure immediate and independent of DNS.
  await page.route('https://llama.home.arpa/**', (route) => route.abort())

  await page.getByTestId('nav-search').click()
  // Configured, so the front-door card has nothing left to say.
  await expect(page.getByTestId('search-ai-hint')).toHaveCount(0)

  await page.getByTestId('search-ai-toggle').click()
  // The pill names where the question is going. "This device" was a lie the
  // moment the endpoint lived anywhere else.
  await expect(page.getByTestId('search-mode')).toHaveText('llama.home.arpa')
  await expect(page.getByTestId('search-ai-expectations')).toContainText('lipid panel')

  const question = 'when did I eat oatmeal?'
  await page.getByTestId('search-input').fill(question)
  await page.getByTestId('search-send').click()

  await expect(page.getByTestId('search-ask-error')).toBeVisible()
  await expect(page.getByTestId('search-ask-retry')).toBeVisible()
  // Nothing enrolled to fall back to.
  await expect(page.getByTestId('search-ask-node-instead')).toHaveCount(0)
  // The question is back where it can be re-sent, and nothing claims to be
  // working on it.
  await expect(page.getByTestId('search-input')).toHaveValue(question)
  await expect(page.getByTestId('search-waiting')).toHaveCount(0)

  // The defect this fixes: the question used to persist as a `user` turn, so
  // every later mount read as waiting for an answer that was never coming.
  await page.evaluate(() => (window.location.hash = '#/'))
  await page.evaluate(() => (window.location.hash = '#/search'))
  await page.getByTestId('search-ai-toggle').click()
  await expect(page.getByTestId('search-ai-empty')).toBeVisible()
  await expect(page.getByTestId('search-turn')).toHaveCount(0)
  await expect(page.getByTestId('search-waiting')).toHaveCount(0)
})
