import { describe, expect, it, vi } from 'vitest'

// The wasm module needs a browser, so unit tests run in node without it (see
// vitest.config.ts) and mock `../svastha`, mirroring keyvault.test.ts. The fake
// DataKey seals a *plaintext-carrying* authenticated blob (key + aad checked at
// open, no real AEAD — the envelope is core's job, covered by its own vectors),
// which is enough to exercise the recipient's open → validate → verify pipeline.
// verify_event is faked to accept an event iff its `signature` field is 'ok'.
vi.mock('../svastha', () => {
  const enc = new TextEncoder()
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

  class FakeDataKey {
    constructor(private key: Uint8Array) {}
    static from_bytes(b: Uint8Array) {
      return new FakeDataKey(Uint8Array.from(b))
    }
    seal(pt: Uint8Array, aad: Uint8Array): Uint8Array {
      return new Uint8Array([...this.key, aad.length, ...aad, ...pt])
    }
    open(blob: Uint8Array, aad: Uint8Array): Uint8Array {
      const key = blob.subarray(0, 32)
      if (!eq(key, this.key)) throw new Error('wrong key')
      const aadLen = blob[32]
      const storedAad = blob.subarray(33, 33 + aadLen)
      if (!eq(storedAad, aad)) throw new Error('wrong aad')
      return Uint8Array.from(blob.subarray(33 + aadLen))
    }
  }

  const verify_event = (json: string): boolean => {
    try {
      return (JSON.parse(json) as { signature?: string }).signature === 'ok'
    } catch {
      return false
    }
  }

  return { WasmDataKey: FakeDataKey, verify_event }
})

import {
  parseShareFragment,
  validateBundle,
  verifyBundleEvents,
  openShareBundle,
} from '../shareRecipient'
import { WasmDataKey } from '../svastha'
import type { StoredEvent } from '../events'

// base64url unpadded, matching the pinned link contract's encoding.
function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s))

const TOKEN = 'abcdefghijklmnopqrstuvwxyz' // 26 chars
const KEY = new Uint8Array(32).fill(7)
const RELAY = 'https://relay.example.org'

function link(token = TOKEN, key = KEY, relay = RELAY): string {
  return `#/s/${token}.${b64url(key)}.${b64urlStr(relay)}`
}

function event(id: string, author: string, signature: string): StoredEvent {
  return {
    event: { id, kind: 'observation', code: null, effective_at: null, value: null, provenance: { source: 'self', source_doc: null } },
    author,
    signature,
  }
}

describe('parseShareFragment', () => {
  it('parses a well-formed link into token, 32-byte key, and relay origin', () => {
    const parsed = parseShareFragment(link())
    expect(parsed).not.toBeNull()
    expect(parsed!.token).toBe(TOKEN)
    expect(parsed!.key).toEqual(KEY)
    expect(parsed!.relay).toBe(RELAY)
  })

  it('accepts the bare /s/… path as well as the #-prefixed hash', () => {
    expect(parseShareFragment(link().slice(1))).not.toBeNull()
  })

  it('strips a trailing slash from the relay origin', () => {
    const parsed = parseShareFragment(link(TOKEN, KEY, 'https://relay.example.org/'))
    expect(parsed!.relay).toBe('https://relay.example.org')
  })

  it('rejects a hash that is not a share link', () => {
    expect(parseShareFragment('#/settings')).toBeNull()
    expect(parseShareFragment('#/')).toBeNull()
    expect(parseShareFragment('')).toBeNull()
  })

  it('rejects garbage after /s/', () => {
    expect(parseShareFragment('#/s/garbage')).toBeNull()
  })

  it('rejects the wrong number of dot-separated segments', () => {
    expect(parseShareFragment(`#/s/${TOKEN}.${b64url(KEY)}`)).toBeNull() // 2
    expect(parseShareFragment(`#/s/${TOKEN}.${b64url(KEY)}.${b64urlStr(RELAY)}.extra`)).toBeNull() // 4
  })

  it('rejects a token of the wrong length or charset', () => {
    expect(parseShareFragment(link('short'))).toBeNull()
    expect(parseShareFragment(link('abcdefghijklmnopqrstuvwxy.'))).toBeNull() // dot in token slot splits wrong
    expect(parseShareFragment(link('abcdefghij!lmnopqrstuvwxyz'))).toBeNull() // bad char
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(parseShareFragment(link(TOKEN, new Uint8Array(16).fill(1)))).toBeNull()
  })

  it('rejects a relay that is not an http(s) origin', () => {
    expect(parseShareFragment(link(TOKEN, KEY, 'ftp://relay.example.org'))).toBeNull()
    expect(parseShareFragment(link(TOKEN, KEY, 'relay.example.org'))).toBeNull()
  })
})

describe('validateBundle', () => {
  const signerBytes = new Uint8Array(32).fill(9)
  const signer = b64url(signerBytes)
  const signerHex = Array.from(signerBytes, (b) => b.toString(16).padStart(2, '0')).join('')

  it('accepts a v1 bundle and hex-decodes the signer', () => {
    const json = JSON.stringify({ v: 1, created_at: '2026-07-14T00:00:00Z', signer, events: [] })
    const v = validateBundle(json)
    expect(v).not.toBeNull()
    expect(v!.createdAt).toBe('2026-07-14T00:00:00Z')
    expect(v!.signerHex).toBe(signerHex)
    expect(v!.events).toEqual([])
  })

  it('rejects malformed JSON', () => {
    expect(validateBundle('{not json')).toBeNull()
  })

  it('rejects a version other than 1', () => {
    expect(validateBundle(JSON.stringify({ v: 2, created_at: 'x', signer, events: [] }))).toBeNull()
  })

  it('rejects missing or mistyped fields', () => {
    expect(validateBundle(JSON.stringify({ v: 1, signer, events: [] }))).toBeNull() // no created_at
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', events: [] }))).toBeNull() // no signer
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: {} }))).toBeNull() // events not array
  })

  it('rejects a signer that is not a 32-byte key', () => {
    const shortSigner = b64url(new Uint8Array(16))
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer: shortSigner, events: [] }))).toBeNull()
  })
})

describe('verifyBundleEvents', () => {
  const signerHex = 'ab'.repeat(32)
  const other = 'cd'.repeat(32)

  it('keeps validly-signed events by the signer, drops and counts the rest', () => {
    const events = [
      event('a', signerHex, 'ok'), // kept
      event('b', signerHex, 'bad'), // dropped: signature does not verify
      event('c', other, 'ok'), // dropped: valid signature, wrong author (spliced)
      event('d', signerHex, 'ok'), // kept
    ]
    const r = verifyBundleEvents(events, signerHex)
    expect(r.verified).toBe(2)
    expect(r.dropped).toBe(2)
    expect(r.events.map((e) => e.event.id)).toEqual(['a', 'd'])
  })

  it('reports zero of each for an empty event list', () => {
    expect(verifyBundleEvents([], signerHex)).toEqual({ events: [], verified: 0, dropped: 0 })
  })
})

describe('openShareBundle (round-trip through the mocked envelope)', () => {
  const signerBytes = new Uint8Array(32).fill(3)
  const signer = b64url(signerBytes)
  const signerHex = Array.from(signerBytes, (b) => b.toString(16).padStart(2, '0')).join('')

  function sealed(bundleObj: unknown): Uint8Array {
    const key = WasmDataKey.from_bytes(KEY)
    return key.seal(new TextEncoder().encode(JSON.stringify(bundleObj)), new TextEncoder().encode(TOKEN))
  }

  it('opens, validates, and verifies a good bundle', () => {
    const bytes = sealed({
      v: 1,
      created_at: '2026-07-14T00:00:00Z',
      signer,
      events: [event('a', signerHex, 'ok'), event('b', signerHex, 'bad')],
    })
    const opened = openShareBundle(bytes, TOKEN, KEY)
    expect(opened).not.toBeNull()
    expect(opened!.createdAt).toBe('2026-07-14T00:00:00Z')
    expect(opened!.signerHex).toBe(signerHex)
    expect(opened!.verified).toBe(1)
    expect(opened!.dropped).toBe(1)
  })

  it('returns null when the wrong key is supplied (open throws → damaged)', () => {
    const bytes = sealed({ v: 1, created_at: 'x', signer, events: [] })
    expect(openShareBundle(bytes, TOKEN, new Uint8Array(32).fill(99))).toBeNull()
  })

  it('returns null when the token (AAD) does not match', () => {
    const bytes = sealed({ v: 1, created_at: 'x', signer, events: [] })
    expect(openShareBundle(bytes, 'zzzzzzzzzzzzzzzzzzzzzzzzzz', KEY)).toBeNull()
  })

  it('returns null on a decrypted-but-malformed bundle (damaged)', () => {
    const key = WasmDataKey.from_bytes(KEY)
    const bytes = key.seal(new TextEncoder().encode('not a bundle'), new TextEncoder().encode(TOKEN))
    expect(openShareBundle(bytes, TOKEN, KEY)).toBeNull()
  })
})
