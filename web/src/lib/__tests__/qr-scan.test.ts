import { describe, expect, it } from 'vitest'
import { toExchangeCode } from '../qr-scan'
import { buildExchangeCode, exchangeLinkFor } from '../exchange'

const ED = 'a'.repeat(64)
const X25519 = 'b'.repeat(64)

// The scanner's plumbing: whatever a detector (native BarcodeDetector or the
// jsQR fallback) hands back as decoded text must land as the same raw code the
// paste box would produce, so a scan feeds the identical confirm flow.
describe('toExchangeCode', () => {
  it('passes a bare svastha1 code straight through', () => {
    const code = buildExchangeCode(ED, X25519, 'Alex')
    expect(toExchangeCode(code)).toBe(code)
  })

  it('unwraps the #89 deep-link QR payload to its bare code', () => {
    const code = buildExchangeCode(ED, X25519, 'Alex')
    const link = exchangeLinkFor('https://app.example.com', code)
    expect(toExchangeCode(link)).toBe(code)
  })

  it('rejects a QR that is not a Svastha code', () => {
    expect(toExchangeCode('https://example.com/hello')).toBeNull()
    expect(toExchangeCode('svastha1:tooshort')).toBeNull()
  })

  it('rejects empty / missing input rather than throwing', () => {
    expect(toExchangeCode('')).toBeNull()
    expect(toExchangeCode(null)).toBeNull()
    expect(toExchangeCode(undefined)).toBeNull()
  })
})
