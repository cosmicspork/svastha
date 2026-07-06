import { describe, expect, it } from 'vitest'
import {
  buildExchangeCode,
  parseExchangeCode,
  fingerprint,
  deviceLinkUrl,
  ExchangeCodeError,
} from '../exchange'

const ED = 'a'.repeat(64)
const X25519 = 'b'.repeat(64)

describe('buildExchangeCode + parseExchangeCode', () => {
  it('round-trips a code with a label', () => {
    const code = buildExchangeCode(ED, X25519, 'Alex')
    expect(code).toBe(`svastha1:${ED}:${X25519}:Alex`)
    expect(parseExchangeCode(code)).toEqual({ ed25519Hex: ED, x25519Hex: X25519, label: 'Alex' })
  })

  it('percent-encodes a label so a stray colon cannot shift the field count', () => {
    const code = buildExchangeCode(ED, X25519, 'Alex: at home')
    expect(parseExchangeCode(code)).toEqual({
      ed25519Hex: ED,
      x25519Hex: X25519,
      label: 'Alex: at home',
    })
  })

  it('accepts a code with no label (3 parts)', () => {
    const code = `svastha1:${ED}:${X25519}`
    expect(parseExchangeCode(code)).toEqual({ ed25519Hex: ED, x25519Hex: X25519, label: '' })
  })

  it('trims surrounding whitespace (paste/scan noise)', () => {
    const code = `  svastha1:${ED}:${X25519}:Alex  \n`
    expect(parseExchangeCode(code)).toEqual({ ed25519Hex: ED, x25519Hex: X25519, label: 'Alex' })
  })

  it('rejects a wrong prefix', () => {
    expect(() => parseExchangeCode(`svastha2:${ED}:${X25519}:Alex`)).toThrow(ExchangeCodeError)
  })

  it('rejects too few or too many parts', () => {
    expect(() => parseExchangeCode(`svastha1:${ED}`)).toThrow(ExchangeCodeError)
    expect(() => parseExchangeCode(`svastha1:${ED}:${X25519}:Alex:extra`)).toThrow(ExchangeCodeError)
  })

  it('rejects a malformed or short key', () => {
    expect(() => parseExchangeCode(`svastha1:not-hex:${X25519}:Alex`)).toThrow(ExchangeCodeError)
    expect(() => parseExchangeCode(`svastha1:${ED.slice(0, 63)}:${X25519}:Alex`)).toThrow(
      ExchangeCodeError,
    )
  })

  it('rejects uppercase hex (the wire form is always lowercase)', () => {
    expect(() => parseExchangeCode(`svastha1:${ED.toUpperCase()}:${X25519}:Alex`)).toThrow(
      ExchangeCodeError,
    )
  })

  it('rejects a malformed percent-encoded label', () => {
    expect(() => parseExchangeCode(`svastha1:${ED}:${X25519}:%`)).toThrow(ExchangeCodeError)
  })
})

describe('fingerprint', () => {
  it('formats 16 hex chars as 4 space-separated groups of 4', () => {
    expect(fingerprint(ED)).toBe('aaaa aaaa aaaa aaaa')
  })

  it('is deterministic', () => {
    expect(fingerprint(ED)).toBe(fingerprint(ED))
  })

  it('differs for different keys', () => {
    expect(fingerprint(ED)).not.toBe(fingerprint(X25519))
  })
})

describe('deviceLinkUrl', () => {
  it('builds an onboard restore link with the relay URL as a query param', () => {
    expect(deviceLinkUrl('https://app.example.com', 'https://relay.example.com')).toBe(
      'https://app.example.com/#/onboard?relay=https%3A%2F%2Frelay.example.com',
    )
  })

  it('percent-encodes query-string characters in the relay URL so nested params never leak through', () => {
    const relayUrl = 'https://relay.example.com:8080/path?token=a&b=c'
    const link = deviceLinkUrl('https://app.example.com', relayUrl)
    expect(link).toBe(
      `https://app.example.com/#/onboard?relay=${encodeURIComponent(relayUrl)}`,
    )
    // Round-trips back to the exact original relay URL.
    const [, query] = link.split('?')
    expect(new URLSearchParams(query).get('relay')).toBe(relayUrl)
  })
})
