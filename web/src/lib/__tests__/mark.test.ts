import { describe, expect, it } from 'vitest'
import { fiddlehead, VIEW_BOX } from '../mark'

/** Every coordinate pair in a path built only from M / C / Z commands. */
function points(d: string): Array<[number, number]> {
  const numbers = d.match(/-?\d+(\.\d+)?/g)
  expect(numbers).not.toBeNull()
  const flat = (numbers ?? []).map(Number)
  expect(flat.length % 2).toBe(0)
  const out: Array<[number, number]> = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

describe('fiddlehead', () => {
  it('emits one closed path of cubic curves', () => {
    for (const small of [false, true]) {
      const d = fiddlehead(small)
      expect(d.startsWith('M ')).toBe(true)
      expect(d.endsWith(' Z')).toBe(true)
      expect(d.match(/M/g)).toHaveLength(1)
      expect(d.replace(/[^A-Za-z]/g, '')).toMatch(/^MC+Z$/)
    }
  })

  it('is deterministic, so regenerating the icons is a no-op diff', () => {
    expect(fiddlehead()).toBe(fiddlehead())
    expect(fiddlehead(true)).toBe(fiddlehead(true))
  })

  it('draws a distinct, heavier mark for the small tier', () => {
    expect(fiddlehead(true)).not.toBe(fiddlehead())
  })

  it('stays inside the viewBox', () => {
    for (const small of [false, true]) {
      for (const [x, y] of points(fiddlehead(small))) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(VIEW_BOX)
        expect(y).toBeLessThanOrEqual(VIEW_BOX)
      }
    }
  })

  // The contract that makes the maskable icon safe: Android may crop the icon to
  // a circle of 80% diameter, so nothing may stray outside that circle. Checked
  // against control points too, which bound the curve they describe.
  it('stays within the Android maskable safe circle', () => {
    const centre = VIEW_BOX / 2
    const safeRadius = VIEW_BOX * 0.4
    for (const small of [false, true]) {
      for (const [x, y] of points(fiddlehead(small))) {
        const distance = Math.hypot(x - centre, y - centre)
        expect(distance).toBeLessThanOrEqual(safeRadius)
      }
    }
  })

  it('is centred on the frame rather than on the spiral origin', () => {
    for (const small of [false, true]) {
      const all = points(fiddlehead(small))
      const xs = all.map(([x]) => x)
      const ys = all.map(([, y]) => y)
      const midX = (Math.min(...xs) + Math.max(...xs)) / 2
      const midY = (Math.min(...ys) + Math.max(...ys)) / 2
      // Control points overshoot the outline slightly, so allow a little slack.
      expect(Math.abs(midX - VIEW_BOX / 2)).toBeLessThan(6)
      expect(Math.abs(midY - VIEW_BOX / 2)).toBeLessThan(6)
    }
  })
})
