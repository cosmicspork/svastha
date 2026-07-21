import { test, expect } from '@playwright/test'
import { onboardViaUI } from './helpers'

// The cycle overview in Patterns, end to end: seed real signed cycle events
// through the same logEvent append path the log form will use (the form lands
// in a sibling PR), open Patterns, and confirm the "Day N" headline and the
// cycle band render over the derived cycles. No relay needed — this is a purely
// local-first read.
test('Patterns shows the cycle Day-N headline and a band over seeded cycles', async ({ page }) => {
  await onboardViaUI(page)

  // Two period starts — one ~35 days ago, one ~5 days ago — so the log derives a
  // completed cycle plus the current open one. Timestamps are relative to now so
  // the current-day count is stable regardless of when the suite runs.
  await page.evaluate(async () => {
    const { logEvent } = await import('/src/lib/events.ts')
    const { CYCLE_START, CYCLE_END, CYCLE_FLOW } = await import('/src/lib/codes.ts')
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
    await logEvent([
      { kind: 'observation', code: CYCLE_START, effective_at: iso(35), value: null },
      { kind: 'observation', code: CYCLE_FLOW, effective_at: iso(35), value: { quantity: { value: '3', unit: null } } },
      { kind: 'observation', code: CYCLE_END, effective_at: iso(31), value: null },
      { kind: 'observation', code: CYCLE_START, effective_at: iso(5), value: null },
      { kind: 'observation', code: CYCLE_FLOW, effective_at: iso(5), value: { quantity: { value: '2', unit: null } } },
    ])
  })

  await page.getByTestId('nav-correlate').click()

  // The overview headline and its caption.
  await expect(page.getByTestId('cycle-stats')).toBeVisible()
  await expect(page.getByTestId('cycle-day')).toHaveText(/Day \d+/)
  await expect(page.getByTestId('cycle-stats').getByText(/Current cycle/i)).toBeVisible()

  // The band: two bars (one completed, one open), the open one carrying an
  // in-progress "…" label.
  await expect(page.getByTestId('cycle-band')).toBeVisible()
  await expect(page.getByTestId('cycle-bar')).toHaveCount(2)
  await expect(page.getByTestId('cycle-band').getByText(/d…/)).toBeVisible()

  // The per-day flow lane surfaces alongside the other lanes.
  await expect(page.getByTestId('cycle-lane')).toBeVisible()
  await expect(page.getByTestId('cycle-cell').first()).toBeVisible()
})
