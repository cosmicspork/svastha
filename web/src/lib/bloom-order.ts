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
