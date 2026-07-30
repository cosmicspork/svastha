// Where a question goes, and the one asymmetry in it.
//
// The pure rule is tested directly rather than only through `canAnswerLocally`,
// because a regression here misroutes a question — and the direction that
// matters is a question going to the node an owner told the app not to use.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../db', () => ({
  get: vi.fn(async (_s: string, key: string) => store.get(key)),
  put: vi.fn(async (_s: string, value: unknown, key: string) => {
    store.set(key, value)
  }),
  del: vi.fn(async (_s: string, key: string) => {
    store.delete(key)
  }),
  getAll: vi.fn(async () => []),
}))
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))

import {
  answersHere,
  loadAnswerWhere,
  saveAnswerWhere,
  ANSWER_WHERE_DEFAULT,
} from '../answerWhere'
import { canAnswerLocally } from '../ask'
import { saveInferenceConfig } from '../inference'

beforeEach(() => store.clear())

describe('answersHere', () => {
  it('auto answers here only when this device is configured', () => {
    expect(answersHere('auto', true)).toBe(true)
    expect(answersHere('auto', false)).toBe(false)
  })

  it('node never answers here, configured or not', () => {
    expect(answersHere('node', true)).toBe(false)
    expect(answersHere('node', false)).toBe(false)
  })

  // The asymmetry, stated as a test because it looks like a bug otherwise:
  // "this device" keeps the question here even with nothing configured, so the
  // answering path can raise its honest "no endpoint" error. Returning false
  // would send it to the node the owner just excluded — silently, and about a
  // medical record.
  it('device keeps the question here even when nothing is configured', () => {
    expect(answersHere('device', true)).toBe(true)
    expect(answersHere('device', false)).toBe(true)
  })
})

describe('the stored preference', () => {
  it('defaults to auto, which is what the app did before there was a choice', async () => {
    expect(await loadAnswerWhere()).toBe(ANSWER_WHERE_DEFAULT)
    expect(ANSWER_WHERE_DEFAULT).toBe('auto')
  })

  it('round-trips, and reads junk as the default', async () => {
    await saveAnswerWhere('node')
    expect(await loadAnswerWhere()).toBe('node')
    store.set('ai-answer-where', 'somewhere-else')
    expect(await loadAnswerWhere()).toBe('auto')
  })
})

describe('canAnswerLocally honours the preference', () => {
  it('routes to the node when the owner picked Node, endpoint or no endpoint', async () => {
    await saveInferenceConfig('https://x/v1', 'm')
    expect(await canAnswerLocally()).toBe(true)
    await saveAnswerWhere('node')
    expect(await canAnswerLocally()).toBe(false)
  })

  it('keeps the question here when the owner picked Device and nothing is set', async () => {
    await saveAnswerWhere('device')
    expect(await canAnswerLocally()).toBe(true)
  })

  it('falls back to configuration under auto', async () => {
    await saveAnswerWhere('auto')
    expect(await canAnswerLocally()).toBe(false)
    await saveInferenceConfig('https://x/v1', 'm')
    expect(await canAnswerLocally()).toBe(true)
  })
})
