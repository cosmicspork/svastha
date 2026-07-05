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
  })

  it('falls back to home for an unknown route', () => {
    expect(matchRoute('#/nope')).toEqual({ path: '/', params: {} })
    expect(matchRoute('#/log/a/b')).toEqual({ path: '/', params: {} })
  })

  it('ignores a query string', () => {
    expect(matchRoute('#/onboard?tab=restore')).toEqual({ path: '/onboard', params: {} })
  })
})
