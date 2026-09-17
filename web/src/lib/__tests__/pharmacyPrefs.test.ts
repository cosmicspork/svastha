import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, put } from '../db'
import { isListSize, LIST_SIZE_PREF, loadListSize, setListSize } from '../pharmacyPrefs'

// Same rationale as theme.test.ts: close and clear the memoized connection so
// each test starts from an empty `prefs` store.
beforeEach(deleteDb)

describe('loadListSize', () => {
  it('defaults to standard when nothing is stored', async () => {
    expect(await loadListSize()).toBe('standard')
  })

  it('round-trips a stored size', async () => {
    await setListSize('counter')
    expect(await loadListSize()).toBe('counter')
    await setListSize('standard')
    expect(await loadListSize()).toBe('standard')
  })

  // Adversarial: the `prefs` store outlives any one build, so a value this
  // version has never heard of has to fall back rather than reach the DOM as a
  // `data-size` nothing styles.
  it.each([['huge'], ['COUNTER'], ['counter '], [''], [42], [null], [{}], [['counter']]])(
    'falls back to standard for a stored %o',
    async (stored) => {
      await put('prefs', stored, LIST_SIZE_PREF)
      expect(await loadListSize()).toBe('standard')
    },
  )
})

describe('isListSize', () => {
  it('accepts exactly the two sizes', () => {
    expect(isListSize('standard')).toBe(true)
    expect(isListSize('counter')).toBe(true)
    expect(isListSize('Counter')).toBe(false)
    expect(isListSize(undefined)).toBe(false)
  })
})
