import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get as storeValue } from 'svelte/store'
import { deleteDb, get, put } from '../db'
import {
  dictionaryStatus,
  loadDictionaryIndex,
  invalidateDictionaryCache,
  isEnabled,
  refreshDictionaryStatus,
  downloadDictionary,
  removeDictionary,
  checkForUpdate,
  isNewerVersion,
  manifestBytes,
  DictionaryVerificationError,
  DictionaryFetchError,
  type DictManifest,
} from '../dictionary'

/** Lowercase-hex SHA-256, computed the same way downloadDictionary now checks
 * a fetched file's bytes against the manifest — so these fixtures carry a
 * real digest rather than the placeholder strings the pre-verification tests
 * used. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const LOINC_BODY = { '2345-7': 'Glucose' }
const CVX_BODY = { '08': 'Hep B' }
const ICD_BODY = { A00: 'Cholera' }

function bytesOf(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body))
}

const FILE_BODIES: Record<string, unknown> = {
  '/dict/loinc.json': LOINC_BODY,
  '/dict/icd10cm.json': ICD_BODY,
  '/dict/cvx.json': CVX_BODY,
}

/** Three-file manifest (matches the real dictionary's shape closely enough
 * for these tests: a large file — standing in for the ~8 MB icd10cm.json
 * that motivated this fix — between two small ones, so resume/failure tests
 * can leave real neighbors verified on either side). */
async function buildManifest(version = '2026-07-15'): Promise<DictManifest> {
  return {
    version,
    generated_at: `${version}T00:00:00.000Z`,
    files: [
      {
        system: 'http://loinc.org',
        path: 'loinc.json',
        bytes: bytesOf(LOINC_BODY).length,
        sha256: await sha256Hex(bytesOf(LOINC_BODY)),
        entries: 1,
        label: 'LOINC',
        attribution: 'LOINC notice',
      },
      {
        system: 'http://hl7.org/fhir/sid/icd-10-cm',
        path: 'icd10cm.json',
        bytes: 8_200_000,
        sha256: await sha256Hex(bytesOf(ICD_BODY)),
        entries: 1,
        label: 'ICD-10',
        attribution: 'ICD-10 notice',
      },
      {
        system: 'http://hl7.org/fhir/sid/cvx',
        path: 'cvx.json',
        bytes: bytesOf(CVX_BODY).length,
        sha256: await sha256Hex(bytesOf(CVX_BODY)),
        entries: 1,
        label: 'CVX',
        attribution: 'CVX notice',
      },
    ],
  }
}

let MANIFEST: DictManifest

interface MockOpts {
  /** File path (e.g. 'icd10cm.json') whose fetch rejects with a non-OK response. */
  httpFail?: string
  /** File path whose served bytes are tampered, so the sha256 check fails. */
  corrupt?: string
}

function mockFetch(opts: MockOpts = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/dict/manifest.json') {
        return { ok: true, status: 200, json: async () => MANIFEST } as Response
      }
      const path = url.replace('/dict/', '')
      if (opts.httpFail === path) {
        return { ok: false, status: 500 } as Response
      }
      const bytes =
        opts.corrupt === path
          ? bytesOf({ ...(FILE_BODIES[url] as object), tampered: true })
          : bytesOf(FILE_BODIES[url])
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response
    }),
  )
}

beforeEach(async () => {
  MANIFEST = await buildManifest()
  await deleteDb()
  invalidateDictionaryCache()
  dictionaryStatus.set({
    enabled: false,
    version: null,
    entryCount: 0,
    files: [],
    downloading: false,
    progress: null,
    error: null,
    failedFile: null,
    fileStatuses: [],
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('isNewerVersion', () => {
  it('compares YYYY-MM-DD dates lexicographically', () => {
    expect(isNewerVersion('2026-07-15', '2026-07-14')).toBe(true)
    expect(isNewerVersion('2026-07-15', '2026-07-15')).toBe(false)
    expect(isNewerVersion('2026-06-30', '2026-07-01')).toBe(false)
  })
})

describe('manifestBytes', () => {
  it('sums the per-file byte counts', () => {
    expect(manifestBytes(MANIFEST)).toBe(MANIFEST.files.reduce((n, f) => n + f.bytes, 0))
  })
})

describe('loadDictionaryIndex', () => {
  it('is empty when the feature is disabled', async () => {
    expect(await isEnabled()).toBe(false)
    expect((await loadDictionaryIndex()).size).toBe(0)
  })

  it('hydrates a system|code -> name Map from the stored rows when enabled', async () => {
    await put('prefs', true, 'dict-enabled')
    await put('dictionary', { system: 'http://loinc.org', entriesMap: { '2345-7': 'Glucose' } })
    invalidateDictionaryCache()
    const index = await loadDictionaryIndex()
    expect(index.get('http://loinc.org|2345-7')).toBe('Glucose')
  })

  it('caches: a second call does not re-read after the store changes underneath it', async () => {
    await put('prefs', true, 'dict-enabled')
    await put('dictionary', { system: 'http://loinc.org', entriesMap: { '1': 'one' } })
    invalidateDictionaryCache()
    const first = await loadDictionaryIndex()
    await put('dictionary', { system: 'http://loinc.org', entriesMap: { '1': 'CHANGED' } })
    const second = await loadDictionaryIndex()
    expect(second).toBe(first)
    expect(second.get('http://loinc.org|1')).toBe('one')
  })
})

describe('downloadDictionary / removeDictionary round-trip', () => {
  it('verifies each file against its manifest sha256, stores it, enables the feature, and hydrates the index', async () => {
    mockFetch()
    await downloadDictionary()

    expect(await isEnabled()).toBe(true)
    const index = await loadDictionaryIndex()
    expect(index.get('http://loinc.org|2345-7')).toBe('Glucose')
    expect(index.get('http://hl7.org/fhir/sid/icd-10-cm|A00')).toBe('Cholera')
    expect(index.get('http://hl7.org/fhir/sid/cvx|08')).toBe('Hep B')

    const status = storeValue(dictionaryStatus)
    expect(status.enabled).toBe(true)
    expect(status.version).toBe('2026-07-15')
    expect(status.entryCount).toBe(3)
    expect(status.files.map((f) => f.attribution)).toEqual(['LOINC notice', 'ICD-10 notice', 'CVX notice'])
    expect(status.fileStatuses.map((f) => f.state)).toEqual(['verified', 'verified', 'verified'])
    expect(status.failedFile).toBe(null)
    expect(status.error).toBe(null)
  })

  it('removeDictionary clears the store, the pref, and the cache', async () => {
    mockFetch()
    await downloadDictionary()
    await removeDictionary()

    expect(await isEnabled()).toBe(false)
    expect((await loadDictionaryIndex()).size).toBe(0)
    expect(storeValue(dictionaryStatus).enabled).toBe(false)
  })
})

describe('downloadDictionary: checksum verification', () => {
  it('rejects a file whose bytes do not match the manifest sha256, naming the file', async () => {
    mockFetch({ corrupt: 'icd10cm.json' })

    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryVerificationError)
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(/ICD-10/)

    // Nothing from a failed verification is stored — not even the file that
    // failed, so a later retry re-fetches (rather than trusting bad bytes).
    expect(await get('dictionary', 'http://hl7.org/fhir/sid/icd-10-cm')).toBeUndefined()
    expect(await isEnabled()).toBe(false)
  })

  it('does not parse or store bytes that fail verification even if they happen to be valid JSON, but keeps earlier files that already verified', async () => {
    mockFetch({ corrupt: 'cvx.json' })
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryVerificationError)
    expect(await get('dictionary', 'http://hl7.org/fhir/sid/cvx')).toBeUndefined()
    expect(await get('dictionary', 'http://loinc.org')).toBeDefined()
    expect(await get('dictionary', 'http://hl7.org/fhir/sid/icd-10-cm')).toBeDefined()
  })
})

describe('downloadDictionary: mid-loop failure keeps verified rows', () => {
  it('stores files that succeeded before an HTTP failure, and reports the failed one', async () => {
    mockFetch({ httpFail: 'icd10cm.json' })

    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryFetchError)

    // LOINC (first in the manifest) made it in; the feature isn't enabled
    // yet because the manifest/enabled prefs are only written after every
    // file succeeds.
    expect(await get('dictionary', 'http://loinc.org')).toBeDefined()
    expect(await get('dictionary', 'http://hl7.org/fhir/sid/icd-10-cm')).toBeUndefined()
    expect(await isEnabled()).toBe(false)

    const status = storeValue(dictionaryStatus)
    expect(status.downloading).toBe(false)
    expect(status.failedFile).toEqual({ label: 'ICD-10', bytes: 8_200_000 })
    expect(status.fileStatuses.map((f) => f.state)).toEqual(['verified', 'failed', 'pending'])
    expect(status.error).toMatch(/ICD-10/)
  })

  it('a verification failure (not just an HTTP failure) also keeps earlier verified rows', async () => {
    mockFetch({ corrupt: 'icd10cm.json' })
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryVerificationError)

    expect(await get('dictionary', 'http://loinc.org')).toBeDefined()
    const status = storeValue(dictionaryStatus)
    expect(status.fileStatuses.map((f) => f.state)).toEqual(['verified', 'failed', 'pending'])
  })
})

describe('downloadDictionary: resume', () => {
  it('skips files already stored with this manifest version + sha256, fetching only the rest', async () => {
    mockFetch({ httpFail: 'icd10cm.json' })
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryFetchError)

    mockFetch() // second attempt: icd10cm now succeeds too
    const fetchMock = vi.mocked(fetch)

    await downloadDictionary(MANIFEST)

    // LOINC's fetch was skipped on the retry — only icd10cm and cvx (and the
    // manifest itself isn't re-fetched since we pass MANIFEST directly).
    const fetchedPaths = fetchMock.mock.calls.map(([url]) => url as string)
    expect(fetchedPaths).not.toContain('/dict/loinc.json')
    expect(fetchedPaths).toContain('/dict/icd10cm.json')
    expect(fetchedPaths).toContain('/dict/cvx.json')

    expect(await isEnabled()).toBe(true)
    const index = await loadDictionaryIndex()
    expect(index.get('http://loinc.org|2345-7')).toBe('Glucose')
    expect(index.get('http://hl7.org/fhir/sid/icd-10-cm|A00')).toBe('Cholera')
  })

  it('re-fetches a file whose stored sha256 no longer matches the manifest (e.g. an update)', async () => {
    mockFetch()
    await downloadDictionary(MANIFEST)

    const updated = await buildManifest('2026-08-01')
    updated.files[0] = { ...updated.files[0], sha256: 'deadbeef'.repeat(8) } // force a mismatch
    MANIFEST = updated
    mockFetch()
    // LOINC's fixture bytes still hash to the original digest, so serving it
    // again would fail verification against the forced-mismatch sha256 —
    // confirming the resume check, not the fetch, decided to re-fetch it.
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow(DictionaryVerificationError)
  })
})

describe('downloadDictionary: success clears failure state', () => {
  it('a successful retry after a failure clears error, failedFile, and marks every file verified', async () => {
    mockFetch({ httpFail: 'icd10cm.json' })
    await expect(downloadDictionary(MANIFEST)).rejects.toThrow()
    expect(storeValue(dictionaryStatus).error).not.toBe(null)

    mockFetch()
    await downloadDictionary(MANIFEST)

    const status = storeValue(dictionaryStatus)
    expect(status.error).toBe(null)
    expect(status.failedFile).toBe(null)
    expect(status.enabled).toBe(true)
    expect(status.fileStatuses.every((f) => f.state === 'verified')).toBe(true)
  })
})

describe('checkForUpdate', () => {
  it('reports an update when the stored manifest is older', async () => {
    mockFetch()
    await put('prefs', { ...MANIFEST, version: '2026-07-01' }, 'dict-manifest')
    const check = await checkForUpdate()
    expect(check).toEqual({ current: '2026-07-01', latest: '2026-07-15', updateAvailable: true })
  })

  it('reports an update when nothing is stored yet', async () => {
    mockFetch()
    const check = await checkForUpdate()
    expect(check.updateAvailable).toBe(true)
    expect(check.current).toBe(null)
  })
})

describe('refreshDictionaryStatus', () => {
  it('rebuilds the status store from a stored manifest, with every file verified', async () => {
    await put('prefs', true, 'dict-enabled')
    await put('prefs', MANIFEST, 'dict-manifest')
    await refreshDictionaryStatus()
    const status = storeValue(dictionaryStatus)
    expect(status.enabled).toBe(true)
    expect(status.version).toBe('2026-07-15')
    expect(status.entryCount).toBe(3)
    expect(status.failedFile).toBe(null)
    expect(status.fileStatuses.map((f) => f.state)).toEqual(['verified', 'verified', 'verified'])
  })
})
