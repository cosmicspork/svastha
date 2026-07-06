import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, put } from '../db'
import { loadTheme, type ThemePref } from '../theme'

// Same rationale as db.test.ts: close and clear the memoized connection so
// each test starts from an empty `prefs` store.
beforeEach(deleteDb)

// Only loadTheme is covered here: setTheme/applyTheme touch `document`
// (data-theme attribute, theme-color metas), and this suite runs under
// vitest's `environment: 'node'` (see vitest.config.ts) with no DOM shim at
// all — not even happy-dom — so there's nothing to assert against without
// widening that config for the whole lib/ suite.
describe('loadTheme', () => {
  it('defaults to system when no preference is stored', async () => {
    expect(await loadTheme()).toBe('system')
  })

  it('round-trips a stored preference', async () => {
    await put('prefs', 'dark' satisfies ThemePref, 'theme')
    expect(await loadTheme()).toBe('dark')
  })
})
