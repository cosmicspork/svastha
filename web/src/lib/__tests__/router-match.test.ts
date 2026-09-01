import { describe, expect, it } from 'vitest'
import { matchRoute } from '../router-match'

/** Every literal hash the app navigates to, read from the sources themselves
 * (`?raw`, so no Svelte compiler and no Node types are needed). Template-literal
 * targets — a person's key, a share fragment — are skipped; their patterns are
 * covered by the dynamic-segment tests below. */
function literalNavTargets(): string[] {
  const sources = import.meta.glob('../../**/*.{ts,svelte}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const found = new Set<string>()
  for (const source of Object.values(sources)) {
    for (const [, hash] of source.matchAll(/navigate\('(#[^']*)'\)/g)) found.add(hash)
  }
  return [...found].sort()
}

describe('matchRoute', () => {
  it('matches the home route', () => {
    expect(matchRoute('#/')).toEqual({ path: '/', params: {} })
    expect(matchRoute('')).toEqual({ path: '/', params: {} })
    expect(matchRoute('#')).toEqual({ path: '/', params: {} })
  })

  it('captures a dynamic segment', () => {
    expect(matchRoute('#/log/vitals')).toEqual({
      path: '/log/:kind',
      params: { kind: 'vitals' },
    })
  })

  it('decodes an encoded param', () => {
    expect(matchRoute('#/log/blood%20pressure')).toEqual({
      path: '/log/:kind',
      params: { kind: 'blood pressure' },
    })
  })

  it('matches static routes', () => {
    expect(matchRoute('#/onboard')).toEqual({ path: '/onboard', params: {} })
    expect(matchRoute('#/unlock')).toEqual({ path: '/unlock', params: {} })
    expect(matchRoute('#/settings')).toEqual({ path: '/settings', params: {} })
    expect(matchRoute('#/settings/appearance')).toEqual({ path: '/settings/appearance', params: {} })
    expect(matchRoute('#/settings/security')).toEqual({ path: '/settings/security', params: {} })
    expect(matchRoute('#/settings/sync')).toEqual({ path: '/settings/sync', params: {} })
    expect(matchRoute('#/settings/data')).toEqual({ path: '/settings/data', params: {} })
    expect(matchRoute('#/settings/about')).toEqual({ path: '/settings/about', params: {} })
    expect(matchRoute('#/share')).toEqual({ path: '/share', params: {} })
    expect(matchRoute('#/share/people')).toEqual({ path: '/share/people', params: {} })
    expect(matchRoute('#/share/doctor')).toEqual({ path: '/share/doctor', params: {} })
    expect(matchRoute('#/timeline')).toEqual({ path: '/timeline', params: {} })
    expect(matchRoute('#/summary')).toEqual({ path: '/summary', params: {} })
    expect(matchRoute('#/medications')).toEqual({ path: '/medications', params: {} })
    expect(matchRoute('#/search')).toEqual({ path: '/search', params: {} })
    expect(matchRoute('#/import')).toEqual({ path: '/import', params: {} })
    expect(matchRoute('#/correlate')).toEqual({ path: '/correlate', params: {} })
  })

  // An unknown hash falls back to `/`, so a screen the app links to but the
  // pattern list has never heard of does not fail loudly — it silently shows
  // the dashboard, and the screen is simply unreachable. `#/settings/ai` was
  // exactly that.
  it('knows every screen the app navigates to', () => {
    const unreachable = literalNavTargets().filter((hash) => hash !== '#/' && matchRoute(hash).path === '/')
    expect(unreachable).toEqual([])
  })

  it('captures the person route dynamic segment', () => {
    const ed = 'a'.repeat(64)
    expect(matchRoute(`#/person/${ed}`)).toEqual({
      path: '/person/:ed',
      params: { ed },
    })
  })

  it('routes the person-scoped timeline and summary views', () => {
    const ed = 'b'.repeat(64)
    expect(matchRoute(`#/person/${ed}/timeline`)).toEqual({
      path: '/person/:ed/timeline',
      params: { ed },
    })
    expect(matchRoute(`#/person/${ed}/summary`)).toEqual({
      path: '/person/:ed/summary',
      params: { ed },
    })
  })

  it('captures the whole share fragment as one segment', () => {
    const frag = 'abcdefghijklmnopqrstuvwxyz.AAAA-_.aHR0cA'
    expect(matchRoute(`#/s/${frag}`)).toEqual({
      path: '/s/:frag',
      params: { frag },
    })
  })

  it('falls back to home for an unknown route', () => {
    expect(matchRoute('#/nope')).toEqual({ path: '/', params: {} })
    expect(matchRoute('#/log/a/b')).toEqual({ path: '/', params: {} })
  })

  it('ignores a query string', () => {
    expect(matchRoute('#/onboard?tab=restore')).toEqual({ path: '/onboard', params: {} })
  })
})
