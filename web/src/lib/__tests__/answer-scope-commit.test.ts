// The commit path's ordering contract, and what this device may claim about the
// node.
//
// `../db` is mocked here (unlike mailbox.test.ts, which runs the real store)
// precisely so the local write can be made to FAIL — the case the switch has to
// survive without lying.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  putFails: false,
}))
vi.mock('../db', () => ({
  get: vi.fn(async (_s: string, key: string) => store.values.get(key)),
  put: vi.fn(async (_s: string, value: unknown, key: string) => {
    if (store.putFails) throw new Error('QuotaExceededError')
    store.values.set(key, value)
  }),
  del: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
}))

const node = vi.hoisted(() => ({ value: null as null | { ed: string; x25519: string } }))
vi.mock('../nodeadmin', async () => {
  const actual = await vi.importActual<typeof import('../nodeadmin')>('../nodeadmin')
  return {
    ...actual,
    enrolledNode: vi.fn(async () => node.value),
    recordCommand: vi.fn(async () => {}),
    refreshAdminLog: vi.fn(async () => {}),
  }
})
vi.mock('../svastha', () => ({ WasmDataKey: class {}, initSvastha: vi.fn(async () => {}) }))

import {
  commitAnswerScope,
  retryAnswerScope,
  configureMailbox,
  teardownMailbox,
  type MailboxClient,
  type MailboxIdentity,
} from '../mailbox'
import {
  loadOptIns,
  loadPendingScopeCommand,
  resolveNodeScopeState,
  CONFIRM_WINDOW_MS,
  type PendingScopeCommand,
} from '../answerScope'
import type { Category } from '../category'

afterEach(() => teardownMailbox())

const set = (...cats: Category[]) => new Set<Category>(cats)
const NODE = { ed: 'a'.repeat(64), x25519: 'e'.repeat(64) }

/** The commands that actually reached the relay this test, in order. */
const sent: { command: unknown }[] = []
/** Flipped on to make the relay deposit fail — the "node never heard it" case. */
let relayFails = false
/** Distinct envelope ids per send, so a retry is a NEW command with a new id. */
let sealCounter = 0

/** The body of the most recent seal — the plaintext `{ command }` the envelope
 * would carry. Captured at the seal, since what reaches the relay is the sealed
 * envelope and this test asserts on the instruction inside it. */
let lastBody: { command: unknown } | null = null

function identity(): MailboxIdentity {
  return {
    open_message: () => new Uint8Array(),
    seal_message: (_x: unknown, _kind: unknown, _sentAt: unknown, body: Uint8Array) => {
      lastBody = JSON.parse(new TextDecoder().decode(body)) as { command: unknown }
      return JSON.stringify({ id: `cmd-${++sealCounter}` })
    },
    unwrap_key: () => ({}),
    ed25519_public_hex: 'd'.repeat(64),
    x25519_public_hex: 'f'.repeat(64),
  } as unknown as MailboxIdentity
}

function client(): MailboxClient {
  return {
    async listMailbox() {
      return []
    },
    async getMailbox() {
      return null
    },
    async deleteMailbox() {
      return true
    },
    async putMailbox() {
      if (relayFails) throw new Error('network')
      sent.push({ command: lastBody?.command })
    },
  } as MailboxClient
}

beforeEach(() => {
  store.values.clear()
  store.putFails = false
  relayFails = false
  sealCounter = 0
  sent.length = 0
  lastBody = null
  node.value = null
  configureMailbox(client(), identity(), () => true)
})

describe('the local write is the commit point', () => {
  it('persists before reporting, so the caller can render on the resolved value', async () => {
    const commit = await commitAnswerScope(set('cycle'))
    expect(commit.include).toEqual(['cycle'])
    expect(await loadOptIns()).toEqual(set('cycle'))
  })

  // The blocker case: the owner turns a category OFF and the prefs write fails.
  // If this resolved, the switch would render off while `ask.ts` reloaded the
  // old opt-in and kept sending those entries.
  it('throws when the prefs write is rejected while opting out, changing nothing', async () => {
    await commitAnswerScope(set('cycle', 'mind'))
    expect(await loadOptIns()).toEqual(set('cycle', 'mind'))

    store.putFails = true
    await expect(commitAnswerScope(set())).rejects.toThrow()

    store.putFails = false
    expect(await loadOptIns()).toEqual(set('cycle', 'mind'))
  })

  it('does not send the node anything when the local write failed', async () => {
    node.value = NODE
    store.putFails = true
    await expect(commitAnswerScope(set())).rejects.toThrow()
    expect(sent).toEqual([])
  })

  // The node half is remote and best-effort: it is reported, never raised, so a
  // relay failure cannot undo a choice already in force on this device.
  it('still resolves — and stays saved — when the node cannot be reached', async () => {
    node.value = NODE
    relayFails = true
    const commit = await commitAnswerScope(set('mind'))
    expect(commit.node).toBe('unsent')
    expect(await loadOptIns()).toEqual(set('mind'))
  })
})

describe('what this device may claim about the node', () => {
  it('never reports a deposited command as applied', async () => {
    node.value = NODE
    const commit = await commitAnswerScope(set('cycle'))
    expect(commit.node).toBe('pending')
  })

  it('records an unsent command so a reload cannot mistake it for success', async () => {
    node.value = NODE
    relayFails = true
    await commitAnswerScope(set('cycle'))
    expect(await loadPendingScopeCommand()).toMatchObject({ id: null, include: ['cycle'] })
  })
})

describe('resolveNodeScopeState', () => {
  const pending = (over: Partial<PendingScopeCommand> = {}): PendingScopeCommand => ({
    id: 'cmd-1',
    include: ['cycle'],
    sentAt: new Date(1_000_000).toISOString(),
    ...over,
  })
  const now = 1_000_000

  it('is no-node when nothing is enrolled', () => {
    expect(resolveNodeScopeState(pending(), [], false, now)).toEqual({ state: 'no-node' })
  })

  it('is idle before anything has been chosen', () => {
    expect(resolveNodeScopeState(undefined, [], true, now)).toEqual({ state: 'idle' })
  })

  it('is unsent when the command never left the device', () => {
    expect(resolveNodeScopeState(pending({ id: null }), [], true, now)).toEqual({ state: 'unsent' })
  })

  it('is pending inside the window and unconfirmed after it', () => {
    expect(resolveNodeScopeState(pending(), [], true, now + 1000)).toEqual({ state: 'pending' })
    expect(resolveNodeScopeState(pending(), [], true, now + CONFIRM_WINDOW_MS)).toEqual({
      state: 'unconfirmed',
    })
  })

  // Version skew: a node too old to deserialize the command never replies at
  // all, so it presents exactly as an offline one — which is the honest reading,
  // since in both cases the node is still on its previous setting.
  it('resolves an old node that cannot parse the command to unconfirmed, never confirmed', () => {
    const state = resolveNodeScopeState(pending(), [{ id: 'other' }], true, now + CONFIRM_WINDOW_MS)
    expect(state).toEqual({ state: 'unconfirmed' })
  })

  it('is confirmed only on an ok reply to this very command', () => {
    expect(
      resolveNodeScopeState(pending(), [{ id: 'cmd-1', reply: { ok: true } }], true, now),
    ).toEqual({ state: 'confirmed' })
    // A reply to some other command proves nothing about this one.
    expect(
      resolveNodeScopeState(
        pending(),
        [{ id: 'cmd-0', reply: { ok: true } }],
        true,
        now + CONFIRM_WINDOW_MS,
      ),
    ).toEqual({ state: 'unconfirmed' })
  })

  it('surfaces a refusal with the node’s reason', () => {
    expect(
      resolveNodeScopeState(
        pending(),
        [{ id: 'cmd-1', reply: { ok: false, detail: 'could not save the answer scope: EIO' } }],
        true,
        now,
      ),
    ).toEqual({ state: 'refused', detail: 'could not save the answer scope: EIO' })
  })
})

describe('retryAnswerScope', () => {
  // The old copy said "toggle again", which sends the OPPOSITE set — a reversal
  // dressed as a retry. A retry re-sends what the owner actually wants.
  it('re-sends the same desired set, not the opposite one', async () => {
    node.value = NODE
    relayFails = true
    await commitAnswerScope(set('mind'))
    expect(await loadOptIns()).toEqual(set('mind'))
    expect(await loadPendingScopeCommand()).toMatchObject({ id: null })

    relayFails = false
    sent.length = 0
    expect(await retryAnswerScope()).toBe('pending')
    expect(sent).toEqual([{ command: { cmd: 'set_answer_scope', include: ['mind'] } }])
    expect(await loadOptIns()).toEqual(set('mind'))
  })

  it('is a no-op when there is nothing recorded to retry', async () => {
    expect(await retryAnswerScope()).toBe('unsent')
    expect(sent).toEqual([])
  })
})
