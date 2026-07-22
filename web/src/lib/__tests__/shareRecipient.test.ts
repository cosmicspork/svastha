import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  // Curation verification is driven per-test (the verify-or-drop cases set an
  // implementation that mirrors the shared spec vectors); default accept.
  const verify_curation = vi.fn(() => true)

  return { WasmDataKey: FakeDataKey, verify_event, verify_curation }
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseShareFragment,
  validateBundle,
  verifyBundleEvents,
  verifyBundleCuration,
  openShareBundle,
} from '../shareRecipient'
import { WasmDataKey, verify_curation } from '../svastha'
import type { StoredEvent } from '../events'
import type { SignedCurationRecord } from '../curation'

const mockVerifyCuration = vi.mocked(verify_curation)

// Default: accept every curation signature. The verify-or-drop describe below
// overrides this for its own tests (an inner beforeEach runs after this one).
beforeEach(() => {
  mockVerifyCuration.mockReset()
  mockVerifyCuration.mockReturnValue(true)
})

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
    // Attachments default to an empty map when the field is absent.
    expect(v!.attachments).toEqual({})
  })

  it('accepts and carries an attachments map when present', () => {
    const json = JSON.stringify({
      v: 1,
      created_at: 'x',
      signer,
      events: [],
      attachments: { aa: 'AQID', bb: 'BAUG' },
    })
    expect(validateBundle(json)!.attachments).toEqual({ aa: 'AQID', bb: 'BAUG' })
  })

  it('rejects a malformed attachments field (not a flat string map)', () => {
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], attachments: [] }))).toBeNull()
    expect(
      validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], attachments: { aa: 5 } })),
    ).toBeNull()
  })

  it('tolerates curation in both directions: absent → empty, present → carried through', () => {
    // An old bundle (field absent) opens identically, with an empty curation array.
    const legacy = validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [] }))
    expect(legacy).not.toBeNull()
    expect(legacy!.curation).toEqual([])

    // A new bundle's array is passed through untouched (signatures are checked
    // later, by verifyBundleCuration).
    const curation = [{ key: 'status:x', value: { status: 'inactive' }, updated_at: 1, author: 'aa', signature: 'ss' }]
    const withCur = validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], curation }))
    expect(withCur!.curation).toEqual(curation)
  })

  it('rejects a curation field that is not an array (damaged, like a bad attachments map)', () => {
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], curation: {} }))).toBeNull()
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

describe('verifyBundleCuration (verify-or-drop against the bundle signer)', () => {
  // The shared trust-contract vectors: one valid signed record plus three tamper
  // cases (mutated value, mutated key, re-attributed author) each pinned
  // `valid: false`. Drive verify_curation off exactly these so the recipient's
  // verify-or-drop is exercised against the real patterns a bundle-builder could
  // tamper with, not an ad-hoc fake.
  const here = dirname(fileURLToPath(import.meta.url))
  const vectors = JSON.parse(
    new TextDecoder().decode(readFileSync(join(here, '../../../../spec/vectors/curation.json'))),
  ) as { records: { valid: boolean; record: SignedCurationRecord }[] }
  const valid = vectors.records.find((r) => r.valid)!.record
  const signerHex = valid.author

  beforeEach(() => {
    mockVerifyCuration.mockReset()
    // Mirror core: a record verifies iff it byte-matches the valid vector; every
    // tamper case differs and so fails. (The wrong-author case is dropped before
    // verify is even reached, on the author mismatch — this is belt-and-braces.)
    mockVerifyCuration.mockImplementation((json: string) => json === JSON.stringify(valid))
  })

  it('keeps the valid record and drops+counts each tampered one', () => {
    const records = vectors.records.map((r) => r.record)
    const result = verifyBundleCuration(records, signerHex)
    expect(result.records).toEqual([valid])
    expect(result.dropped).toBe(3) // mutated value, mutated key, wrong author
  })

  it('drops a record whose author is not the bundle signer, without trusting its signature', () => {
    const foreign: SignedCurationRecord = { ...valid, author: 'f'.repeat(64) }
    const result = verifyBundleCuration([foreign], signerHex)
    expect(result.records).toEqual([])
    expect(result.dropped).toBe(1)
    // Short-circuited on the author mismatch — verify was never consulted.
    expect(mockVerifyCuration).not.toHaveBeenCalled()
  })

  it('drops an unsigned record — a share recipient cannot grandfather one in', () => {
    const unsigned = { ...valid, signature: undefined } as unknown as SignedCurationRecord
    expect(verifyBundleCuration([unsigned], signerHex).dropped).toBe(1)
  })

  it('reports zero of each for an empty list', () => {
    expect(verifyBundleCuration([], signerHex)).toEqual({ records: [], dropped: 0 })
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

  it('opens, validates, and verifies a good bundle, carrying attachments and curation through', () => {
    // One curation record by the signer (kept) and one by a foreign author
    // (dropped on the author check) — so the opened bundle exposes both the
    // verified overlay and the dropped-curation count.
    const good = { key: 'status:x', value: { status: 'inactive' }, updated_at: 1, author: signerHex, signature: 'ok' }
    const foreign = { key: 'name:y', value: { display: 'Z' }, updated_at: 1, author: 'ff'.repeat(32), signature: 'ok' }
    const bytes = sealed({
      v: 1,
      created_at: '2026-07-14T00:00:00Z',
      signer,
      events: [event('a', signerHex, 'ok'), event('b', signerHex, 'bad')],
      attachments: { deadbeef: 'AQID' },
      curation: [good, foreign],
    })
    const opened = openShareBundle(bytes, TOKEN, KEY)
    expect(opened).not.toBeNull()
    expect(opened!.createdAt).toBe('2026-07-14T00:00:00Z')
    expect(opened!.signerHex).toBe(signerHex)
    expect(opened!.verified).toBe(1)
    expect(opened!.dropped).toBe(1)
    expect(opened!.attachments).toEqual({ deadbeef: 'AQID' })
    expect(opened!.curation).toEqual([good])
    expect(opened!.droppedCuration).toBe(1)
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
