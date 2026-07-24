import { describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_TITLE,
  NOTIFICATION_BODY,
  NOTIFICATION_TAG,
  focusOrOpen,
  type ClientsLike,
  type FocusableClient,
} from '../push-sw'

describe('notification copy', () => {
  it('never varies and never carries record content', () => {
    // Locked-down assertions on purpose: this text is the entire content of
    // every push notification (see the module's doc comment) — a future edit
    // that adds a count, category, or sender must fail this test loudly.
    expect(NOTIFICATION_TITLE).toBe('Svastha')
    expect(NOTIFICATION_BODY).toBe('Something new is waiting for you.')
    expect(NOTIFICATION_TAG).toBe('svastha-poke')
  })
})

describe('focusOrOpen', () => {
  it('focuses the first open window client and opens nothing', async () => {
    const focus = vi.fn(async () => undefined)
    const client: FocusableClient = { url: '/', focus }
    const openWindow = vi.fn(async () => undefined)
    const clients: ClientsLike = {
      matchAll: async () => [client],
      openWindow,
    }

    await focusOrOpen(clients)

    expect(focus).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window when no client is open', async () => {
    const openWindow = vi.fn(async () => undefined)
    const clients: ClientsLike = {
      matchAll: async () => [],
      openWindow,
    }

    await focusOrOpen(clients)

    expect(openWindow).toHaveBeenCalledWith('/')
  })

  it('focuses only the first of several open clients', async () => {
    const focusA = vi.fn(async () => undefined)
    const focusB = vi.fn(async () => undefined)
    const clients: ClientsLike = {
      matchAll: async () => [
        { url: '/a', focus: focusA },
        { url: '/b', focus: focusB },
      ],
    }

    await focusOrOpen(clients)

    expect(focusA).toHaveBeenCalledOnce()
    expect(focusB).not.toHaveBeenCalled()
  })

  it('tolerates a missing openWindow (never throws)', async () => {
    const clients: ClientsLike = { matchAll: async () => [] }
    await expect(focusOrOpen(clients)).resolves.toBeUndefined()
  })
})
