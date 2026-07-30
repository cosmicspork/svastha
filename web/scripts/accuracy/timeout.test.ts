import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from './timeout.ts'

afterEach(() => vi.useRealTimers())

describe('withTimeout', () => {
  it('rejects a browser operation that never settles', async () => {
    vi.useFakeTimers()
    const pending = withTimeout(new Promise<never>(() => {}), 180_000, 'reader timed out')
    const assertion = expect(pending).rejects.toThrow('reader timed out')

    await vi.advanceTimersByTimeAsync(180_000)
    await assertion
  })
})
