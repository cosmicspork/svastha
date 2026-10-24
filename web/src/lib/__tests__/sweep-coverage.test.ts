import { describe, expect, it } from 'vitest'
import { KNOWN_PATTERNS, matchRoute } from '../router-match'
import { LOG_KINDS } from '../log-kinds'
import { EXCLUDED_ROUTES, STATES } from '../../../e2e/sweep/manifest'

// The screenshot sweep (`just sweep`) promises every screen. That promise is
// only as good as its manifest, so check the manifest against the router itself:
// a new route fails here until it gets a sweep state or a stated exclusion.

/** The router pattern a state's route really lands on. Placeholder segments
 * (`{ed}`) match a dynamic segment like any other value. */
function patternOf(route: string): string {
  return matchRoute(`#${route}`).path
}

describe('screenshot sweep coverage', () => {
  it('shoots or explicitly excludes every route the router knows', () => {
    const covered = new Set(STATES.map((s) => patternOf(s.route)))
    const missing = KNOWN_PATTERNS.filter((p) => !covered.has(p) && !(p in EXCLUDED_ROUTES))
    expect(missing, 'add a state to e2e/sweep/manifest.ts, or an EXCLUDED_ROUTES entry with a reason').toEqual([])
  })

  it('routes every state to the screen it names, not the unknown-route fallback', () => {
    // matchRoute sends anything unrecognized to Home, so a typo'd route would
    // otherwise count as covering `/` while shooting the wrong screen.
    const misrouted = STATES.filter((s) => patternOf(s.route) === '/' && s.route !== '/').map((s) => s.id)
    expect(misrouted).toEqual([])
  })

  it('keeps exclusions honest: known, uncovered, and with a reason', () => {
    const covered = new Set(STATES.map((s) => patternOf(s.route)))
    for (const [pattern, reason] of Object.entries(EXCLUDED_ROUTES)) {
      expect(KNOWN_PATTERNS, `excluded ${pattern} is not a route`).toContain(pattern)
      expect(covered.has(pattern), `excluded ${pattern} is also shot`).toBe(false)
      expect(reason.trim(), `excluded ${pattern} needs a reason`).not.toBe('')
    }
  })

  it('shoots the form for every loggable kind', () => {
    // One `/log/:kind` state would satisfy the route check above, so the kinds
    // get their own: every bloom action is a different form.
    const logged = new Set(STATES.filter((s) => patternOf(s.route) === '/log/:kind').map((s) => s.route))
    const missing = LOG_KINDS.map((k) => `/log/${k.kind}`).filter((r) => !logged.has(r))
    expect(missing).toEqual([])
  })

  it('gives every state a unique, file-safe id', () => {
    const ids = STATES.map((s) => s.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([])
  })
})
