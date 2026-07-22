import { describe, expect, it } from 'vitest'
import { orderByFrequency, selectPetals } from '../bloom-order'

describe('orderByFrequency', () => {
  it('keeps the default order when every count is zero', () => {
    const items = ['a', 'b', 'c']
    expect(orderByFrequency(items, () => 0)).toEqual(['a', 'b', 'c'])
  })

  it('brings a decisively more-used item to the front', () => {
    const counts: Record<string, number> = { a: 1, b: 1, c: 40 }
    expect(orderByFrequency(['a', 'b', 'c'], (item) => counts[item])).toEqual(['c', 'a', 'b'])
  })

  it('does not reorder counts within the same log2 bucket', () => {
    // floor(log2(9)) === floor(log2(13)) === 3 — same bucket, so the default
    // order (a before b) is kept despite b's higher raw count.
    const counts: Record<string, number> = { a: 8, b: 12 }
    expect(orderByFrequency(['a', 'b'], (item) => counts[item])).toEqual(['a', 'b'])
  })

  it('is stable: equal counts never swap', () => {
    const items = [
      { id: 1, count: 5 },
      { id: 2, count: 5 },
      { id: 3, count: 5 },
    ]
    expect(orderByFrequency(items, (item) => item.count).map((i) => i.id)).toEqual([1, 2, 3])
  })
})

describe('selectPetals', () => {
  it('shows every item as a petal with no More when there are 7 or fewer', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(selectPetals(items)).toEqual({ petals: items, hasMore: false })
  })

  it('shows all items with no More at exactly the boundary', () => {
    const items = [1, 2, 3, 4, 5, 6]
    expect(selectPetals(items)).toEqual({ petals: items, hasMore: false })
  })

  it('caps at 6 petals plus More once there are more than 7 items', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(selectPetals(items)).toEqual({ petals: ['a', 'b', 'c', 'd', 'e', 'f'], hasMore: true })
  })

  it('respects the given ordering when capping (top-N, not resorted)', () => {
    const items = ['g', 'a', 'f', 'b', 'e', 'c', 'd', 'h', 'z']
    expect(selectPetals(items)).toEqual({
      petals: ['g', 'a', 'f', 'b', 'e', 'c'],
      hasMore: true,
    })
  })
})
