// The out-of-band identity handshake for spousal sharing: a single
// self-describing code carrying both public keys plus a display label —
// everything the other person's Share screen needs to grant and mail a
// wrapped vault key. Neither key is secret; the code only saves transcription,
// and `fingerprint` gives both sides a short string to eyeball-confirm over
// the exchange channel (a QR shown in person, or a copy-pasted string over a
// channel both people already trust).
import { renderSVG } from 'uqr'

const PREFIX = 'svastha1'
const HEX64 = /^[0-9a-f]{64}$/

export interface ExchangeCode {
  ed25519Hex: string
  x25519Hex: string
  label: string
}

/** Thrown by {@link parseExchangeCode} with a message safe to show the user
 * directly — this is user-typed (or scanned) input. */
export class ExchangeCodeError extends Error {}

/** Build a shareable code: `svastha1:{ed25519_hex}:{x25519_hex}:{label}`. The
 * label is percent-encoded so an arbitrary display name can never introduce a
 * stray `:` that would shift the field count. */
export function buildExchangeCode(ed25519Hex: string, x25519Hex: string, label: string): string {
  return `${PREFIX}:${ed25519Hex}:${x25519Hex}:${encodeURIComponent(label)}`
}

/** Parse and strictly validate a pasted or scanned exchange code: exactly the
 * `svastha1` prefix, two 64-char lowercase-hex keys, and an optional label (3
 * or 4 colon-separated parts — the label may be omitted entirely rather than
 * encoded as empty). Throws {@link ExchangeCodeError} on anything else. */
export function parseExchangeCode(code: string): ExchangeCode {
  const parts = code.trim().split(':')
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== PREFIX) {
    throw new ExchangeCodeError("That doesn't look like a Svastha sharing code.")
  }
  const [, ed25519Hex, x25519Hex, labelPart] = parts
  if (!HEX64.test(ed25519Hex) || !HEX64.test(x25519Hex)) {
    throw new ExchangeCodeError('The code has a missing or malformed key.')
  }
  let label = ''
  if (labelPart !== undefined) {
    try {
      label = decodeURIComponent(labelPart)
    } catch {
      throw new ExchangeCodeError('The code has a malformed label.')
    }
  }
  return { ed25519Hex, x25519Hex, label }
}

/** A short fingerprint of an Ed25519 key for out-of-band verification: 4
 * groups of 4 hex characters (16 of the key's 64), spoken or read aloud to
 * confirm both sides exchanged the same code before granting anything.
 * Deliberately short — it's a confirmation aid, not the full key. */
export function fingerprint(ed25519Hex: string): string {
  return (ed25519Hex.match(/.{4}/g) ?? []).slice(0, 4).join(' ')
}

/** Render an exchange code as an SVG QR string. Safe to inject via `{@html}`:
 * the input is always this app's own generated code (never arbitrary user
 * text), so there is nothing here for a hostile string to exploit. */
export function codeQrSvg(code: string): string {
  return renderSVG(code, { border: 1 })
}

/** Build a device-link URL: this app's own onboarding screen, on the restore
 * tab, with a relay prefilled — what "Link another device" in Settings
 * encodes as a QR for the new device's camera to open directly (no in-app
 * scanner, no new relay protocol; see `Onboard.svelte`'s `relay=` handling
 * and `docs/ARCHITECTURE.md`'s Relay section). The seed phrase itself is
 * never part of this URL — it's entered by hand on the new device. */
export function deviceLinkUrl(appOrigin: string, relayUrl: string): string {
  return `${appOrigin}/#/onboard?relay=${encodeURIComponent(relayUrl)}`
}
