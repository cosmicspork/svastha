import { describe, expect, it } from 'vitest'
import { deriveKdfBytes } from '../kdf'

// Low iteration count keeps this fast; DEFAULT_ITERATIONS (600k) is exercised
// implicitly by keyvault, not needed here to test the KDF's properties.
const ITERATIONS = 1000

describe('deriveKdfBytes', () => {
  it('is deterministic for a fixed passphrase, salt, and iteration count', async () => {
    const salt = new Uint8Array(16).fill(7)
    const a = await deriveKdfBytes('correct horse battery staple', salt, ITERATIONS)
    const b = await deriveKdfBytes('correct horse battery staple', salt, ITERATIONS)
    expect(a).toEqual(b)
    expect(a.length).toBe(32)
  })

  it('produces a different output for a different salt', async () => {
    const saltA = new Uint8Array(16).fill(1)
    const saltB = new Uint8Array(16).fill(2)
    const a = await deriveKdfBytes('same passphrase', saltA, ITERATIONS)
    const b = await deriveKdfBytes('same passphrase', saltB, ITERATIONS)
    expect(a).not.toEqual(b)
  })

  it('produces a different output for a different passphrase', async () => {
    const salt = new Uint8Array(16).fill(3)
    const a = await deriveKdfBytes('passphrase one', salt, ITERATIONS)
    const b = await deriveKdfBytes('passphrase two', salt, ITERATIONS)
    expect(a).not.toEqual(b)
  })
})
