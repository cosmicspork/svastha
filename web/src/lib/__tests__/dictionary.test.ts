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
  type DictManifest,
} from '../dictionary'

const MANIFEST: DictManifest = {
  version: '2026-07-15',
  generated_at: '2026-07-15T00:00:00.000Z',
  files: [
    { system: 'http://loinc.org', path: 'loinc.json', bytes: 20, sha256: 'x', entries: 1, label: 'LOINC', attribution: 'LOINC notice' },
    { system: 'http://hl7.org/fhir/sid/cvx', path: 'cvx.json', bytes: 30, sha256: 'y', entries: 1, label: 'CVX', attribution: 'CVX notice' },
  ],
}

const FILE_BODIES: Record<string, unknown> = {
  '/dict/manifest.json': MANIFEST,
  '/dict/loinc.json': { '2345-7': 'Glucose' },
  '/dict/cvx.json': { '08': 'Hep B' },
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => FILE_BODIES[url],
    })),
  )
}

beforeEach(async () => {
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
    expect(manifestBytes(MANIFEST)).toBe(50)
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
  it('stores every file, enables the feature, and hydrates the index', async () => {
    mockFetch()
    await downloadDictionary()

    expect(await isEnabled()).toBe(true)
    const index = await loadDictionaryIndex()
    expect(index.get('http://loinc.org|2345-7')).toBe('Glucose')
    expect(index.get('http://hl7.org/fhir/sid/cvx|08')).toBe('Hep B')

    const status = storeValue(dictionaryStatus)
    expect(status.enabled).toBe(true)
    expect(status.version).toBe('2026-07-15')
    expect(status.entryCount).toBe(2)
    expect(status.files.map((f) => f.attribution)).toEqual(['LOINC notice', 'CVX notice'])
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
  it('rebuilds the status store from a stored manifest', async () => {
    await put('prefs', true, 'dict-enabled')
    await put('prefs', MANIFEST, 'dict-manifest')
    await refreshDictionaryStatus()
    const status = storeValue(dictionaryStatus)
    expect(status.enabled).toBe(true)
    expect(status.version).toBe('2026-07-15')
    expect(status.entryCount).toBe(2)
  })
})
