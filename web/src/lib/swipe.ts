// A one-finger horizontal swipe, as pure state transitions so the gesture rules
// (when the axis locks, when a drag counts as a swipe, which way it resolved)
// can be tested without a browser. Callers own the pointer events and the
// transform; this owns only the decision.
//
// The axis locks on first real movement: past the threshold horizontally the
// gesture is ours, past it vertically the list scrolls and the gesture is
// abandoned. Without that lock a swipe row eats the page scroll.

/** Movement, in px, before the gesture commits to an axis. Below it a drag is
 * still ambiguous — and a tap that wobbles a pixel or two stays a tap. */
export const AXIS_LOCK_PX = 10

/** How far a locked horizontal drag must travel to fire its action. Roughly a
 * thumb's width: far enough that a scroll-adjacent nudge doesn't rename a
 * medication, short enough to reach one-handed. */
export const SWIPE_THRESHOLD_PX = 72

export interface Swipe {
  startX: number
  startY: number
  /** Null until the gesture commits; `'y'` means "not ours, stop tracking". */
  axis: 'x' | 'y' | null
  /** Horizontal travel, zero unless the axis locked to `'x'`. */
  dx: number
}

export function startSwipe(x: number, y: number): Swipe {
  return { startX: x, startY: y, axis: null, dx: 0 }
}

/** Advance the gesture to a new pointer position, returning fresh state (the
 * input is never mutated, so a caller can hold it in a reactive field). */
export function trackSwipe(s: Swipe, x: number, y: number, lock = AXIS_LOCK_PX): Swipe {
  if (s.axis === 'y') return s
  const dx = x - s.startX
  const dy = y - s.startY
  if (s.axis === null) {
    // Horizontal wins ties on the diagonal only when it strictly dominates, so
    // a mostly-vertical drag can never be mistaken for a swipe.
    if (Math.abs(dx) > lock && Math.abs(dx) > Math.abs(dy)) return { ...s, axis: 'x', dx }
    if (Math.abs(dy) > lock) return { ...s, axis: 'y', dx: 0 }
    return s
  }
  return { ...s, dx }
}

/** Which action a finished gesture fires, or null for none (never locked to
 * `'x'`, or locked but short of the threshold — the row snaps back). */
export function resolveSwipe(s: Swipe, threshold = SWIPE_THRESHOLD_PX): 'left' | 'right' | null {
  if (s.axis !== 'x') return null
  if (s.dx >= threshold) return 'right'
  if (s.dx <= -threshold) return 'left'
  return null
}

/** True once the gesture has committed horizontally — the signal to swallow the
 * click that a pointer-up on the same element would otherwise fire. */
export function isSwiping(s: Swipe): boolean {
  return s.axis === 'x'
}
