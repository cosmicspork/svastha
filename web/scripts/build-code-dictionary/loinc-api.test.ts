import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOINC_API_BASE,
  downloadLoincRelease,
  extractLoincCsv,
  fetchLoincMeta,
  loincBasicAuth,
  type LoincApiMeta,
} from './loinc-api.ts'

// These mock the LOINC Download API's HTTP surface (metadata + zip download)
// rather than hitting the real, credential-gated service — see build.ts's
// header comment for why a real call isn't made from an automated build.
//
// Colocated here (rather than under src/lib/__tests__, like the other
// build-code-dictionary tests) because loinc-api.ts uses node:crypto/Buffer:
// tsconfig.app.json's program (which is what checks anything under src/**,
// transitively) deliberately omits Node's ambient types to keep browser code
// honest about not reaching for Node APIs, so importing this module from a
// src/ test would fail typechecking. tsconfig.scripts.json covers this
// directory instead. Vitest still discovers this file by its default glob.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loincBasicAuth', () => {
  it('base64-encodes "user:pass" with the Basic prefix', () => {
    expect(loincBasicAuth('alice', 'secret')).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`)
  })
})

const META: LoincApiMeta = {
  version: '2.80',
  releaseDate: '2026-06-15',
  numberOfLoincs: 259000,
  downloadUrl: 'https://loinc.regenstrief.org/api/v1/Loinc/Download',
  downloadMD5Hash: '',
}

describe('fetchLoincMeta', () => {
  it('GETs /Loinc with the auth header and returns the parsed metadata', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${LOINC_API_BASE}/Loinc`)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Basic xyz')
      return { ok: true, json: async () => META } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLoincMeta('Basic xyz')).toEqual(META)
  })

  it('appends ?version= when a specific release is requested', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(`${LOINC_API_BASE}/Loinc?version=2.79`)
      return { ok: true, json: async () => META } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await fetchLoincMeta('Basic xyz', '2.79')
  })

  it('throws on a non-2xx response (404 for an unknown version, etc.)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    )
    await expect(fetchLoincMeta('Basic xyz')).rejects.toThrow(/404/)
  })
})

describe('downloadLoincRelease', () => {
  it('returns the bytes when they match the reported MD5', async () => {
    const bytes = strToU8('pretend-zip-bytes')
    const md5 = createHash('md5').update(bytes).digest('hex')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }) as Response),
    )
    const result = await downloadLoincRelease({ ...META, downloadMD5Hash: md5 }, 'Basic xyz')
    expect(result).toEqual(bytes)
  })

  it('throws when the downloaded bytes fail MD5 verification', async () => {
    const bytes = strToU8('pretend-zip-bytes')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }) as Response),
    )
    await expect(downloadLoincRelease({ ...META, downloadMD5Hash: 'deadbeef' }, 'Basic xyz')).rejects.toThrow(
      /MD5/,
    )
  })

  it('throws on a failed HTTP fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 }) as Response),
    )
    await expect(downloadLoincRelease(META, 'Basic xyz')).rejects.toThrow(/503/)
  })
})

describe('extractLoincCsv', () => {
  it('finds and decodes LoincTable/Loinc.csv from the release zip', () => {
    const csv = 'LOINC_NUM,LONG_COMMON_NAME,COMMON_TEST_RANK\n2345-7,Glucose,1\n'
    const zip = zipSync({ 'LoincTable/Loinc.csv': strToU8(csv), 'LoincTable/Readme.txt': strToU8('notes') })
    expect(extractLoincCsv(zip)).toBe(csv)
  })

  it('throws with the zip contents listed when Loinc.csv is missing', () => {
    const zip = zipSync({ 'LoincTable/Other.csv': strToU8('x') })
    expect(() => extractLoincCsv(zip)).toThrow(/Loinc\.csv/)
  })
})
