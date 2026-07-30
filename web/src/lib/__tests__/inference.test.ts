import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// inference.ts reaches IndexedDB and the unlocked session for the sealed API
// key; these tests cover the pure guards, the reachability probe, and the
// persistence order, so the store is a map and the vault is left **locked** —
// which is the state the save order exists to survive (the seal path runs
// against real wasm in e2e).
const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../db', () => ({
  get: vi.fn(async (_s: string, key: string) => store.get(key)),
  put: vi.fn(async (_s: string, value: unknown, key: string) => {
    store.set(key, value)
  }),
  del: vi.fn(async (_s: string, key: string) => {
    store.delete(key)
  }),
}))
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))

import {
  validateEndpoint,
  normalizeEndpoint,
  endpointHost,
  parseModelIds,
  testConnection,
  probeTarget,
  loadConfig,
  saveInferenceConfig,
  hasConsented,
  recordConsent,
  endpointOrigin,
  chatComplete,
  COMPLETION_TIMEOUT_MS,
  InferenceError,
} from '../inference'

beforeEach(() => store.clear())

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

// What the mode pill and a local turn are labelled with. The label exists
// because "This device" was a lie whenever the endpoint was somewhere else, so
// what matters here is that it names the machine the question actually reaches.
describe('endpointHost', () => {
  it('is the host of the configured endpoint, path and scheme dropped', () => {
    expect(endpointHost('https://llama.home.arpa/v1')).toBe('llama.home.arpa')
    expect(endpointHost('  https://llama.home.arpa/v1/  ')).toBe('llama.home.arpa')
  })

  it('keeps a non-default port, which is part of which service this is', () => {
    expect(endpointHost('https://llama.home.arpa:8443/v1')).toBe('llama.home.arpa:8443')
    expect(endpointHost('http://localhost:11434/v1')).toBe('localhost:11434')
    expect(endpointHost('https://llama.home.arpa:443/v1')).toBe('llama.home.arpa')
  })

  it('truncates a long host from the front, keeping whose machine it is', () => {
    const host = endpointHost('https://a-very-long-machine-name.inference.example.com/v1')
    expect(host.startsWith('…')).toBe(true)
    expect(host.endsWith('inference.example.com')).toBe(true)
    expect(host.length).toBeLessThanOrEqual(29)
  })

  it('truncates a single over-long label too, rather than returning it whole', () => {
    const host = endpointHost(`https://${'x'.repeat(60)}/v1`)
    expect(host.length).toBeLessThanOrEqual(29)
    expect(host.startsWith('…')).toBe(true)
  })

  it('has nothing to say about an unconfigured endpoint', () => {
    expect(endpointHost('')).toBe('')
    expect(endpointHost('   ')).toBe('')
  })

  it('falls back to the raw string rather than showing nothing', () => {
    expect(endpointHost('not a url')).toBe('not a url')
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

  // The probe has to take the same CORS path the real call takes. A bare GET
  // with no headers is a *simple* request — no preflight — while the real call
  // is a JSON POST carrying `authorization`, which preflights. An endpoint that
  // allows the origin but not those headers passed the old test and failed
  // every question, which is the one thing a connection test must not do.
  it('sends the headers the real call sends, so it gets the same preflight', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
    await testConnection('https://x/v1', 'sk-test')
    const { headers } = fetchMock.mock.calls[0][1]
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer sk-test')
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

  it('probes exactly the endpoint it is handed, not a stored one', async () => {
    await saveInferenceConfig('https://saved/v1', 'm')
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
    await testConnection('https://being-edited/v1')
    expect(fetchMock.mock.calls[0][0]).toBe('https://being-edited/v1/models')
  })
})

// What the screen probes. The failure this pins is silent: an owner edits the
// endpoint, presses Test, and is told the *old* one is reachable — a green tick
// for a host they are in the middle of replacing.
describe('probeTarget', () => {
  const saved = { endpoint: 'https://saved/v1', model: 'm', apiKey: 'stored-key' }

  it('tests the form values, never the saved ones', () => {
    const target = probeTarget({ endpoint: 'https://being-edited/v1', apiKey: '' }, saved)
    expect(target.endpoint).toBe('https://being-edited/v1')
  })

  it('uses the key being typed when there is one', () => {
    const target = probeTarget({ endpoint: 'https://x/v1', apiKey: ' typed-key ' }, saved)
    expect(target.apiKey).toBe('typed-key')
  })

  it('falls back to the stored key, which is what the real call would send', () => {
    expect(probeTarget({ endpoint: 'https://x/v1', apiKey: '   ' }, saved).apiKey).toBe(
      'stored-key',
    )
    expect(probeTarget({ endpoint: 'https://x/v1', apiKey: '' }, null).apiKey).toBeUndefined()
  })
})

// The consent sheet's three promises are all about a specific recipient: *this*
// endpoint receives your record decrypted, your key is stored for it, the relay
// never sees it. A yes to one host is therefore not a yes to the next one.
describe('consent', () => {
  it('binds to the endpoint origin, so a different host asks again', async () => {
    await recordConsent('https://one.example/v1')
    expect(await hasConsented('https://one.example/v1')).toBe(true)
    // A different path or a trailing slash on the same host is the same
    // recipient — nothing to ask about.
    expect(await hasConsented('https://one.example/v2/')).toBe(true)
    // A different host is a different recipient, and has never been agreed to.
    expect(await hasConsented('https://two.example/v1')).toBe(false)
    // As is the same name over a different scheme or port.
    expect(await hasConsented('http://one.example/v1')).toBe(false)
    expect(await hasConsented('https://one.example:8443/v1')).toBe(false)
  })

  it('is not given at all until it is recorded', async () => {
    expect(await hasConsented('https://one.example/v1')).toBe(false)
  })

  it('reads a consent from before origins as consent for what was configured then', async () => {
    // The legacy record is a bare ISO timestamp. It was given while a specific
    // endpoint was saved, so it counts for that one — and carrying it onto a
    // host the owner never saw is the thing to avoid.
    await saveInferenceConfig('https://legacy.example/v1', 'm')
    store.set('inferenceConsentAt', '2026-01-01T00:00:00.000Z')
    expect(await hasConsented('https://legacy.example/v1')).toBe(true)
    expect(await hasConsented('https://elsewhere.example/v1')).toBe(false)
  })

  it('reads an origin off an endpoint, and nothing off junk', () => {
    expect(endpointOrigin('  https://h:8443/v1/ ')).toBe('https://h:8443')
    expect(endpointOrigin('not a url')).toBe('')
  })
})

describe('saveInferenceConfig', () => {
  // The vault is locked in these tests (`session.vaultKey` is null), which is
  // exactly the state that used to leave a half-saved config: the endpoint and
  // model were written first, the key seal then threw, and the app was left
  // configured with no credential — every later request 401ing.
  it('writes nothing when the key cannot be sealed', async () => {
    await expect(saveInferenceConfig('https://x/v1', 'm', 'sk-test')).rejects.toThrow(/unlock/i)
    expect(await loadConfig()).toBeNull()
  })

  it('leaves a previous configuration intact when a re-save cannot seal', async () => {
    await saveInferenceConfig('https://old/v1', 'old-model')
    await expect(saveInferenceConfig('https://new/v1', 'new-model', 'sk-test')).rejects.toThrow()
    const config = await loadConfig()
    expect(config?.endpoint).toBe('https://old/v1')
    expect(config?.model).toBe('old-model')
  })

  it('saves endpoint and model when no key is being set', async () => {
    await saveInferenceConfig('https://x/v1/', ' m ')
    const config = await loadConfig()
    expect(config?.endpoint).toBe('https://x/v1')
    expect(config?.model).toBe('m')
  })
})

describe('chatComplete', () => {
  const fetchMock = vi.fn()
  const config = { endpoint: 'https://llama.home.arpa/v1', model: 'm' }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** A request that never answers on its own, and rejects the way a browser's
   * fetch does when its signal is aborted. */
  function hangs(): void {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('The user aborted a request.', 'AbortError')),
          )
        }),
    )
  }

  // The defect this guards: with no signal, a hung endpoint left the ask screen
  // disabled for as long as the socket stayed open, with nothing to explain it.
  it('gives up on a hung endpoint after the deadline and says so', async () => {
    vi.useFakeTimers()
    hangs()

    const answer = chatComplete(config, 'SYSTEM', 'USER')
    const failure = expect(answer).rejects.toThrow(InferenceError)
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS)

    await failure
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('names the host and the limit in the timeout message', async () => {
    vi.useFakeTimers()
    hangs()

    const answer = chatComplete(config, 'SYSTEM', 'USER')
    const failure = expect(answer).rejects.toThrow(/llama\.home\.arpa .*30 seconds/)
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS)
    await failure
  })

  it('does not abort a request that is merely slow', async () => {
    vi.useFakeTimers()
    hangs()

    const answer = chatComplete(config, 'SYSTEM', 'USER')
    const failure = expect(answer).rejects.toThrow(InferenceError)
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS - 1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await failure
  })

  // A cleared deadline matters beyond tidiness: it is the same controller the
  // response body is read through, so a stray one would abort a live read.
  it('clears the deadline once an answer arrives', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    })

    await expect(chatComplete(config, 'SYSTEM', 'USER')).resolves.toBe('hello')
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS * 2)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
  })

  // Headers can arrive promptly and the stream then stall; from the owner's
  // side that is the same hang, so it must land on the same message.
  it('applies the deadline to a stalled body, not just the request', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 60_000)
        }),
    })

    const answer = chatComplete(config, 'SYSTEM', 'USER')
    const failure = expect(answer).rejects.toThrow(/30 seconds/)
    await vi.advanceTimersByTimeAsync(60_000)
    await failure
  })

  it('still reports an unreachable endpoint as unreachable, not as a timeout', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(chatComplete(config, 'SYSTEM', 'USER')).rejects.toThrow(/CORS/)
  })
})
