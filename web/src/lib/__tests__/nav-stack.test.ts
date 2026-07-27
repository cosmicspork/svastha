import { describe, expect, it } from 'vitest'
import { NavStack } from '../nav-stack'

describe('NavStack', () => {
  it('starts empty with nowhere to go back to', () => {
    const s = new NavStack()
    expect(s.canGoBack).toBe(false)
    expect(s.pop()).toBeUndefined()
  })

  it('returns visited screens in reverse order', () => {
    const s = new NavStack()
    s.push('#/')
    s.push('#/search')
    expect(s.canGoBack).toBe(true)
    expect(s.pop()).toBe('#/search')
    expect(s.pop()).toBe('#/')
    expect(s.canGoBack).toBe(false)
  })

  it('collapses consecutive duplicates', () => {
    const s = new NavStack()
    s.push('#/timeline')
    s.push('#/timeline')
    expect(s.size).toBe(1)
  })

  it('keeps non-adjacent repeats so a real round trip is preserved', () => {
    const s = new NavStack()
    s.push('#/')
    s.push('#/search')
    s.push('#/')
    expect(s.size).toBe(3)
  })

  it('caps depth, dropping the oldest entries', () => {
    const s = new NavStack()
    for (let i = 0; i < 60; i++) s.push(`#/p${i}`)
    expect(s.size).toBe(50)
    // The most recent push is still the first thing Back returns to.
    expect(s.pop()).toBe('#/p59')
  })
})
