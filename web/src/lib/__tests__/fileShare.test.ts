import { describe, expect, it, vi } from 'vitest'

// Same fake envelope the recipient's unit tests use: a plaintext-carrying
// authenticated blob that checks key + AAD at open (no real AEAD — that is
// core's job, covered by its own vectors), enough to exercise the file format's
// seal → header → parse → open round-trip. verify_event accepts an event iff its
// `signature` is 'ok'; verify_curation accepts everything (no curation in these
// cases). PBKDF2 runs against real WebCrypto (available under vitest's node
// env), so the KDF vectors below are genuine.
vi.mock('../svastha', () => {
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
  return { WasmDataKey: FakeDataKey, verify_event, verify_curation: () => true }
})

import {
  MAGIC,
  FORMAT_VERSION,
  FILE_SHARE_EXT,
  FILE_SHARE_PASSPHRASE_WORDS,
  PBKDF2_ITERATIONS,
  buildEmbeddedHeader,
  buildPassphraseHeader,
  parseHeader,
  assembleFile,
  generatePassphrase,
  normalizePassphrase,
  derivePassphraseKey,
  createFileShare,
  fileShareFilename,
  inspectFileShare,
  openWithPassphrase,
} from '../fileShare'
import type { StoredEvent } from '../events'
import type { WasmIdentity } from '../svastha'

const SIGNER_HEX = 'ab'.repeat(32)
const key32 = (fill: number) => new Uint8Array(32).fill(fill)
const salt16 = () => Uint8Array.from({ length: 16 }, (_, i) => i + 1)

function event(id: string, signature: string, author = SIGNER_HEX): StoredEvent {
  return {
    event: { id, kind: 'observation', code: null, effective_at: null, value: null, provenance: { source: 'self', source_doc: null } },
    author,
    signature,
  }
}

// A minimal identity: assembleShareBundle only reads `ed25519_public_hex`, and
// events with no attachments/source docs never touch the db.
const identity = { ed25519_public_hex: SIGNER_HEX } as unknown as WasmIdentity

describe('header encode/parse round-trip', () => {
  it('round-trips an embedded header with the 32-byte key and body', () => {
    const header = buildEmbeddedHeader(key32(7))
    const file = assembleFile(header, new Uint8Array([1, 2, 3]))
    const parsed = parseHeader(file)
    expect(parsed).not.toBeNull()
    expect(parsed!.mode).toBe('embedded')
    if (parsed!.mode !== 'embedded') throw new Error('mode')
    expect(parsed!.key).toEqual(key32(7))
    expect(parsed!.body).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('round-trips a passphrase header with salt and iteration count', () => {
    const header = buildPassphraseHeader(salt16(), PBKDF2_ITERATIONS)
    const file = assembleFile(header, new Uint8Array([9, 9]))
    const parsed = parseHeader(file)
    expect(parsed!.mode).toBe('passphrase')
    if (parsed!.mode !== 'passphrase') throw new Error('mode')
    expect(parsed!.salt).toEqual(salt16())
    expect(parsed!.iterations).toBe(PBKDF2_ITERATIONS)
    expect(parsed!.body).toEqual(new Uint8Array([9, 9]))
  })

  it('encodes a large iteration count intact (u32, big-endian)', () => {
    const parsed = parseHeader(assembleFile(buildPassphraseHeader(salt16(), 600_000), new Uint8Array([0])))
    expect(parsed!.mode === 'passphrase' && parsed!.iterations).toBe(600_000)
  })

  it('rejects a key or salt of the wrong size at build time', () => {
    expect(() => buildEmbeddedHeader(new Uint8Array(16))).toThrow()
    expect(() => buildPassphraseHeader(new Uint8Array(8), 1000)).toThrow()
  })
})

describe('parseHeader tamper / damage cases', () => {
  const embedded = assembleFile(buildEmbeddedHeader(key32(1)), new Uint8Array([1]))
  const passphrase = assembleFile(buildPassphraseHeader(salt16(), 1000), new Uint8Array([1]))

  it('rejects wrong magic', () => {
    const bad = Uint8Array.from(embedded)
    bad[0] ^= 0xff
    expect(parseHeader(bad)).toBeNull()
  })

  it('rejects an unknown format version', () => {
    const bad = Uint8Array.from(embedded)
    bad[4] = FORMAT_VERSION + 1
    expect(parseHeader(bad)).toBeNull()
  })

  it('rejects an unknown mode byte', () => {
    const bad = Uint8Array.from(embedded)
    bad[5] = 9
    expect(parseHeader(bad)).toBeNull()
  })

  it('rejects a header truncated before its key/salt is complete', () => {
    expect(parseHeader(embedded.subarray(0, 20))).toBeNull() // < 6 + 32
    expect(parseHeader(passphrase.subarray(0, 20))).toBeNull() // < 6 + 16 + 4
  })

  it('rejects a file with a valid header but no body', () => {
    expect(parseHeader(buildEmbeddedHeader(key32(1)))).toBeNull() // header only, no sealed bytes
    expect(parseHeader(buildPassphraseHeader(salt16(), 1000))).toBeNull()
  })

  it('rejects a zero iteration count', () => {
    expect(parseHeader(assembleFile(buildPassphraseHeader(salt16(), 0), new Uint8Array([1])))).toBeNull()
  })

  it('the magic is the ASCII "SVSH"', () => {
    expect([...MAGIC]).toEqual([...new TextEncoder().encode('SVSH')])
  })
})

describe('KDF derivation vectors (fixed salt + phrase → known key)', () => {
  const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

  it('matches a pinned PBKDF2-SHA-256 vector', async () => {
    const key = await derivePassphraseKey('brave acid zebra ocean lemon puppy tiger', salt16(), 1000)
    expect(key).toHaveLength(32)
    expect(toHex(key)).toBe('263d58805e42b3874a53dca40f38cdede1ebb1d370409ce9c279c2f95e774de5')
  })

  it('is deterministic and salt-dependent', async () => {
    const a = await derivePassphraseKey('brave acid zebra', salt16(), 1000)
    const b = await derivePassphraseKey('brave acid zebra', salt16(), 1000)
    const c = await derivePassphraseKey('brave acid zebra', new Uint8Array(16), 1000)
    expect(toHex(a)).toBe(toHex(b))
    expect(toHex(a)).not.toBe(toHex(c))
  })

  it('normalizes casing and whitespace so equivalent typings derive the same key', async () => {
    const canonical = await derivePassphraseKey('brave acid zebra', salt16(), 1000)
    const messy = await derivePassphraseKey('  Brave   ACID\tzebra ', salt16(), 1000)
    expect(toHex(messy)).toBe(toHex(canonical))
  })

  it('collapses inner whitespace but preserves an intra-word hyphen', () => {
    expect(normalizePassphrase('  YO-YO  Brave ')).toBe('yo-yo brave')
  })
})

describe('generated passphrase entropy', () => {
  it('draws FILE_SHARE_PASSPHRASE_WORDS words, all from the embedded list', async () => {
    const { WORDLIST } = await import('../wordlist')
    expect(WORDLIST).toHaveLength(1296)
    expect(new Set(WORDLIST).size).toBe(1296)
    const phrase = await generatePassphrase()
    const words = phrase.split(' ')
    expect(words).toHaveLength(FILE_SHARE_PASSPHRASE_WORDS)
    for (const w of words) expect(WORDLIST).toContain(w)
  })

  it('clears the 64-bit floor the design sets', () => {
    const bitsPerWord = Math.log2(1296)
    expect(FILE_SHARE_PASSPHRASE_WORDS * bitsPerWord).toBeGreaterThanOrEqual(64)
  })

  it('varies across calls (not a constant)', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) seen.add(await generatePassphrase())
    expect(seen.size).toBe(20)
  })
})

describe('filename', () => {
  it('is a dated .svashare file', () => {
    const name = fileShareFilename(new Date('2026-07-24T10:00:00Z'))
    expect(name.endsWith(FILE_SHARE_EXT)).toBe(true)
    expect(name).toMatch(/^svastha-share-\d{4}-\d{2}-\d{2}\.svashare$/)
  })
})

describe('createFileShare → inspect/open round-trip', () => {
  const events = [event('a', 'ok'), event('b', 'bad')] // one verifies, one is dropped

  it('embedded mode: opens straight from the file, verifying and dropping events', async () => {
    const exported = await createFileShare({ identity, events, mode: 'embedded' })
    expect(exported.mode).toBe('embedded')
    expect(exported.passphrase).toBeNull()
    // Header advertises embedded mode.
    const header = parseHeader(exported.bytes)
    expect(header!.mode).toBe('embedded')

    const inspection = inspectFileShare(exported.bytes)
    expect(inspection.status).toBe('ok')
    if (inspection.status !== 'ok') throw new Error('expected ok')
    expect(inspection.bundle.signerHex).toBe(SIGNER_HEX)
    expect(inspection.bundle.verified).toBe(1)
    expect(inspection.bundle.dropped).toBe(1)
    expect(inspection.bundle.events.map((e) => e.event.id)).toEqual(['a'])
  })

  it('passphrase mode: prompts, then opens under the shown phrase', async () => {
    const exported = await createFileShare({ identity, events, mode: 'passphrase' })
    expect(exported.mode).toBe('passphrase')
    expect(exported.passphrase).toBeTruthy()
    expect(exported.passphrase!.split(' ')).toHaveLength(FILE_SHARE_PASSPHRASE_WORDS)

    const inspection = inspectFileShare(exported.bytes)
    expect(inspection.status).toBe('passphrase')
    if (inspection.status !== 'passphrase') throw new Error('expected passphrase')

    const opened = await openWithPassphrase(
      inspection.body,
      inspection.salt,
      inspection.iterations,
      exported.passphrase!,
    )
    expect(opened).not.toBeNull()
    expect(opened!.verified).toBe(1)
    expect(opened!.dropped).toBe(1)
  })

  it('passphrase mode: a wrong phrase fails to open (retryable), a damaged case too', async () => {
    const exported = await createFileShare({ identity, events, mode: 'passphrase' })
    const inspection = inspectFileShare(exported.bytes)
    if (inspection.status !== 'passphrase') throw new Error('expected passphrase')
    const wrong = await openWithPassphrase(inspection.body, inspection.salt, inspection.iterations, 'not the phrase')
    expect(wrong).toBeNull()
  })

  it('passphrase-mode normalization: the phrase opens regardless of casing/spacing', async () => {
    const exported = await createFileShare({ identity, events, mode: 'passphrase' })
    const inspection = inspectFileShare(exported.bytes)
    if (inspection.status !== 'passphrase') throw new Error('expected passphrase')
    const messy = `  ${exported.passphrase!.toUpperCase().replace(/ /g, '   ')} `
    const opened = await openWithPassphrase(inspection.body, inspection.salt, inspection.iterations, messy)
    expect(opened).not.toBeNull()
  })

  it('a corrupted embedded key is reported as damaged — not silently rendered', async () => {
    const exported = await createFileShare({ identity, events, mode: 'embedded' })
    const corrupt = Uint8Array.from(exported.bytes)
    // Flip the first byte of the header's embedded key: it no longer matches the
    // key the body was sealed under, so the open fails → damaged (there is no
    // phrase to retry in embedded mode).
    corrupt[6] ^= 0xff
    expect(inspectFileShare(corrupt).status).toBe('damaged')
  })

  it('a file with an invalid header is damaged', () => {
    expect(inspectFileShare(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).status).toBe('damaged')
  })
})
