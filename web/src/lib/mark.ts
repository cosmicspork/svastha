// The Svastha mark: a fern fiddlehead, a frond in the moment before it opens.
//
// Held as geometry, not traced path data, so every shipping size derives from
// one definition and the in-app mark cannot drift from the committed icons.
// components/Mark.svelte renders it; scripts/build-icons/build.ts writes the
// SVG and PNG assets from the same call.
//
// The spiral is logarithmic (r = R0·e^{K·θ}), sampled into an outer and inner
// edge and closed into one filled shape. The widening separation is
// load-bearing: a constant-width spiral reads as a progress spinner.
//
// The sampled ring is emitted as cubic Béziers rather than as a polyline. A
// polyline dense enough to look smooth at 512 px cost ~7 KB per asset, which is
// absurd for an icon and all of it lands in the service worker's precache.

/** Spiral growth rate. Tuned so the large tier's coil fills the safe area. */
const K = 0.235
/** Radius at θ = 0, in viewBox units. */
const R0 = 13
/**
 * Angular distance between samples, in radians (~29°). Coarse on purpose: the
 * Bézier fit below passes through every sample, so this only has to be fine
 * enough that the curve between two samples is near-circular.
 */
const STEP = 0.5
/**
 * Side of the square the mark is fitted into. Leaves the mark inside the
 * Android maskable safe circle (radius 204.8 of 512) with room to spare.
 */
const FIT = 340

export const VIEW_BOX = 512

type Point = [number, number]

/**
 * Closed Catmull-Rom spline through `points`, as cubic Béziers. Cyclic, so the
 * frond's tip and its cut stem both round over instead of showing the corners
 * where the outer edge meets the inner one.
 */
function splinePath(points: Point[]): string {
  const n = points.length
  const at = (i: number): Point => points[(i + n) % n]
  const fmt = ([x, y]: Point): string => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`

  let d = `M ${fmt(points[0])}`
  for (let i = 0; i < n; i++) {
    const [p0x, p0y] = at(i - 1)
    const [p1x, p1y] = at(i)
    const [p2x, p2y] = at(i + 1)
    const [p3x, p3y] = at(i + 2)
    const c1: Point = [p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6]
    const c2: Point = [p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6]
    d += ` C ${fmt(c1)} ${fmt(c2)} ${fmt([p2x, p2y])}`
  }
  return `${d} Z`
}

/**
 * `small` is not a scaled-down large tier. Below roughly 32 px the fine end of
 * the taper falls under one pixel and the coil greys out, so the small mark
 * trades turns for weight.
 */
export function fiddlehead(small = false): string {
  const thetaMax = (small ? 2.3 : 3.5) * Math.PI
  // A fraction of how far the spiral actually reaches, not an absolute: the
  // small tier's outermost radius is under half the large tier's, and a shared
  // absolute width closed its coil into a blob.
  const widthAtStem = R0 * Math.exp(K * thetaMax) * (small ? 0.42 : 0.23)

  const samples = Math.ceil(thetaMax / STEP)
  const outer: Point[] = []
  const inner: Point[] = []
  for (let i = 0; i <= samples; i++) {
    const theta = (i / samples) * thetaMax
    const r = R0 * Math.exp(K * theta)
    // Width vanishes at the centre so the coil ends in a real point: a blunt tip
    // leaves a cap segment that the spline pulls into a visible notch. The
    // exponent keeps the body's weight where a linear ramp from zero would thin
    // it out — ^0.55 rises fast near the tip, then flattens.
    const w = widthAtStem * Math.pow(theta / thetaMax, 0.55)
    const nx = Math.cos(theta)
    const ny = Math.sin(theta)
    outer.push([nx * (r + w / 2), ny * (r + w / 2)])
    inner.push([nx * (r - w / 2), ny * (r - w / 2)])
  }

  // inner[0] is dropped: it coincides with outer[0] — both are the tip point.
  const ring: Point[] = [...outer, ...inner.slice(1).reverse()]

  // Centre on the bounding box, not the spiral's origin: a spiral grows away
  // from its origin, so centring there parks the mark low and left in the frame.
  const xs = ring.map(([x]) => x)
  const ys = ring.map(([, y]) => y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const scale = FIT / Math.max(maxX - minX, maxY - minY)
  const offsetX = VIEW_BOX / 2 - (scale * (minX + maxX)) / 2
  const offsetY = VIEW_BOX / 2 - (scale * (minY + maxY)) / 2

  return splinePath(ring.map(([x, y]): Point => [offsetX + scale * x, offsetY + scale * y]))
}
