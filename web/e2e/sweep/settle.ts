import type { Page } from '@playwright/test'

// When a screen is ready to shoot. Ported from hounddogreading's
// CapturesScreenshots: Playwright's own load states return before a
// local-first app has read IndexedDB and rendered, and a fixed sleep is either
// too short on a slow page or wasted on a fast one.

/** Resolves to the milliseconds the page took to go quiet, or null when it
 * never did. Quiet means text on the page, no loading message, no pending
 * image, and `quietMs` without a DOM change, then fonts loaded. Lazy images
 * are left out because one below the fold never loads. */
function settled({ limit, quietMs }: { limit: number; quietMs: number }): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    let changed = started
    const observer = new MutationObserver(() => {
      changed = performance.now()
    })
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    const busy = () =>
      document.body.innerText.trim() === '' ||
      /Loading[^\n]{0,40}(\.\.\.|…)/.test(document.body.innerText) ||
      [...document.images].some((image) => !image.complete && image.loading !== 'lazy')
    const check = () => {
      const now = performance.now()
      const quiet = !busy() && now - changed >= quietMs
      if (!quiet && now - started < limit) {
        setTimeout(check, 100)
        return
      }
      observer.disconnect()
      document.fonts.ready.then(() => resolve(quiet ? Math.round(now - started) : null))
    }
    check()
  })
}

/** Wait until the page settles, or throw naming the screen so a sweep that
 * would have shot a spinner fails loudly instead. */
export async function waitUntilSettled(
  page: Page,
  screen: string,
  { timeoutMs = 20_000, quietMs = 500 } = {},
): Promise<number> {
  const ms = await page.evaluate(settled, { limit: timeoutMs, quietMs })
  if (ms === null) {
    throw new Error(`${screen} was still loading after ${timeoutMs / 1000} seconds, so no screenshot was taken.`)
  }
  return ms
}
