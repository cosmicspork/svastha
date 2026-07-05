import { describe, expect, it } from 'vitest'
import { matchRoute } from '../router-match'

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
    expect(matchRoute('#/share')).toEqual({ path: '/share', params: {} })
    expect(matchRoute('#/import')).toEqual({ path: '/import', params: {} })
    expect(matchRoute('#/correlate')).toEqual({ path: '/correlate', params: {} })
  })

  it('captures the person route dynamic segment', () => {
    const ed = 'a'.repeat(64)
    expect(matchRoute(`#/person/${ed}`)).toEqual({
      path: '/person/:ed',
      params: { ed },
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
