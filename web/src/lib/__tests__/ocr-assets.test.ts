import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const prefs = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../db', () => ({
  get: vi.fn(async (_store: string, key: string) => prefs.get(key)),
  put: vi.fn(async (_store: string, value: unknown, key: string) => {
    prefs.set(key, value)
  }),
}))

import {
  verifyAssets,
  enableAssets,
  disableAssets,
  pageReadingEnabled,
  assetsEnabled,
  verifiedRevision,
  downloadBytes,
  OcrVerificationError,
  OcrFetchError,
  ASSET_BASE,
  type OcrManifest,
} from '../ocr-assets'
import { wordsFromResult } from '../ocr-engine'

const enc = new TextEncoder()

/** Lowercase-hex SHA-256 over a string, via Web Crypto — this suite has no Node
 * types available (see tsconfig.scripts.json for the ones that do). */
async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const SHA = {
  abcd: await sha('abcd'),
  ef: await sha('ef'),
  xyz: await sha('xyz'),
}

const manifest: OcrManifest = {
  version: '7.0.0',
  revision: 'rev-1',
  generated_at: '2026-07-28T00:00:00.000Z',
  traineddata_source: 'https://example/eng.traineddata',
  files: [
    { path: 'worker.min.js', bytes: 4, sha256: SHA.abcd, label: 'Worker', role: 'worker' },
    { path: 'eng.traineddata', bytes: 2, sha256: SHA.ef, label: 'Language data', role: 'lang' },
    { path: 'LICENCE.txt', bytes: 3, sha256: SHA.xyz, label: 'Licence', role: 'notice' },
  ],
}

function bodyFor(url: string): string {
  if (url.endsWith('worker.min.js')) return 'abcd'
  if (url.endsWith('eng.traineddata')) return 'ef'
  return 'xyz'
}

const fetchMock = vi.fn()

beforeEach(() => {
  prefs.clear()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => manifest,
    arrayBuffer: async () => enc.encode(bodyFor(url)),
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('verifyAssets', () => {
  it('verifies every runtime file against its checksum', async () => {
    await expect(verifyAssets(manifest)).resolves.toBeUndefined()
    const asked = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(asked).toEqual([`${ASSET_BASE}/worker.min.js`, `${ASSET_BASE}/eng.traineddata`])
  })

  // Every asset is same-origin by construction; the library's own defaults point
  // at a CDN, so this is the regression that matters most here.
  it('never requests anything off this origin', async () => {
    await verifyAssets(manifest)
    for (const [url] of fetchMock.mock.calls) {
      expect(url as string).toMatch(/^\/ocr\//)
    }
  })

  it('skips licence texts, which are attribution rather than runtime', async () => {
    await verifyAssets(manifest)
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(`${ASSET_BASE}/LICENCE.txt`)
    expect(downloadBytes(manifest)).toBe(6)
  })

  it('reports progress as completed bytes', async () => {
    const seen: number[] = []
    await verifyAssets(manifest, (done, total) => seen.push(done / total))
    expect(seen).toEqual([4 / 6, 1])
  })

  it('rejects bytes that do not match the checksum', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => enc.encode('tampered'),
    }))
    await expect(verifyAssets(manifest)).rejects.toBeInstanceOf(OcrVerificationError)
  })

  it('surfaces a failed download as its own error', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404 }))
    await expect(verifyAssets(manifest)).rejects.toBeInstanceOf(OcrFetchError)
  })
})

describe('page reading preference', () => {
  it('defaults on without downloading reader assets on a fresh device', async () => {
    expect(await pageReadingEnabled()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an explicit opt-out without checking or downloading assets', async () => {
    await disableAssets()

    expect(await pageReadingEnabled()).toBe(false)
    expect(await assetsEnabled()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('enableAssets', () => {
  it('is off until every file has verified', async () => {
    expect(await assetsEnabled()).toBe(false)
    await enableAssets()
    expect(await assetsEnabled()).toBe(true)
  })

  // A half-verified reader must not be usable.
  it('stays off when a file fails to verify', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => manifest,
      arrayBuffer: async () =>
        enc.encode(url.endsWith('eng.traineddata') ? 'wrong' : bodyFor(url)),
    }))
    await expect(enableAssets()).rejects.toBeInstanceOf(OcrVerificationError)
    expect(await assetsEnabled()).toBe(false)
  })

  it('can be switched back off', async () => {
    await enableAssets()
    await disableAssets()
    expect(await assetsEnabled()).toBe(false)
  })
})

describe('assetsEnabled revision enforcement', () => {
  // A device that verified an older asset set (e.g. before this PR shipped a
  // different core file layout under the same tesseract.js version) must not
  // read as ready — it would execute whatever's now served at those same
  // URLs without ever checking it against the new manifest's hashes.
  it('goes stale — and reports not-enabled — once the shipped revision differs from what this device verified', async () => {
    await enableAssets()
    expect(await assetsEnabled()).toBe(true)

    const bumped = { ...manifest, revision: 'rev-2' }
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => bumped,
      arrayBuffer: async () => enc.encode(bodyFor(url)),
    }))

    expect(await assetsEnabled()).toBe(false)
  })

  it('re-enables once the device re-verifies against the new revision', async () => {
    await enableAssets()
    const bumped = { ...manifest, revision: 'rev-2' }
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => bumped,
      arrayBuffer: async () => enc.encode(bodyFor(url)),
    }))
    expect(await assetsEnabled()).toBe(false)

    await enableAssets()
    expect(await assetsEnabled()).toBe(true)
    expect(await verifiedRevision()).toBe('rev-2')
  })

  // A device that cannot confirm what's currently shipped has nothing to
  // trust — fail closed rather than running on the last-verified assets.
  it('reports not-enabled, rather than throwing, when the current manifest cannot be reached', async () => {
    await enableAssets()
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503 }))
    await expect(assetsEnabled()).resolves.toBe(false)
  })

  it('records a revision distinct from the tesseract.js package version', async () => {
    await enableAssets()
    expect(await verifiedRevision()).toBe(manifest.revision)
    expect(await verifiedRevision()).not.toBe(manifest.version)
  })
})

describe('wordsFromResult', () => {
  const word = (text: string, x0: number) => ({
    text,
    confidence: 90,
    bbox: { x0, y0: 10, x1: x0 + 20, y1: 22 },
  })

  it('reads the flat words array', () => {
    const out = wordsFromResult({ words: [word('Potassium', 0)] })
    expect(out).toEqual([{ text: 'Potassium', x0: 0, x1: 20, y0: 10, y1: 22, conf: 0.9 }])
  })

  // tesseract.js has moved words between a flat array and a nested tree across
  // majors; returning nothing on an upgrade would read as "the page is blank".
  it('also reads the nested blocks tree', () => {
    const nested = {
      blocks: [{ paragraphs: [{ lines: [{ words: [word('Sodium', 5)] }] }] }],
    }
    expect(wordsFromResult(nested).map((w) => w.text)).toEqual(['Sodium'])
  })

  it('drops malformed words rather than inventing boxes', () => {
    expect(wordsFromResult({ words: [{ text: 'no bbox' }, word('ok', 0)] })).toHaveLength(1)
    expect(wordsFromResult(null)).toEqual([])
    expect(wordsFromResult({})).toEqual([])
  })
})
