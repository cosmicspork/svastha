import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteDb } from '../db'
import {
  enablePush,
  disablePush,
  isPushEnabledPref,
  reassertPush,
  reassertPushOnStart,
  type PushManagerLike,
  type PushRelayClient,
  type PushSubscriptionLike,
} from '../push'

beforeEach(async () => {
  await deleteDb()
})

// --- fakes ---

function fakeSubscription(endpoint: string, withKeys = true): PushSubscriptionLike {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: withKeys ? { p256dh: 'p256dh-bytes', auth: 'auth-bytes' } : undefined,
    }),
    unsubscribe: vi.fn(async () => true),
  }
}

function fakePushManager(initial: PushSubscriptionLike | null): PushManagerLike & {
  subscribeCalls: unknown[]
} {
  let current = initial
  const subscribeCalls: unknown[] = []
  return {
    subscribeCalls,
    getSubscription: async () => current,
    subscribe: vi.fn(async (options) => {
      subscribeCalls.push(options)
      current = fakeSubscription('https://push.example/new')
      return current
    }),
  }
}

function fakeRelay(overrides: Partial<PushRelayClient> = {}): PushRelayClient & {
  puts: unknown[]
  deletes: (string | undefined)[]
} {
  const puts: unknown[] = []
  const deletes: (string | undefined)[] = []
  return {
    puts,
    deletes,
    getPushKey: async () => 'AAAA', // valid base64url, decodes fine
    putPushSubscription: async (sub) => {
      puts.push(sub)
      return 'ok'
    },
    deletePushSubscription: async (endpoint) => {
      deletes.push(endpoint)
      return 'ok'
    },
    ...overrides,
  }
}

const grant = async (): Promise<NotificationPermission> => 'granted'
const deny = async (): Promise<NotificationPermission> => 'denied'

// --- enablePush ---

describe('enablePush', () => {
  it('subscribes, registers with the relay, and persists the pref on success', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay()

    const result = await enablePush(pm, relay, grant)

    expect(result).toEqual({ ok: true })
    expect(pm.subscribe).toHaveBeenCalledOnce()
    expect(relay.puts).toHaveLength(1)
    expect(await isPushEnabledPref()).toBe(true)
  })

  it('stops at permission-denied without touching the relay or subscribing', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay()

    const result = await enablePush(pm, relay, deny)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('permission-denied')
    expect(pm.subscribe).not.toHaveBeenCalled()
    expect(relay.puts).toHaveLength(0)
    expect(await isPushEnabledPref()).toBe(false)
  })

  it('reports relay-unsupported (503) as an honest feature-off state, never subscribing', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay({ getPushKey: async () => null })

    const result = await enablePush(pm, relay, grant)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('relay-unsupported')
    expect(pm.subscribe).not.toHaveBeenCalled()
    expect(await isPushEnabledPref()).toBe(false)
  })

  it('undoes the local subscription if the relay turns unsupported between the key fetch and the PUT', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay({ putPushSubscription: async () => 'unsupported' })

    const result = await enablePush(pm, relay, grant)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('relay-unsupported')
    // The subscription minted by pm.subscribe() must be torn back down, not
    // orphaned on the browser side with no relay registration.
    const minted = await pm.getSubscription()
    expect(minted?.unsubscribe).toHaveBeenCalled()
    expect(await isPushEnabledPref()).toBe(false)
  })

  it('fails cleanly if the browser subscription carries no usable keys', async () => {
    const pm: PushManagerLike = {
      getSubscription: async () => null,
      subscribe: vi.fn(async () => fakeSubscription('https://push.example/nokeys', false)),
    }
    const relay = fakeRelay()

    const result = await enablePush(pm, relay, grant)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('subscribe-failed')
    expect(relay.puts).toHaveLength(0)
  })

  it('surfaces a subscribe() rejection without persisting the pref', async () => {
    const pm: PushManagerLike = {
      getSubscription: async () => null,
      subscribe: vi.fn(async () => {
        throw new Error('permission dismissed')
      }),
    }
    const relay = fakeRelay()

    const result = await enablePush(pm, relay, grant)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('permission dismissed')
    expect(await isPushEnabledPref()).toBe(false)
  })
})

// --- disablePush ---

describe('disablePush', () => {
  it('unsubscribes locally and deletes the one subscription at the relay', async () => {
    const sub = fakeSubscription('https://push.example/mine')
    const pm = fakePushManager(sub)
    const relay = fakeRelay()

    await disablePush(pm, relay)

    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(relay.deletes).toEqual(['https://push.example/mine'])
    expect(await isPushEnabledPref()).toBe(false)
  })

  it('clears the pref even when there is no live subscription to unsubscribe', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay()

    await disablePush(pm, relay)

    expect(relay.deletes).toHaveLength(0)
    expect(await isPushEnabledPref()).toBe(false)
  })

  it('still clears the local pref even if the relay delete fails', async () => {
    const sub = fakeSubscription('https://push.example/mine')
    const pm = fakePushManager(sub)
    const relay = fakeRelay({
      deletePushSubscription: async () => {
        throw new Error('network error')
      },
    })

    await disablePush(pm, relay)

    expect(await isPushEnabledPref()).toBe(false)
  })
})

// --- reassertPush ---

describe('reassertPush', () => {
  it('does nothing when the user has push off', async () => {
    const pm = fakePushManager(fakeSubscription('https://push.example/x'))
    const relay = fakeRelay()

    await reassertPush(pm, relay)

    expect(relay.puts).toHaveLength(0)
  })

  it('re-PUTs the current subscription when push is on', async () => {
    const sub = fakeSubscription('https://push.example/x')
    const pm = fakePushManager(sub)
    const relay = fakeRelay()
    await enablePush(fakePushManager(sub), relay, grant) // seed the pref to true

    await reassertPush(pm, relay)

    expect(relay.puts).toHaveLength(2) // once from enablePush's own subscribe, once from reassert
  })

  it('does nothing when push is on but the browser subscription is gone', async () => {
    const pm = fakePushManager(null)
    const relay = fakeRelay()
    await enablePush(fakePushManager(fakeSubscription('https://push.example/x')), relay, grant)
    relay.puts.length = 0

    await reassertPush(pm, relay)

    expect(relay.puts).toHaveLength(0)
  })

  it('never asks permission or subscribes fresh — only reads getSubscription()', async () => {
    const pm = fakePushManager(fakeSubscription('https://push.example/x'))
    const relay = fakeRelay()
    await enablePush(fakePushManager(fakeSubscription('https://push.example/x')), relay, grant)

    await reassertPush(pm, relay)

    expect(pm.subscribe).not.toHaveBeenCalled()
  })
})

// --- reassertPushOnStart ---

describe('reassertPushOnStart', () => {
  it('resolves without throwing when there is no navigator (node/vitest environment)', async () => {
    const relay = fakeRelay()
    await expect(reassertPushOnStart(relay)).resolves.toBeUndefined()
    expect(relay.puts).toHaveLength(0)
  })
})
