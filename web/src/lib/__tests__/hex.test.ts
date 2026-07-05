import { describe, expect, it } from 'vitest'
import { toHex, fromHex } from '../hex'

describe('hex', () => {
  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255])
    expect(fromHex(toHex(bytes))).toEqual(bytes)
  })

  it('encodes with lowercase, zero-padded pairs', () => {
    expect(toHex(new Uint8Array([0, 10, 255]))).toBe('000aff')
  })

  it('rejects an odd-length string', () => {
    expect(() => fromHex('abc')).toThrow()
  })
})
