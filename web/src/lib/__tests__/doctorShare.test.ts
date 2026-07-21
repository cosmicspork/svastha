import { describe, expect, it, vi } from 'vitest'

// doctorShare.ts imports the wasm `WasmDataKey` at module load, but these tests
// exercise only the pure builders (which never touch it). The wasm module needs
// a browser, so — as keyvault.test.ts does — stub it; a bare class is enough to
// satisfy the import since no test here calls the seal path (that runs against
// real wasm in e2e).
vi.mock('../svastha', () => ({ WasmDataKey: class {} }))

import {
  base64url,
  base64urlToBytes,
  buildBundle,
  buildShareLink,
  deriveShareCategories,
  filterEventsForScope,
  generateShareToken,
  referencedAttachmentShas,
  shareStatus,
  SHARE_TOKEN_LEN,
  type DoctorShareRecord,
  type ShareScope,
} from '../doctorShare'
import { toHex, fromHex } from '../hex'
import type { StoredEvent } from '../events'
import { CATEGORIES, CATEGORY_META, type Category } from '../category'
import { MOOD, BP_SYSTOLIC, CYCLE_START } from '../codes'

const NON_SENSITIVE = CATEGORIES.filter((c) => !CATEGORY_META[c].sensitive)
const set = (...cats: Category[]) => new Set<Category>(cats)

// The pure builders — token/key encoding, link assembly, bundle shape, and
// scope filtering — are the pinned contract the recipient view parses against,
// so they carry the coverage. The seal/upload path runs against real wasm and a
// live relay in e2e (doctor-share.spec.ts), mirroring how relay.spec.ts covers
// the seal/open codec rather than mocking the AEAD.

const TOKEN_RE = /^[A-Za-z0-9_-]+$/

/** A minimal stored event; only the fields categorize/filter read matter. */
function ev(
  id: string,
  kind: StoredEvent['event']['kind'],
  effective_at: string | null,
  code: StoredEvent['event']['code'] = null,
  value: StoredEvent['event']['value'] = null,
): StoredEvent {
  return {
    event: { id, kind, code, effective_at, value, provenance: { source: 'self', source_doc: null } },
    author: 'a'.repeat(64),
    signature: 'b'.repeat(128),
  }
}

describe('generateShareToken', () => {
  it('is 26 chars from the [A-Za-z0-9_-] alphabet, never a dot', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateShareToken()
      expect(t).toHaveLength(SHARE_TOKEN_LEN)
      expect(SHARE_TOKEN_LEN).toBe(26)
      expect(t).toMatch(TOKEN_RE)
      expect(t).not.toContain('.')
    }
  })

  it('clears the relay ≥22-char unguessability floor', () => {
    expect(generateShareToken().length).toBeGreaterThanOrEqual(22)
  })

  it('is effectively unique across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateShareToken())
    expect(seen.size).toBe(1000)
  })
})

describe('base64url', () => {
  it('is unpadded and URL-safe, and round-trips', () => {
    // 0xfb 0xff force both a '-' (from '+') and '_' (from '/') and a pad-drop.
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10])
    const s = base64url(bytes)
    expect(s).not.toContain('=')
    expect(s).not.toContain('+')
    expect(s).not.toContain('/')
    expect(base64urlToBytes(s)).toEqual(bytes)
  })

  it('round-trips a full 32-byte key at every residue length', () => {
    for (const n of [1, 2, 3, 31, 32, 33]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff)
      expect(base64urlToBytes(base64url(bytes))).toEqual(bytes)
    }
  })
})

describe('buildShareLink', () => {
  const key = new Uint8Array(32).fill(7)
  const link = buildShareLink('https://app.example.org', 'TOKEN123456789012345678AB', key, 'https://relay.example.org')

  it('is three dot-separated segments after #/s/', () => {
    const [origin, frag] = link.split('/#/s/')
    expect(origin).toBe('https://app.example.org')
    const parts = frag.split('.')
    expect(parts).toHaveLength(3)
  })

  it('encodes token, key, and relay as the contract specifies', () => {
    const frag = link.split('/#/s/')[1]
    const [token, keySeg, relaySeg] = frag.split('.')
    expect(token).toBe('TOKEN123456789012345678AB')
    expect(base64urlToBytes(keySeg)).toEqual(key)
    expect(new TextDecoder().decode(base64urlToBytes(relaySeg))).toBe('https://relay.example.org')
  })
})

describe('buildBundle', () => {
  const signerHex = '3b'.repeat(32) // a plausible 32-byte Ed25519 public key
  const events = [ev('e1', 'observation', '2026-01-01T09:00:00Z', MOOD)]
  const bundle = buildBundle(events, signerHex, '2026-07-14T12:00:00.000Z')

  it('has the pinned top-level shape', () => {
    expect(bundle.v).toBe(1)
    expect(bundle.created_at).toBe('2026-07-14T12:00:00.000Z')
    expect(bundle.events).toBe(events)
  })

  it('carries the signer as base64url of the 32-byte Ed25519 public key', () => {
    const bytes = base64urlToBytes(bundle.signer)
    expect(bytes).toHaveLength(32)
    expect(toHex(bytes)).toBe(signerHex)
    expect(base64url(fromHex(signerHex))).toBe(bundle.signer)
  })

  it('serializes events in exactly the StoredEvent JSON shape', () => {
    const parsed = JSON.parse(JSON.stringify(bundle)) as typeof bundle
    expect(parsed.events[0]).toEqual(events[0])
  })

  it('omits attachments when there are none, and inlines them when given', () => {
    expect(bundle.attachments).toBeUndefined()
    const withAtt = buildBundle(events, signerHex, '2026-07-14T12:00:00.000Z', { aa: 'AQID' })
    expect(withAtt.attachments).toEqual({ aa: 'AQID' })
  })
})

describe('referencedAttachmentShas', () => {
  const att = (id: string, sha: string) =>
    ev(id, 'document', '2026-01-01T09:00:00Z', null, { attachment: { sha256: sha, mime: 'image/jpeg', size: 1 } })

  it('collects distinct attachment hashes in sha order', () => {
    const events = [att('a', 'bb'), att('b', 'aa'), att('c', 'aa'), ev('t', 'document', 'x', null, { text: 'note' })]
    expect(referencedAttachmentShas(events)).toEqual(['aa', 'bb'])
  })

  it('is empty when no event carries an attachment', () => {
    expect(referencedAttachmentShas([ev('t', 'document', 'x', null, { text: 'note' })])).toEqual([])
  })
})

describe('filterEventsForScope', () => {
  const mood = ev('mood', 'observation', '2026-03-15T09:00:00Z', MOOD) // 'mind' — sensitive
  const cycleStart = ev('cyc', 'observation', '2026-02-01T09:00:00Z', CYCLE_START) // 'cycle' — sensitive
  const bpEarly = ev('bp-early', 'observation', '2026-02-15T09:00:00Z', BP_SYSTOLIC) // 'vital', in-window
  const bp = ev('bp', 'observation', '2026-06-20T09:00:00Z', BP_SYSTOLIC) // 'vital', out of window
  const undatedMed = ev('med', 'medication_statement', null, null, { text: 'aspirin' }) // 'med'
  const all = [mood, cycleStart, bpEarly, bp, undatedMed]

  const open: ShareScope = { fromIso: null, toIso: null, categories: null }

  it('excludes sensitive categories (cycle, mind) by default but includes every other one, undated included', () => {
    expect(new Set(filterEventsForScope(all, open).map((e) => e.event.id))).toEqual(
      new Set(['bp-early', 'bp', 'med']),
    )
  })

  it('applies a date window on top of the sensitive exclusion, and still drops undated events once bounded', () => {
    const scope: ShareScope = { fromIso: '2026-01-01T00:00:00', toIso: '2026-04-01T00:00:00', categories: null }
    const ids = filterEventsForScope(all, scope).map((e) => e.event.id)
    // mood and cycleStart fall in the window but are sensitive, so a null-scope
    // share excludes them anyway; bp is after the window; undated med is excluded.
    expect(ids).toEqual(['bp-early'])
  })

  it('filters by an explicit category list, which is honored verbatim', () => {
    const scope: ShareScope = { fromIso: null, toIso: null, categories: ['med'] }
    expect(filterEventsForScope(all, scope).map((e) => e.event.id)).toEqual(['med'])
  })

  it('an explicit list naming a sensitive category is the opt-in path — it includes it', () => {
    const scope: ShareScope = { fromIso: null, toIso: null, categories: ['cycle'] }
    expect(filterEventsForScope(all, scope).map((e) => e.event.id)).toEqual(['cyc'])
  })

  it('an explicit list that omits cycle still excludes it, like any other unlisted category', () => {
    const scope: ShareScope = { fromIso: null, toIso: null, categories: ['vital', 'med'] }
    const ids = new Set(filterEventsForScope(all, scope).map((e) => e.event.id))
    expect(ids).toEqual(new Set(['bp-early', 'bp', 'med']))
  })

  it('treats an empty category list as every non-sensitive category, not literally every category', () => {
    const scope: ShareScope = { fromIso: null, toIso: null, categories: [] }
    const ids = new Set(filterEventsForScope(all, scope).map((e) => e.event.id))
    expect(ids).toEqual(new Set(['bp-early', 'bp', 'med']))
  })
})

describe('deriveShareCategories', () => {
  it('materializes an explicit list of every non-sensitive category for the default full selection', () => {
    // The sheet opens with all non-sensitive chips selected and no opt-in on.
    const result = deriveShareCategories(set(...NON_SENSITIVE), set())
    expect(result).toEqual(NON_SENSITIVE)
    expect(result).not.toBeNull() // never rides on the null fallback
  })

  it('honors a subset of chips verbatim, in CATEGORIES order regardless of insertion order', () => {
    expect(deriveShareCategories(set('med', 'vital'), set())).toEqual(['vital', 'med'])
  })

  it('adds an opted-in sensitive category to the explicit list, in CATEGORIES order', () => {
    const result = deriveShareCategories(set(...NON_SENSITIVE), set('cycle'))
    expect(result).toContain('cycle')
    // cycle sits before note/clinical/other in CATEGORIES, so order is preserved.
    expect(result).toEqual(CATEGORIES.filter((c) => c !== 'mind'))
  })

  it('returns just the opted-in category when no chips are selected (opt-in only)', () => {
    expect(deriveShareCategories(set(), set('cycle'))).toEqual(['cycle'])
  })

  it('materializes both opt-ins plus the chips when everything is on', () => {
    expect(deriveShareCategories(set(...NON_SENSITIVE), set('cycle', 'mind'))).toEqual(CATEGORIES)
  })

  it('returns null — the empty sentinel — when nothing is selected and nothing is opted in', () => {
    // The sheet uses this to disable creation; it never becomes a share scope.
    expect(deriveShareCategories(set(), set())).toBeNull()
  })
})

describe('shareStatus', () => {
  const base: DoctorShareRecord = {
    token: 't',
    key: 'k',
    scopeDescription: 'All categories; all dates',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  }
  const now = Date.parse('2026-07-05T00:00:00.000Z')

  it('is active before expiry', () => {
    expect(shareStatus(base, now)).toBe('active')
  })

  it('is expired once past expiresAt', () => {
    expect(shareStatus(base, Date.parse('2026-07-09T00:00:00.000Z'))).toBe('expired')
  })

  it('is revoked whenever revokedAt is set, even before expiry', () => {
    expect(shareStatus({ ...base, revokedAt: '2026-07-03T00:00:00.000Z' }, now)).toBe('revoked')
  })
})
