// The decode-to-confirm seam for the in-app QR scanner. Kept pure and free of
// any camera/DOM dependency so the plumbing (a decoded string mapped to a
// usable exchange code) unit-tests without a browser, and so QrScanner.svelte
// can stay a thin shell over `getUserMedia` + a detector.
import { extractExchangeCode, parseExchangeCode } from './exchange'

/** Map a QR's decoded text to a raw Svastha exchange code, or null when it is
 * not one. Accepts both payload shapes the app mints: a bare `svastha1:…` code
 * and the #89 deep link (`{origin}/#/share?code=…`), via the same
 * `extractExchangeCode`/`parseExchangeCode` the paste box uses — so a scan and
 * a paste feed the identical confirm flow. Strictly validated: an arbitrary QR
 * the camera happens to catch returns null and scanning simply continues. */
export function toExchangeCode(text: string | null | undefined): string | null {
  if (!text) return null
  try {
    const raw = extractExchangeCode(text)
    parseExchangeCode(raw) // throws on anything that isn't a well-formed code
    return raw
  } catch {
    return null
  }
}

/** Decode one RGBA frame with the pure-JS fallback (jsQR), for engines without
 * `BarcodeDetector` — notably iOS Safari. Dynamically imported so jsQR is only
 * pulled in when a device actually needs the fallback path. Returns the raw QR
 * text, or null when the frame holds no readable code. */
export async function decodeFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(data, width, height)?.data ?? null
}
