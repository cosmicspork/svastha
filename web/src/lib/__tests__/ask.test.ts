import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ask.ts orchestrates wasm + IndexedDB + fetch. These tests cover the parts that
// decide what leaves the device and what reaches the transcript, so wasm and the
// stores are stubbed; the real ranker/grounder run in the Rust unit tests and
// e2e.
// `vi.mock` factories are hoisted above module-scope consts, so the stubs have
// to be created inside `vi.hoisted` to be referenceable from them.
const wasm = vi.hoisted(() => ({
  rank_context: vi.fn(),
  build_context_prompt: vi.fn(() => 'PROMPT'),
  ground_answer: vi.fn(),
  system_prompt: vi.fn(() => 'SYSTEM'),
  cant_answer_text: vi.fn(() => "I couldn't find anything in your record to answer that."),
  initSvastha: vi.fn(async () => {}),
}))
vi.mock('../svastha', () => wasm)

const config = vi.hoisted(() => ({
  value: null as null | { endpoint: string; model: string; apiKey?: string },
}))
// `importActual('../inference')` evaluates the real module, which reaches
// IndexedDB and the session rune — stub both so it loads under node vitest.
vi.mock('../db', () => ({
  get: vi.fn(async () => undefined),
  put: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
}))
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))

vi.mock('../inference', async () => {
  const actual = await vi.importActual<typeof import('../inference')>('../inference')
  return {
    ...actual,
    loadConfig: vi.fn(async () => config.value),
  }
})

vi.mock('../events', () => ({ allEvents: vi.fn(async () => []) }))
vi.mock('../curation', () => ({
  allStatuses: vi.fn(async () => new Map()),
  allNames: vi.fn(async () => new Map()),
}))
vi.mock('../code-names', () => ({
  buildCodeNameIndex: vi.fn(() => new Map()),
  resolveDisplay: vi.fn(() => null),
}))
vi.mock('../dictionary', () => ({ loadDictionaryIndex: vi.fn(async () => new Map()) }))
vi.mock('../summary', () => ({ conceptKey: vi.fn(() => 'k') }))

import {
  askLocally,
  canAnswerLocally,
  buildCandidates,
  resolveName,
  unreadableCaveat,
  MAX_CONTEXT,
} from '../ask'
import { InferenceError } from '../inference'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  wasm.rank_context.mockReset()
  wasm.ground_answer.mockReset()
  config.value = { endpoint: 'https://x/v1', model: 'm', apiKey: 'sk' }
})
afterEach(() => vi.unstubAllGlobals())

function reply(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

/** `rank_context`'s return shape: the items to send, plus how many candidates
 * this build could not decode at all. */
function ranked(items: string[], unreadable = 0): string {
  return `{"items":[${items.join(',')}],"unreadable":${unreadable}}`
}
const LINE = '{"event_id":"aaa","text":"line","score":1}'

describe('canAnswerLocally', () => {
  it('needs both an endpoint and a model', async () => {
    expect(await canAnswerLocally()).toBe(true)
    config.value = { endpoint: 'https://x/v1', model: '' }
    expect(await canAnswerLocally()).toBe(false)
    config.value = null
    expect(await canAnswerLocally()).toBe(false)
  })
})

describe('askLocally', () => {
  // The central privacy property: nothing is sent when retrieval found nothing,
  // so an unanswerable question costs no disclosure at all.
  it('answers honestly without calling the endpoint when nothing retrieves', async () => {
    wasm.rank_context.mockReturnValue(ranked([]))
    const answer = await askLocally('unrelated question')
    expect(answer.citations).toEqual([])
    expect(answer.text).toMatch(/couldn't find/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only the ranked context and returns grounded citations', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE]))
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))

    const answer = await askLocally('what do i take')
    expect(answer).toEqual({ text: 'You take X.', citations: ['aaa'] })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer sk')
    const body = JSON.parse(init.body)
    expect(body.temperature).toBe(0)
    expect(body.messages[1].content).toBe('PROMPT')
    // The prompt is built from the ranked items only — the vault never crosses.
    expect(wasm.build_context_prompt).toHaveBeenCalledWith(
      'what do i take',
      '[{"event_id":"aaa","text":"line","score":1}]',
    )
  })

  it('caps the context at MAX_CONTEXT items', async () => {
    wasm.rank_context.mockReturnValue(ranked([]))
    await askLocally('q')
    expect(wasm.rank_context.mock.calls[0][2]).toBe(MAX_CONTEXT)
  })

  // Uncited prose is never shown, however fluent the model was.
  it('replaces an answer that grounds to no citations with the honest refusal', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE]))
    wasm.ground_answer.mockReturnValue('{"answer":"Sounds fine.","citations":[]}')
    fetchMock.mockResolvedValue(reply('{"answer":"Sounds fine.","used":[]}'))

    const answer = await askLocally('q')
    expect(answer.citations).toEqual([])
    expect(answer.text).toMatch(/couldn't find/i)
  })

  it('does the same when the reply will not parse at all', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE]))
    wasm.ground_answer.mockReturnValue('null')
    fetchMock.mockResolvedValue(reply('I cannot read this'))
    expect((await askLocally('q')).text).toMatch(/couldn't find/i)
  })

  it('raises a usable message when the endpoint is unusable', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE]))
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(askLocally('q')).rejects.toThrow(InferenceError)

    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    await expect(askLocally('q')).rejects.toThrow(/API key/i)
  })

  it('refuses when no endpoint is configured', async () => {
    config.value = null
    await expect(askLocally('q')).rejects.toThrow(/no inference endpoint/i)
  })
})

// Events this build cannot decode are dropped from retrieval (contract skew —
// see rank_context). Dropping them silently would let the app present an answer
// drawn from a partial record, or a flat "nothing found", as though the record
// were whole. Every path that returns an answer has to carry the caveat.
describe('records this build could not read', () => {
  it('caveats an answer that was drawn from a partial record', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE], 2))
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))

    const answer = await askLocally('what do i take')
    expect(answer.text).toBe('You take X.')
    expect(answer.caveat).toBe(unreadableCaveat(2))
  })

  // The worst case: the unreadable records were the only ones that could have
  // answered, so an uncaveated refusal is a confident, wrong "you have none".
  it('does not present a no-match as complete', async () => {
    wasm.rank_context.mockReturnValue(ranked([], 1))
    const answer = await askLocally('what am i allergic to')
    expect(answer.text).toMatch(/couldn't find/i)
    expect(answer.caveat).toBe(unreadableCaveat(1))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries the caveat onto an answer that grounds to nothing', async () => {
    wasm.rank_context.mockReturnValue(ranked([LINE], 1))
    wasm.ground_answer.mockReturnValue('{"answer":"Sounds fine.","citations":[]}')
    fetchMock.mockResolvedValue(reply('{"answer":"Sounds fine.","used":[]}'))
    expect((await askLocally('q')).caveat).toBe(unreadableCaveat(1))
  })

  it('says nothing extra when the whole record decoded', async () => {
    wasm.rank_context.mockReturnValue(ranked([]))
    expect((await askLocally('q')).caveat).toBeUndefined()
  })

  it('names the count and what to do about it', () => {
    expect(unreadableCaveat(1)).toMatch(/^1 record on this device/)
    expect(unreadableCaveat(3)).toMatch(/^3 records on this device/)
    expect(unreadableCaveat(1)).toMatch(/update/i)
  })
})

describe('candidate assembly', () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({ id: 'e1', kind: 'medication_statement', code: null, value: null, ...over }) as never

  it('defaults an uncurated concept to active', () => {
    const [c] = buildCandidates([{ event: event() } as never], new Map(), new Map(), new Map(), new Map())
    expect(c.status).toBe('active')
  })

  it('honours the owner status override', () => {
    const [c] = buildCandidates(
      [{ event: event() } as never],
      new Map([['k', 'inactive' as const]]),
      new Map(),
      new Map(),
      new Map(),
    )
    expect(c.status).toBe('inactive')
  })

  // The owner's own name wins over every resolution layer beneath it.
  it('prefers the name: override, then the code display', () => {
    const coded = event({ code: { system: 'http://loinc.org', code: '1', display: 'BMI' } })
    expect(resolveName(coded, 'k', new Map([['k', 'My name']]), new Map(), new Map())).toBe('My name')
    expect(resolveName(coded, 'k', new Map(), new Map(), new Map())).toBe('BMI')
  })

  it('falls back to free text, then the bare kind', () => {
    expect(resolveName(event({ value: { text: 'ibuprofen' } }), 'k', new Map(), new Map(), new Map())).toBe(
      'ibuprofen',
    )
    expect(resolveName(event(), 'k', new Map(), new Map(), new Map())).toBe('medication_statement')
  })
})
