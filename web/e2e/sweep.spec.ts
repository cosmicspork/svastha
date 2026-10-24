import { test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PASSPHRASE } from './helpers'
import {
  SCHEMES,
  SIZES,
  resolveRoute,
  selectStates,
  type Scheme,
  type Size,
  type SweepState,
} from './sweep/manifest'
import { waitUntilSettled } from './sweep/settle'
import { mergeManifest, variantKey, writeReport, type StateRecord } from './sweep/report'
import { seedVault } from './sweep/seed'

// On-demand sweep of every screen, not a CI test: `just sweep` (see
// e2e/sweep/run.ts for the flags). Builds one synthetic vault, then shoots each
// state in e2e/sweep/manifest.ts at every size and scheme into sweep-out/ (git-
// ignored), with manifest.json and an index.html contact sheet beside them.
test.skip(!process.env.SWEEP, 'the screen sweep runs on demand, not in CI')

const OUT = process.env.SWEEP_OUT ?? 'sweep-out'
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)
const only = list(process.env.SWEEP_ONLY)
const stateFilter = process.env.SWEEP_STATE || undefined
const sizes = (list(process.env.SWEEP_SIZES) ?? ['phone', 'desktop']) as Size[]
const schemes = (list(process.env.SWEEP_SCHEMES) ?? SCHEMES) as Scheme[]
// Long pages are cut here; the rest is rarely different and makes huge files.
const MAX_HEIGHT = 6000

interface Bucket {
  consoleErrors: Set<string>
  pageErrors: Set<string>
  failedRequests: Set<string>
}

/** Route a page's errors into whichever state is being shot right now. */
function listen(page: Page, current: () => Bucket | null): void {
  page.on('console', (m) => {
    // The 4xx/5xx behind "Failed to load resource" is in failedRequests already.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      current()?.consoleErrors.add(m.text().slice(0, 400))
    }
  })
  page.on('pageerror', (e) => current()?.pageErrors.add(String(e.message ?? e).slice(0, 400)))
  page.on('requestfailed', (r) => {
    // The poke stream is long-lived by design, so its abort on a reload or
    // navigation is not a failure of the screen.
    if (new URL(r.url()).pathname === '/v0/events') return
    current()?.failedRequests.add(`${r.method()} ${r.url()} (${r.failure()?.errorText ?? 'failed'})`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) current()?.failedRequests.add(`${r.status()} ${r.request().method()} ${r.url()}`)
  })
}

/** Back to a known state between shots: unlocked, no sheet or fan open. */
async function resetVault(page: Page): Promise<void> {
  const unlock = page.getByTestId('unlock-passphrase')
  if (await unlock.isVisible()) {
    await unlock.fill(PASSPHRASE)
    await page.getByTestId('unlock-submit').click()
    await page.getByTestId('nav-settings').waitFor()
  }
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"], [data-testid="fab"][aria-expanded="true"]').count()); i++) {
    await page.keyboard.press('Escape')
  }
}

/** Hash-navigate so the screen mounts fresh: assigning the hash it is already
 * on fires no hashchange, and would leave the last shot's act (an open past
 * group, a filled search) in place. */
async function goHash(page: Page, hash: string): Promise<void> {
  if ((await page.evaluate(() => window.location.hash)) === hash) {
    await page.evaluate(() => (window.location.hash = '#/settings/about'))
    await page.getByTestId('about-app-version').waitFor()
  }
  await page.evaluate((h) => (window.location.hash = h), hash)
}

async function shootOnce(
  browser: Browser,
  vault: Page | null,
  state: SweepState,
  vars: Record<string, string>,
  size: Size,
  scheme: Scheme,
  file: string,
  bucket: { current: Bucket | null },
): Promise<number> {
  const viewport = SIZES[size]
  const label = `${state.id} (${size}, ${scheme})`
  const hash = `#${resolveRoute(state.route, vars)}`
  let page: Page
  let cold: BrowserContext | null = null
  if (state.context === 'cold') {
    cold = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 })
    page = await cold.newPage()
    listen(page, () => bucket.current)
    await page.goto(`/${hash}`)
  } else {
    page = vault!
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: scheme })
    await resetVault(page)
    await goHash(page, hash)
  }
  try {
    const started = Date.now()
    await waitUntilSettled(page, label)
    if (state.act) {
      await state.act(page, { vars })
      await waitUntilSettled(page, label)
    }
    // A whole page is taken by growing the viewport to fit it, not with
    // fullPage, which stitches past the viewport and leaves the sticky header
    // and the fixed bloom FAB where the first screenful put them.
    if (state.full !== false) {
      const height = Math.min(MAX_HEIGHT, await page.evaluate(() => document.documentElement.scrollHeight))
      if (height > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height })
        await waitUntilSettled(page, label)
      }
    }
    await page.screenshot({ path: join(OUT, file), animations: 'disabled' })
    return Date.now() - started
  } finally {
    await cold?.close()
  }
}

test('sweep every screen', async ({ browser, baseURL }) => {
  test.setTimeout(60 * 60_000)
  const states = selectStates({ only, state: stateFilter })
  if (!states.length) throw new Error('no sweep states match the filter')
  const narrowed = Boolean(only?.length || stateFilter)
  if (!narrowed) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const bucket: { current: Bucket | null } = { current: null }
  let vault: Page | null = null
  let vars: Record<string, string> = {}
  // Cold states without vault vars (onboarding, the file-open entry) need no
  // vault, so a run narrowed to them skips the slow seeding.
  const needsVault = states.some((s) => s.context !== 'cold' || /\{\w+\}/.test(s.route))
  if (needsVault) {
    const ctx = await browser.newContext({ baseURL, viewport: SIZES.desktop, deviceScaleFactor: 2 })
    vault = await ctx.newPage()
    const t0 = Date.now()
    vars = await seedVault(vault, browser)
    console.log(`seeded the vault in ${Math.round((Date.now() - t0) / 1000)}s`)
    listen(vault, () => bucket.current)
  }

  const records: StateRecord[] = []
  for (const state of states) {
    const b: Bucket = { consoleErrors: new Set(), pageErrors: new Set(), failedRequests: new Set() }
    const record: StateRecord = {
      id: state.id,
      area: state.area,
      route: state.route,
      title: state.title,
      note: state.note ?? '',
      shots: {},
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      failures: [],
      sweptAt: new Date().toISOString(),
    }
    bucket.current = b
    for (const size of sizes.filter((s) => !state.sizes || state.sizes.includes(s))) {
      for (const scheme of schemes) {
        const file = `${state.id}-${size}-${scheme}.png`
        // One retry: under load a page can miss its settle window once.
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const ms = await shootOnce(browser, vault, state, vars, size, scheme, file, bucket)
            record.shots[variantKey(size, scheme)] = { file, ms }
            break
          } catch (e) {
            const message = String((e as Error).message ?? e).split('\n')[0]
            if (attempt === 2) record.failures.push(`${size}-${scheme}: ${message}`)
          }
        }
        const flag = record.shots[variantKey(size, scheme)] ? '' : '  FAILED'
        console.log(`${file}${flag}`)
      }
    }
    bucket.current = null
    record.consoleErrors = [...b.consoleErrors]
    record.pageErrors = [...b.pageErrors]
    record.failedRequests = [...b.failedRequests]
    records.push(record)
  }

  // Every column, not just this run's: a narrowed run merges into the rest.
  const variants = (Object.keys(SIZES) as Size[]).flatMap((size) => SCHEMES.map((scheme) => variantKey(size, scheme)))
  writeReport(OUT, narrowed ? mergeManifest(OUT, records) : records, variants)
  console.log(`contact sheet: ${join(process.cwd(), OUT, 'index.html')}`)

  const failed = records.filter((r) => r.failures.length)
  if (failed.length) {
    throw new Error(
      `${failed.length} state(s) could not be shot:\n` +
        failed.map((r) => `  ${r.id}: ${r.failures.join('; ')}`).join('\n'),
    )
  }
})
