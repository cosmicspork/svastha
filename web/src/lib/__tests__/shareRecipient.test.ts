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
import { regimenMapFrom, type SignedCurationRecord } from '../curation'

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
    expect(parseShareFragment(`#/s/${TOKEN}.${b64url(KEY)}`)).toBeNull()
    expect(parseShareFragment(`#/s/${TOKEN}.${b64url(KEY)}.${b64urlStr(RELAY)}.extra`)).toBeNull()
  })

  it('rejects a token of the wrong length or charset', () => {
    expect(parseShareFragment(link('short'))).toBeNull()
    expect(parseShareFragment(link('abcdefghijklmnopqrstuvwxy.'))).toBeNull() // dot in token slot splits wrong
    expect(parseShareFragment(link('abcdefghij!lmnopqrstuvwxyz'))).toBeNull()
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

  it('defaults documents to empty when absent, and carries it through when present', () => {
    const legacy = validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [] }))
    expect(legacy!.documents).toEqual({})

    const json = JSON.stringify({
      v: 1,
      created_at: 'x',
      signer,
      events: [],
      documents: { dd: { name: 'export.xml', bytes: 'AQID' } },
    })
    expect(validateBundle(json)!.documents).toEqual({ dd: { name: 'export.xml', bytes: 'AQID' } })
  })

  it('rejects a malformed documents field (not a flat {name, bytes} map)', () => {
    expect(validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], documents: [] }))).toBeNull()
    expect(
      validateBundle(JSON.stringify({ v: 1, created_at: 'x', signer, events: [], documents: { dd: 'AQID' } })),
    ).toBeNull()
    expect(
      validateBundle(
        JSON.stringify({ v: 1, created_at: 'x', signer, events: [], documents: { dd: { name: 'x.xml' } } }),
      ),
    ).toBeNull()
  })

  it('tolerates curation in both directions: absent → empty, present → carried through', () => {
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

// `regimen:` is the third namespace a bundle may carry, and the one whose value
// is rich enough to be dangerous: verification proves a record is *authentic*,
// never that its value is well-formed. These pin both halves — the same
// verify-or-drop the other namespaces get, and the tolerance that keeps a
// verified-but-garbage value from reaching a renderer unchecked.
describe('verifyBundleCuration over regimen: records', () => {
  const signerHex = '3b'.repeat(32)
  const conceptKey = 'medication_statement|http://www.nlm.nih.gov/research/umls/rxnorm|6809'
  const good: SignedCurationRecord = {
    key: `regimen:${conceptKey}`,
    value: { dose: '500 mg', schedule: 'twice a day', route: 'mouth', as_needed: true },
    updated_at: 1,
    author: signerHex,
    signature: 'sig',
  }

  beforeEach(() => {
    mockVerifyCuration.mockReset()
    // Mirror core: a record verifies iff it byte-matches the one we signed.
    // Any mutation of key, value, or metadata therefore fails, exactly as a
    // real Ed25519 check over the canonical record would.
    mockVerifyCuration.mockImplementation((json: string) => json === JSON.stringify(good))
  })

  it('keeps a valid regimen record — the namespace check is not a gate here', () => {
    expect(verifyBundleCuration([good], signerHex)).toEqual({ records: [good], dropped: 0 })
  })

  it('drops and counts a regimen whose value was tampered with in transit', () => {
    const tampered: SignedCurationRecord = {
      ...good,
      value: { ...(good.value as object), dose: '5000 mg' },
    }
    const result = verifyBundleCuration([tampered, good], signerHex)
    expect(result.records).toEqual([good])
    expect(result.dropped).toBe(1)
  })

  it('drops a regimen authored by a key other than the bundle signer', () => {
    const foreign: SignedCurationRecord = { ...good, author: 'f'.repeat(64) }
    const result = verifyBundleCuration([foreign], signerHex)
    expect(result.records).toEqual([])
    expect(result.dropped).toBe(1)
    // Rejected on the author mismatch, before the signature is even consulted.
    expect(mockVerifyCuration).not.toHaveBeenCalled()
  })

  it('lets a verified-but-garbage value through, and regimenMapFrom normalizes it without throwing', () => {
    // The adversarial case the signature cannot catch: the owner's own key
    // signed a value the *renderer* must not trust. A hostile (or just newer)
    // writer can put anything here — wrong types, an out-of-enum route, a
    // non-object — and it verifies. The reducer is the last line of defense.
    const garbage: SignedCurationRecord = {
      key: `regimen:${conceptKey}`,
      value: {
        dose: 42,
        schedule: { evil: true },
        route: 'intravenous', // not in REGIMEN_ROUTES — a route the UI cannot label
        as_needed: 'yes', // truthy string, not the boolean the chip gates on
        started: '2026-13-99',
        prescriber: ['Dr', 'Who'],
        instructions: null,
      },
      updated_at: 2,
      author: signerHex,
      signature: 'sig',
    }
    const nonObject: SignedCurationRecord = {
      key: `regimen:${conceptKey}|other`,
      value: 'not an object at all',
      updated_at: 3,
      author: signerHex,
      signature: 'sig',
    }
    mockVerifyCuration.mockReturnValue(true) // both are authentically signed

    const verified = verifyBundleCuration([garbage, nonObject], signerHex)
    expect(verified.dropped).toBe(0)

    // The renderer's actual entry point — nothing here throws, and nothing
    // out-of-enum or wrong-typed survives to reach a template.
    const map = regimenMapFrom(verified.records)
    expect(map.get(conceptKey)).toBeUndefined() // nothing in it survived
    expect(map.size).toBe(0)
  })

  it('strips only the bad fields from a partly-garbage verified value', () => {
    // The sharper version of the case above: enough survives that the record
    // still renders, so a field the reducer failed to drop WOULD reach the
    // template. Out-of-enum route and non-boolean as_needed must not.
    const mixed: SignedCurationRecord = {
      key: `regimen:${conceptKey}`,
      value: {
        schedule: '  twice a day  ',
        route: 'intravenous',
        as_needed: 'yes',
        started: '2026-13-99',
        prescriber: 7,
      },
      updated_at: 4,
      author: signerHex,
      signature: 'sig',
    }
    mockVerifyCuration.mockReturnValue(true)

    const map = regimenMapFrom(verifyBundleCuration([mixed], signerHex).records)
    expect(map.get(conceptKey)).toEqual({ schedule: 'twice a day' })
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
      documents: { feedface: { name: 'export.xml', bytes: 'AQID' } },
      curation: [good, foreign],
    })
    const opened = openShareBundle(bytes, TOKEN, KEY)
    expect(opened).not.toBeNull()
    expect(opened!.createdAt).toBe('2026-07-14T00:00:00Z')
    expect(opened!.signerHex).toBe(signerHex)
    expect(opened!.verified).toBe(1)
    expect(opened!.dropped).toBe(1)
    expect(opened!.attachments).toEqual({ deadbeef: 'AQID' })
    expect(opened!.documents).toEqual({ feedface: { name: 'export.xml', bytes: 'AQID' } })
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
