import { describe, expect, it } from 'vitest'
import {
  startSwipe,
  trackSwipe,
  resolveSwipe,
  isSwiping,
  AXIS_LOCK_PX,
  SWIPE_THRESHOLD_PX,
} from '../swipe'

/** Drag from (0,0) through a path of offsets, returning the final gesture. */
function drag(...points: [number, number][]) {
  let s = startSwipe(0, 0)
  for (const [x, y] of points) s = trackSwipe(s, x, y)
  return s
}

describe('axis lock', () => {
  it('stays uncommitted below the lock distance, so a tap that wobbles is still a tap', () => {
    const s = drag([AXIS_LOCK_PX, 0], [0, AXIS_LOCK_PX])
    expect(s.axis).toBeNull()
    expect(isSwiping(s)).toBe(false)
    expect(resolveSwipe(s)).toBeNull()
  })

  it('locks horizontal once a drag is past the lock and mostly sideways', () => {
    const s = drag([20, 4])
    expect(s.axis).toBe('x')
    expect(s.dx).toBe(20)
  })

  it('locks vertical on a mostly-downward drag and reports no travel', () => {
    const s = drag([4, 20])
    expect(s.axis).toBe('y')
    expect(s.dx).toBe(0)
  })

  // Adversarial: gestures built to slip past the lock the wrong way.
  it('refuses to call an exact diagonal horizontal', () => {
    expect(drag([30, 30]).axis).toBe('y')
    expect(drag([-30, 30]).axis).toBe('y')
  })

  it('keeps a vertical lock even if the finger later sweeps far sideways', () => {
    // A scroll that curves: once the page owns the gesture it keeps it, or a
    // flick-scroll would fire a row action on release.
    const s = drag([0, 40], [200, 40])
    expect(s.axis).toBe('y')
    expect(resolveSwipe(s)).toBeNull()
  })

  it('keeps a horizontal lock through a later vertical wander', () => {
    const s = drag([40, 0], [40, 200])
    expect(s.axis).toBe('x')
    expect(s.dx).toBe(40)
  })

  it('does not mutate the gesture it is given', () => {
    const start = startSwipe(0, 0)
    trackSwipe(start, 90, 0)
    expect(start).toEqual({ startX: 0, startY: 0, axis: null, dx: 0 })
  })

  it('measures from where the finger went down, not from the origin', () => {
    let s = startSwipe(300, 500)
    s = trackSwipe(s, 380, 502)
    expect(s.axis).toBe('x')
    expect(s.dx).toBe(80)
  })
})

describe('resolving a finished gesture', () => {
  it('fires right past the threshold and left past its negative', () => {
    expect(resolveSwipe(drag([SWIPE_THRESHOLD_PX, 0]))).toBe('right')
    expect(resolveSwipe(drag([-SWIPE_THRESHOLD_PX, 0]))).toBe('left')
  })

  it('fires nothing one pixel short — the row snaps back', () => {
    expect(resolveSwipe(drag([SWIPE_THRESHOLD_PX - 1, 0]))).toBeNull()
    expect(resolveSwipe(drag([-(SWIPE_THRESHOLD_PX - 1), 0]))).toBeNull()
  })

  it('reads the final position, so a drag pulled back before release fires nothing', () => {
    const s = drag([100, 0], [10, 0])
    expect(isSwiping(s)).toBe(true)
    expect(resolveSwipe(s)).toBeNull()
  })

  it('resolves an overshoot-and-reverse by its ending direction, not its furthest point', () => {
    expect(resolveSwipe(drag([120, 0], [-120, 0]))).toBe('left')
  })

  it('fires nothing for a gesture that never committed to an axis', () => {
    expect(resolveSwipe(startSwipe(0, 0))).toBeNull()
    expect(resolveSwipe(drag([0, 300]))).toBeNull()
  })
})
