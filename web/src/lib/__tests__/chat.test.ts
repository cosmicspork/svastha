import { beforeEach, describe, expect, it } from 'vitest'
import { get as storeGet } from 'svelte/store'
import { deleteDb } from '../db'
import {
  chatTurns,
  refreshChat,
  appendTurn,
  clearChat,
  listChatTurns,
  sortChronological,
  conversationState,
  type ChatTurn,
} from '../chat'

beforeEach(async () => {
  await deleteDb()
  chatTurns.set([])
})

function turn(id: string, role: 'user' | 'node', over: Partial<ChatTurn> = {}): ChatTurn {
  return { id, role, text: `${role} ${id}`, citations: [], createdAt: '2026-07-24T10:00:00.000Z', ...over }
}

describe('pure helpers', () => {
  it('sorts chronologically, breaking ties by id', () => {
    const a = turn('b', 'user', { createdAt: '2026-07-24T10:00:00.000Z' })
    const b = turn('a', 'node', { createdAt: '2026-07-24T10:00:00.000Z' })
    const c = turn('c', 'user', { createdAt: '2026-07-24T09:00:00.000Z' })
    expect(sortChronological([a, b, c]).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('reports the conversation state honestly', () => {
    expect(conversationState([])).toBe('empty')
    expect(conversationState([turn('q1', 'user')])).toBe('waiting')
    expect(
      conversationState([
        turn('q1', 'user', { createdAt: '2026-07-24T10:00:00.000Z' }),
        turn('a1', 'node', { createdAt: '2026-07-24T10:00:01.000Z' }),
      ]),
    ).toBe('answered')
  })

  it('a newer question after an answer returns to waiting', () => {
    const turns = [
      turn('q1', 'user', { createdAt: '2026-07-24T10:00:00.000Z' }),
      turn('a1', 'node', { createdAt: '2026-07-24T10:00:01.000Z' }),
      turn('q2', 'user', { createdAt: '2026-07-24T10:00:02.000Z' }),
    ]
    expect(conversationState(turns)).toBe('waiting')
  })
})

describe('store ops', () => {
  it('appends a turn and mirrors it to the store', async () => {
    expect(await appendTurn(turn('q1', 'user'))).toBe(true)
    expect(await listChatTurns()).toHaveLength(1)
    expect(storeGet(chatTurns).map((t) => t.id)).toEqual(['q1'])
  })

  it('dedupes a re-pulled answer by message id', async () => {
    const answer = turn('a1', 'node', { text: 'first', citations: ['ev-x'] })
    expect(await appendTurn(answer)).toBe(true)
    // A second pull of the same envelope must not double or overwrite the turn.
    expect(await appendTurn({ ...answer, text: 'second' })).toBe(false)
    const stored = await listChatTurns()
    expect(stored).toHaveLength(1)
    expect(stored[0].text).toBe('first')
  })

  it('hydrates the store chronologically', async () => {
    await appendTurn(turn('a1', 'node', { createdAt: '2026-07-24T10:00:01.000Z' }))
    await appendTurn(turn('q1', 'user', { createdAt: '2026-07-24T10:00:00.000Z' }))
    await refreshChat()
    expect(storeGet(chatTurns).map((t) => t.id)).toEqual(['q1', 'a1'])
  })

  it('clears the conversation', async () => {
    await appendTurn(turn('q1', 'user'))
    await clearChat()
    expect(await listChatTurns()).toHaveLength(0)
    expect(storeGet(chatTurns)).toEqual([])
  })
})
