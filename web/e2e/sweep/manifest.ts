// The screenshot sweep's states: every screen the router knows, plus the sheets
// and overlays worth seeing, as data. sweep.spec.ts shoots each one at every
// size and scheme; src/lib/__tests__/sweep-coverage.test.ts fails CI when a
// route the router knows is neither shot here nor excluded with a reason.
//
// This module is loaded by vitest as well as Playwright, so it imports nothing
// from Playwright (or helpers.ts) at runtime: acts wait with locator.waitFor
// rather than Playwright's expect.

import type { Locator, Page } from '@playwright/test'

export type Size = 'phone' | 'desktop'
export type Scheme = 'light' | 'dark'

export const SIZES: Record<Size, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
}
export const SCHEMES: Scheme[] = ['light', 'dark']

export interface SweepContext {
  /** Values only the seeded vault knows, substituted into `{name}` route
   * segments: `ed` (the partner who shared their record), `frag` (a doctor
   * link's fragment). */
  vars: Record<string, string>
}

export interface SweepState {
  /** Unique, kebab-case; also the PNG file name prefix. */
  id: string
  /** Groups states on the contact sheet; `--only` filters on it. */
  area: string
  /** Hash path, `{name}` segments filled from SweepContext.vars. */
  route: string
  title: string
  note?: string
  /** `vault` (default) shoots the one seeded, unlocked vault. `cold` shoots a
   * brand-new browser context with no vault, the way a first visit or a
   * doctor opening a link sees the app. */
  context?: 'vault' | 'cold'
  /** Runs after the route has loaded, before the shot: open a sheet, fill a
   * field. It runs once per size and scheme, so it must not depend on the
   * previous run. */
  act?: (page: Page, ctx: SweepContext) => Promise<void>
  sizes?: Size[]
  /** False shoots the viewport only — for sheets and overlays, which sit over
   * the viewport rather than the document. */
  full?: boolean
}

/** Router patterns deliberately left out of the sweep, each with its reason.
 * Empty today; an entry here is the only way past the coverage test. */
export const EXCLUDED_ROUTES: Record<string, string> = {}

const byId = (page: Page, id: string): Locator => page.getByTestId(id).first()
const shown = (page: Page, id: string) => byId(page, id).waitFor({ state: 'visible' })

/** Wait out an element's own transitions (bloom petals overshoot as they fly
 * out, so a click or a shot mid-flight catches them moving). */
async function stillAnimations(locator: Locator): Promise<void> {
  await locator.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  )
}

async function openBloom(page: Page): Promise<void> {
  const fab = byId(page, 'fab')
  await fab.click()
  await page.locator('[data-testid="fab"][aria-expanded="true"]').waitFor()
  await stillAnimations(page.locator('body'))
}

/** Expand a summary row and open its curation sheet. */
async function openRowActions(page: Page, label: string): Promise<void> {
  const row = page.getByTestId('summary-row').filter({ hasText: label }).first()
  const trigger = row.getByTestId('summary-row-trigger')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await row.locator('[data-testid="summary-row-trigger"][aria-expanded="true"]').waitFor()
  await row.getByTestId('summary-row-curate').click()
  await shown(page, 'row-action-sheet')
}

/** Read the generated seed phrase off the onboarding screen. */
async function seedWords(page: Page): Promise<string[]> {
  const words: string[] = []
  for (let i = 1; i <= 24; i++) {
    words.push((await byId(page, `mnemonic-word-${i}`).innerText()).trim())
  }
  return words
}

const logState = (kind: string, title: string, note?: string): SweepState => ({
  id: `log-${kind}`,
  area: 'log',
  route: `/log/${kind}`,
  title,
  note,
})

export const STATES: SweepState[] = [
  // --- first run (no vault) ---
  {
    id: 'onboard-welcome',
    area: 'onboarding',
    route: '/onboard',
    title: 'Onboarding: create',
    context: 'cold',
    act: (page) => shown(page, 'generate-mnemonic'),
  },
  {
    id: 'onboard-restore',
    area: 'onboarding',
    route: '/onboard',
    title: 'Onboarding: restore from a seed phrase',
    context: 'cold',
    act: async (page) => {
      await byId(page, 'tab-restore').click()
      await shown(page, 'restore-mnemonic')
    },
  },
  {
    id: 'onboard-seed',
    area: 'onboarding',
    route: '/onboard',
    title: 'Onboarding: the generated seed phrase',
    note: 'The words are freshly generated each run.',
    context: 'cold',
    act: async (page) => {
      await byId(page, 'generate-mnemonic').click()
      await shown(page, 'mnemonic-word-24')
    },
  },
  {
    id: 'onboard-confirm',
    area: 'onboarding',
    route: '/onboard',
    title: 'Onboarding: confirm words',
    context: 'cold',
    act: async (page) => {
      await byId(page, 'generate-mnemonic').click()
      await shown(page, 'mnemonic-word-24')
      await byId(page, 'wrote-it-down').click()
      await shown(page, 'confirm-words-submit')
    },
  },
  {
    id: 'onboard-passphrase',
    area: 'onboarding',
    route: '/onboard',
    title: 'Onboarding: set a passphrase',
    context: 'cold',
    act: async (page) => {
      await byId(page, 'generate-mnemonic').click()
      await shown(page, 'mnemonic-word-24')
      const words = await seedWords(page)
      await byId(page, 'wrote-it-down').click()
      const inputs = page.locator('[data-testid^="confirm-word-"]')
      await inputs.first().waitFor()
      for (let i = 0; i < (await inputs.count()); i++) {
        const position = Number((await inputs.nth(i).getAttribute('data-testid'))!.replace('confirm-word-', ''))
        await inputs.nth(i).fill(words[position - 1])
      }
      await byId(page, 'confirm-words-submit').click()
      await shown(page, 'passphrase')
    },
  },
  {
    id: 'unlock',
    area: 'onboarding',
    route: '/unlock',
    title: 'Unlock',
    note: 'A reload locks the session; the sweep unlocks again afterwards.',
    act: async (page) => {
      await page.reload()
      await shown(page, 'unlock-passphrase')
    },
  },

  // --- home ---
  { id: 'home', area: 'home', route: '/', title: 'Home dashboard', note: 'With a pending invite banner (Casey).' },
  {
    id: 'home-install-sheet',
    area: 'home',
    route: '/',
    title: 'First-run install sheet',
    full: false,
    act: async (page) => {
      // The module path is an argument, not a literal: this file is also
      // type-checked by the app's tsconfig, which can't resolve a served path.
      await page.evaluate(async (dbModule) => {
        const { del } = await import(dbModule)
        await del('prefs', 'install-nudge-dismissed')
        window.location.hash = '#/settings/about'
      }, '/src/lib/db.ts')
      await shown(page, 'settings-row-about').catch(() => undefined)
      await page.evaluate(() => (window.location.hash = '#/'))
      await shown(page, 'install-sheet-not-now')
    },
  },
  {
    id: 'bloom-fan',
    area: 'home',
    route: '/',
    title: 'Log bloom: the fan',
    full: false,
    act: openBloom,
  },
  {
    id: 'bloom-more',
    area: 'home',
    route: '/',
    title: 'Log bloom: the More sheet',
    full: false,
    act: async (page) => {
      await openBloom(page)
      await byId(page, 'bloom-more').click()
      await page.getByRole('group', { name: 'All log actions' }).waitFor()
    },
  },
  {
    id: 'notifications',
    area: 'home',
    route: '/',
    title: 'Notifications sheet',
    note: 'Carries the pending invite.',
    full: false,
    act: async (page) => {
      await byId(page, 'nav-notifications').click()
      await page.getByTestId('notifications-list').or(page.getByTestId('notifications-empty')).waitFor()
    },
  },

  // --- the record ---
  { id: 'timeline', area: 'record', route: '/timeline', title: 'Timeline' },
  { id: 'summary', area: 'record', route: '/summary', title: 'Summary' },
  {
    id: 'summary-past',
    area: 'record',
    route: '/summary',
    title: 'Summary with past medications open',
    act: async (page) => {
      await byId(page, 'meds-past-toggle').click()
      await shown(page, 'summary-section-past')
    },
  },
  {
    id: 'summary-row-actions',
    area: 'record',
    route: '/summary',
    title: 'Summary row action sheet (regimen, status, name)',
    full: false,
    act: (page) => openRowActions(page, 'Lisinopril'),
  },

  // --- medications ---
  { id: 'medications', area: 'medications', route: '/medications', title: 'Medications by route' },
  {
    id: 'medications-past',
    area: 'medications',
    route: '/medications',
    title: 'Medications with past meds open',
    act: async (page) => {
      await byId(page, 'page-past-toggle').click()
      await shown(page, 'summary-section-past')
    },
  },
  {
    id: 'medications-pharmacy',
    area: 'medications',
    route: '/medications/pharmacy',
    title: 'Pharmacy list',
  },

  // --- logging: one per bloom kind (the coverage test checks LOG_KINDS) ---
  logState('vitals', 'Log vitals'),
  logState('med', 'Log a medication'),
  logState('food', 'Log food'),
  logState('mind', 'Log mood'),
  logState('symptom', 'Log a symptom'),
  logState('exercise', 'Log movement'),
  logState('note', 'Log a note'),
  logState('paper', 'Log a paper record'),
  logState('cycle', 'Log cycle'),
  logState('visit', 'Log a visit'),
  logState('work', 'Log work'),

  // --- search ---
  { id: 'search', area: 'search', route: '/search', title: 'Search, empty' },
  {
    id: 'search-results',
    area: 'search',
    route: '/search',
    title: 'Search results',
    act: async (page) => {
      await byId(page, 'search-input').fill('blood')
      await shown(page, 'search-results')
    },
  },
  {
    id: 'search-ask',
    area: 'search',
    route: '/search',
    title: 'Ask: a cited answer from the node',
    act: async (page) => {
      await byId(page, 'search-ai-toggle').click()
      await shown(page, 'search-turn')
    },
  },

  // --- patterns ---
  { id: 'correlate', area: 'patterns', route: '/correlate', title: 'Patterns' },
  {
    id: 'correlate-flare',
    area: 'patterns',
    route: '/correlate',
    title: 'Patterns: a flare and what came before it',
    act: async (page) => {
      // The severity-7 headache, the flare the seed backdated food before.
      await page.getByTestId('symptom-dot').and(page.getByLabel(/severity 7\//)).first().click()
      await shown(page, 'flare-panel')
    },
  },

  // --- inbox and import ---
  { id: 'proposals', area: 'proposals', route: '/proposals', title: 'Proposal inbox' },
  { id: 'import', area: 'import', route: '/import', title: 'Import' },
  {
    id: 'import-review',
    area: 'import',
    route: '/import',
    title: 'Import: review before commit',
    note: 'The fixtures are already imported, so this shows them as duplicates.',
    act: async (page) => {
      await byId(page, 'import-file-input').setInputFiles([
        '../fixtures/xdm/minimal-xdm.zip',
        '../fixtures/fhir/bundle-minimal.json',
      ])
      await shown(page, 'import-totals')
    },
  },

  // --- settings ---
  { id: 'settings', area: 'settings', route: '/settings', title: 'Settings' },
  { id: 'settings-appearance', area: 'settings', route: '/settings/appearance', title: 'Appearance' },
  { id: 'settings-security', area: 'settings', route: '/settings/security', title: 'Security' },
  { id: 'settings-sync', area: 'settings', route: '/settings/sync', title: 'Sync & devices' },
  { id: 'settings-notifications', area: 'settings', route: '/settings/notifications', title: 'Notifications' },
  { id: 'settings-ai', area: 'settings', route: '/settings/ai', title: 'AI' },
  { id: 'settings-data', area: 'settings', route: '/settings/data', title: 'Data' },
  { id: 'settings-about', area: 'settings', route: '/settings/about', title: 'About' },

  // --- sharing ---
  { id: 'share', area: 'share', route: '/share', title: 'Sharing hub', note: 'With a pending invite (Casey).' },
  { id: 'share-people', area: 'share', route: '/share/people', title: 'Your people' },
  { id: 'share-doctor', area: 'share', route: '/share/doctor', title: 'Doctor links' },
  {
    id: 'doctor-share-preview',
    area: 'share',
    route: '/share/doctor',
    title: 'New doctor link: preview what they see',
    full: false,
    act: async (page) => {
      await byId(page, 'new-doctor-link').click()
      await byId(page, 'share-preview-toggle').click()
      await shown(page, 'share-preview')
      await byId(page, 'share-preview').scrollIntoViewIfNeeded()
    },
  },
  {
    id: 'doctor-share-created',
    area: 'share',
    route: '/share/doctor',
    title: 'New doctor link: created',
    note: 'Each shot mints a real link, so Doctor links grows on every run.',
    full: false,
    act: async (page) => {
      await byId(page, 'new-doctor-link').click()
      await byId(page, 'share-create').click()
      await shown(page, 'share-link')
    },
  },

  // --- a shared record, read-only ---
  { id: 'person', area: 'person', route: '/person/{ed}', title: "Bailey's record (default view)" },
  { id: 'person-timeline', area: 'person', route: '/person/{ed}/timeline', title: "Bailey's timeline" },
  { id: 'person-summary', area: 'person', route: '/person/{ed}/summary', title: "Bailey's summary" },

  // --- what a recipient sees, opened cold ---
  {
    id: 'share-recipient',
    area: 'recipient',
    route: '/s/{frag}',
    title: 'Doctor link, opened cold',
    context: 'cold',
    act: (page) => shown(page, 'clinician-summary'),
  },
  {
    id: 'share-file-open',
    area: 'recipient',
    route: '/s',
    title: 'Open a share file',
    context: 'cold',
    act: (page) => shown(page, 'file-share-dropzone'),
  },
]

/** The concrete hash path for a state, or an error naming the missing var. */
export function resolveRoute(route: string, vars: Record<string, string>): string {
  return route.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`route ${route} needs {${name}}, which the vault did not provide`)
    return value
  })
}

/** The states a run covers: `only` filters by area, `state` by id substring. */
export function selectStates(filter: { only?: string[]; state?: string }): SweepState[] {
  return STATES.filter(
    (s) =>
      (!filter.only?.length || filter.only.includes(s.area)) &&
      (!filter.state || s.id.includes(filter.state)),
  )
}
