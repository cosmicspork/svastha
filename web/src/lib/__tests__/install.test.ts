import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, put } from '../db'
import { shouldNudgeInstall, dismissInstallNudge } from '../install'

// Same rationale as db.test.ts: close and clear the memoized connection so
// each test starts from an empty `prefs` store.
beforeEach(deleteDb)

// shouldNudgeInstall() calls isStandalone(), which reads matchMedia — absent
// under vitest's `environment: 'node'` (see vitest.config.ts), unlike
// `navigator`, which Node provides a minimal version of. Stubbing just
// `matchMedia` (rather than widening the whole lib/ suite to a DOM
// environment, as theme.test.ts opts out of for the same reason on
// applyTheme) is enough to pin "not standalone" for these tests; isIos()'s
// UA sniffing isn't exercised here since shouldNudgeInstall never calls it.
beforeEach(() => {
  ;(globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia = () => ({
    matches: false,
  })
})

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia
  delete (navigator as { standalone?: boolean }).standalone
})

describe('shouldNudgeInstall', () => {
  it('is true when nothing has been dismissed', async () => {
    expect(await shouldNudgeInstall()).toBe(true)
  })

  it('is false once dismissInstallNudge() has been called', async () => {
    await dismissInstallNudge()
    expect(await shouldNudgeInstall()).toBe(false)
  })

  it('is false once the pref has been written directly', async () => {
    await put('prefs', true, 'install-nudge-dismissed')
    expect(await shouldNudgeInstall()).toBe(false)
  })

  it('is false when already running standalone, even undismissed', async () => {
    ;(globalThis as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({
      matches: true,
    })
    expect(await shouldNudgeInstall()).toBe(false)
  })
})
