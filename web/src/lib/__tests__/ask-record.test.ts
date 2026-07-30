import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// What reaches the transcript when a local answer succeeds, and — the reason
// this file exists — what does *not* reach it when one fails.
//
// The retrieval half is stubbed (wasm and the vault reads), but the recording
// half is real: real chat.ts against real db.ts on fake-indexeddb, because the
// defect being fixed is a row that outlives the failure, and a stubbed store
// cannot show that.
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
  value: { endpoint: 'https://llama.home.arpa/v1', model: 'm' } as null | {
    endpoint: string
    model: string
  },
}))
// The session rune is unloadable under node vitest; only the sealed-key path
// touches it, and this file never goes near it.
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))
vi.mock('../inference', async () => {
  const actual = await vi.importActual<typeof import('../inference')>('../inference')
  return { ...actual, loadConfig: vi.fn(async () => config.value) }
})

vi.mock('../events', () => ({ allEvents: vi.fn(async () => []) }))
vi.mock('../curation', () => ({
  allStatuses: vi.fn(async () => new Map()),
  allNames: vi.fn(async () => new Map()),
}))
vi.mock('../dictionary', () => ({ loadDictionaryIndex: vi.fn(async () => new Map()) }))
vi.mock('../summary', () => ({ conceptKey: vi.fn(() => 'k') }))
vi.mock('../answerScope', async () => {
  const actual = await vi.importActual<typeof import('../answerScope')>('../answerScope')
  return { ...actual, loadOptIns: vi.fn(async () => new Set<string>()) }
})

import { askAndRecord } from '../ask'
import { InferenceError } from '../inference'
import {
  chatTurns,
  conversationState,
  listChatTurns,
  refreshChat,
  sortChronological,
  type ChatTurn,
} from '../chat'
import { deleteDb } from '../db'

const fetchMock = vi.fn()
const LINE = '{"event_id":"aaa","text":"line","score":1}'

beforeEach(async () => {
  await deleteDb()
  chatTurns.set([])
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  wasm.rank_context.mockReturnValue(`{"items":[${LINE}],"unreadable":0}`)
  wasm.ground_answer.mockReset()
  config.value = { endpoint: 'https://llama.home.arpa/v1', model: 'm' }
})
afterEach(() => vi.unstubAllGlobals())

function reply(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => {
      // A real millisecond passes between a question and its answer, as it does
      // against a real endpoint. `createdAt` ties break by uuid, which is not an
      // order — an instant reply would make the transcript's order a coin toss.
      await new Promise((resolve) => setTimeout(resolve, 2))
      return { choices: [{ message: { content } }] }
    },
  }
}

/** The stored transcript in the order it reads (the store is keyed by id, which
 * for local turns is a uuid — insertion order is not retrieval order). */
async function transcript(): Promise<ChatTurn[]> {
  return sortChronological(await listChatTurns())
}

describe('askAndRecord', () => {
  it('records the question and the answer it got', async () => {
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))

    await askAndRecord('what do i take')

    const turns = await transcript()
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'what do i take'],
      ['node', 'You take X.'],
    ])
    expect(turns.every((t) => t.id.startsWith('local-'))).toBe(true)
    expect(conversationState(turns)).toBe('answered')
  })
  it('keeps the answering endpoint with a local answer after settings change', async () => {
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))

    await askAndRecord('what do i take')
    config.value = { endpoint: 'https://new-model.home.arpa/v1', model: 'm' }

    const answer = (await listChatTurns()).find((turn) => turn.role === 'node')!
    expect(answer.sourceHost).toBe('llama.home.arpa')
  })

  it('keeps the caveat with the answer it qualifies', async () => {
    wasm.rank_context.mockReturnValue(`{"items":[${LINE}],"unreadable":2}`)
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))

    await askAndRecord('what do i take')

    const answer = (await listChatTurns()).find((t) => t.role === 'node')!
    expect(answer.text).toMatch(/^You take X\./)
    expect(answer.text).toMatch(/2 records on this device couldn't be read/)
  })

  // The defect: the question was written before the model was called and left
  // there when the call failed. `conversationState` reads a trailing `user` turn
  // as `waiting`, so every later mount showed "Reading your record…" for an
  // answer that was never coming — and the error explaining it was long gone.
  it('leaves no unanswered question behind when the endpoint fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(askAndRecord('what do i take')).rejects.toThrow(InferenceError)

    expect(await listChatTurns()).toEqual([])
    // What the next mount would find: an empty screen, not a pending one.
    await refreshChat()
    expect(conversationState(await listChatTurns())).toBe('empty')
  })

  it('leaves earlier turns alone when a later question fails', async () => {
    wasm.ground_answer.mockReturnValue('{"answer":"You take X.","citations":["aaa"]}')
    fetchMock.mockResolvedValue(reply('{"answer":"You take X.","used":[1]}'))
    await askAndRecord('what do i take')

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(askAndRecord('and what else')).rejects.toThrow(InferenceError)

    const turns = await transcript()
    expect(turns.map((t) => t.text)).toEqual(['what do i take', 'You take X.'])
    expect(conversationState(turns)).toBe('answered')
  })

  // A question the record cannot answer is not a failure: it is an honest turn,
  // and it stays.
  it('records an unanswerable question as a normal exchange', async () => {
    wasm.rank_context.mockReturnValue('{"items":[],"unreadable":0}')

    await askAndRecord('when was my last MRI')

    const turns = await listChatTurns()
    expect(turns.map((t) => t.role).sort()).toEqual(['node', 'user'])
    expect(turns.find((t) => t.role === 'node')!.text).toMatch(/couldn't find/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rethrows what failed, so the caller can say why', async () => {
    config.value = null
    await expect(askAndRecord('q')).rejects.toThrow(/no inference endpoint/i)
    expect(await listChatTurns()).toEqual([])
  })
})
