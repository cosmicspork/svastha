import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// inference.ts reaches IndexedDB and the unlocked session for the sealed API
// key; these tests cover the pure guards and the reachability probe, so both are
// stubbed rather than stood up (the seal path runs against real wasm in e2e).
vi.mock('../db', () => ({
  get: vi.fn(async () => undefined),
  put: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
}))
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))

import {
  validateEndpoint,
  normalizeEndpoint,
  parseModelIds,
  testConnection,
  InferenceError,
} from '../inference'

describe('validateEndpoint', () => {
  it('accepts an https endpoint', () => {
    expect(validateEndpoint('https://inference.example/v1')).toBeNull()
  })

  it('rejects an empty or malformed URL', () => {
    expect(validateEndpoint('  ')).toMatch(/enter an endpoint/i)
    expect(validateEndpoint('not a url')).toMatch(/not a valid URL/i)
    expect(validateEndpoint('ftp://example/v1')).toMatch(/http\(s\)/i)
  })

  // The case that actually bites: a model on a desktop, reached from a phone.
  // The PWA is https, so the browser blocks it as mixed content before the
  // request leaves — better to say why than to surface a bare network error.
  it('rejects a plain-http LAN endpoint and explains the certificate requirement', () => {
    const problem = validateEndpoint('http://192.168.1.50:11434/v1')
    expect(problem).toMatch(/https/i)
    expect(problem).toMatch(/certificate/i)
  })

  it('still allows loopback, which is exempt from mixed-content blocking', () => {
    expect(validateEndpoint('http://localhost:11434/v1')).toBeNull()
    expect(validateEndpoint('http://127.0.0.1:11434/v1')).toBeNull()
  })

  // Mirrors validate_inference_endpoint in crates/node/src/config.rs: batch
  // services retain inputs and outputs server-side.
  it('rejects a batch path', () => {
    expect(validateEndpoint('https://api.example/v1/batches')).toMatch(/batch/i)
    expect(validateEndpoint('https://api.example/v1/batch')).toMatch(/batch/i)
  })
})

describe('normalizeEndpoint', () => {
  it('strips trailing slashes so paths never double up', () => {
    expect(normalizeEndpoint('  https://x/v1///  ')).toBe('https://x/v1')
  })
})

describe('parseModelIds', () => {
  it('reads ids out of an OpenAI-compatible body', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
  })

  it('tolerates junk without throwing', () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ data: 'nope' })).toEqual([])
    expect(parseModelIds({ data: [{ id: 1 }, {}, { id: 'ok' }] })).toEqual(['ok'])
  })
})

describe('testConnection', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('probes /models and returns the ids', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'qwen' }] }),
    })
    await expect(testConnection('https://x/v1/', 'sk-test')).resolves.toEqual(['qwen'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x/v1/models')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
  })

  it('sends no Authorization header when there is no key', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
    await testConnection('https://x/v1')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  // A CORS rejection is indistinguishable from an offline host in JS, so the
  // message must name CORS rather than blaming the connection.
  it('names CORS when the request cannot be made at all', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(testConnection('https://x/v1')).rejects.toThrow(InferenceError)
    await expect(testConnection('https://x/v1')).rejects.toThrow(/CORS/)
  })

  it('reports a rejected key distinctly from other failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    await expect(testConnection('https://x/v1', 'bad')).rejects.toThrow(/API key/i)

    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(testConnection('https://x/v1')).rejects.toThrow(/500/)
  })
})
