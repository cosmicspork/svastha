// Pure ordering for the bloom's petals — no DOM, no db, so it's cheap to unit
// test independent of IndexedDB.

/** Sort `items` by descending usage, most-used first, with the array's
 * original order as the tiebreak (a stable sort). Counts are bucketed into
 * powers of two (`floor(log2(count + 1))`) before comparing, not compared
 * directly — that bucketing IS the hysteresis: two counts in the same bucket
 * (e.g. 8 and 12) are "equally used" and keep their default order, so small
 * day-to-day count drifts don't reshuffle petals. Only a decisive change
 * (crossing a bucket boundary) reorders. */
export function orderByFrequency<T>(items: T[], countOf: (item: T) => number): T[] {
  const bucket = (item: T) => Math.floor(Math.log2(countOf(item) + 1))
  return items
    .map((item, index) => ({ item, index, bucket: bucket(item) }))
    .sort((a, b) => b.bucket - a.bucket || a.index - b.index)
    .map((entry) => entry.item)
}

/** Prefs key holding a user's manual petal order as an array of kind strings.
 * Present = manual order wins over `orderByFrequency`; absent = automatic. */
export const BLOOM_ORDER_PREF = 'bloom-order'

/** Reorder `items` to follow `storedKinds` (a saved manual order). Kinds the
 * stored list doesn't know — added in a release after the order was saved —
 * append after it in their default relative order rather than vanishing;
 * stored kinds that no longer exist are ignored. */
export function applyStoredOrder<T>(
  items: T[],
  storedKinds: string[],
  kindOf: (item: T) => string,
): T[] {
  const rank = new Map(storedKinds.map((kind, i) => [kind, i]))
  return items
    .map((item, index) => ({ item, rank: rank.get(kindOf(item)) ?? storedKinds.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item)
}

/** Action petals shown directly on the fan before folding the rest behind a
 * "More" petal. Six actions + one More petal restores 15° arc spacing (the
 * same ~60px chord seven evenly-spaced petals had at launch); more than that
 * and adjacent petals overlap. */
export const MAX_ACTION_PETALS = 6

/** Arc positions used once overflow kicks in: the six actions plus the
 * trailing More petal. Equal to `MAX_ACTION_PETALS + 1`, named separately so
 * the "does everything fit without a More petal" check reads on its own. */
export const MAX_PETALS_WITH_MORE = MAX_ACTION_PETALS + 1

export interface PetalPlan<T> {
  /** Items to render as fan petals, already capped and in arc order. */
  petals: T[]
  /** Whether a trailing "More" petal is needed to reach the rest of `ordered`. */
  hasMore: boolean
}

/** Decide which of `ordered` (already frequency-sorted) become fan petals vs.
 * fold into the "More" overflow sheet. At `MAX_PETALS_WITH_MORE` or fewer
 * actions there's enough arc room to show everything as a petal; past that,
 * only the top `MAX_ACTION_PETALS` show, plus a trailing More petal that
 * opens the full list. */
export function selectPetals<T>(ordered: T[]): PetalPlan<T> {
  if (ordered.length <= MAX_PETALS_WITH_MORE) {
    return { petals: ordered, hasMore: false }
  }
  return { petals: ordered.slice(0, MAX_ACTION_PETALS), hasMore: true }
}
