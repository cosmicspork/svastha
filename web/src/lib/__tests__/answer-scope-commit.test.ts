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
  /** Allow this many puts, then fail every one after — each `put` is its own
   * IndexedDB transaction, so "the first write landed and a later one did not"
   * is a real state the store can be left in, not a contrived one. */
  allowPuts: Infinity,
  puts: 0,
}))
vi.mock('../db', () => ({
  get: vi.fn(async (_s: string, key: string) => store.values.get(key)),
  put: vi.fn(async (_s: string, value: unknown, key: string) => {
    if (store.putFails || store.puts++ >= store.allowPuts) throw new Error('QuotaExceededError')
    store.values.set(key, value)
  }),
  // Models a single IndexedDB readwrite transaction: read, decide, and write
  // with no suspension in between, so nothing can land in the middle. The
  // interleaving tests below therefore exercise the generation check itself
  // rather than a gap the mock happens to leave open.
  mutate: vi.fn(async (_s: string, key: string, fn: (c: unknown) => unknown) => {
    const current = store.values.get(key)
    const next = fn(current)
    if (next === undefined) return { written: false, value: current }
    if (store.putFails || store.puts++ >= store.allowPuts) throw new Error('QuotaExceededError')
    store.values.set(key, next)
    return { written: true, value: next }
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
  loadAnswerScope,
  resolveNodeScopeState,
  CONFIRM_WINDOW_MS,
  type AnswerScopeRecord,
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
      // One-shot: only the deposit that finds the gate waits on it, so a test
      // can park the *first* delivery and let a second commit run past it —
      // the two-tab race, made deterministic.
      const gate = relayGate
      relayGate = null
      if (gate) {
        gate.entered()
        await gate.held
      }
      if (relayFails) throw new Error('network')
      sent.push({ command: lastBody?.command })
    },
  } as MailboxClient
}

let relayGate: { held: Promise<void>; entered: () => void } | null = null

/**
 * Park the next relay deposit. Returns `entered` — which resolves once a deposit
 * has actually reached the gate — and `release`.
 *
 * Awaiting `entered` before interleaving the second commit is what makes the race
 * deterministic: the caller of `commitAnswerScope` has several awaits to get
 * through before it deposits, so "start it and assume it is parked" would race
 * the harness against the code under test and park the wrong deposit.
 */
function stallRelay(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
  const held = new Promise<void>((resolve) => (release = resolve))
  relayGate = { held, entered }
  return { entered: enteredPromise, release }
}

beforeEach(() => {
  store.values.clear()
  store.putFails = false
  store.allowPuts = Infinity
  store.puts = 0
  relayFails = false
  relayGate = null
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
    expect(await loadAnswerScope()).toMatchObject({
      include: ['cycle'],
      pending: { id: null, include: ['cycle'] },
    })
  })

  // The half-written opt-out.
  //
  // Cycle is on and the node has confirmed it. The owner turns Cycle off; the
  // desired-scope write lands, the relay is down, and the write that was meant
  // to invalidate the old tracked command does not land either — a separate
  // IndexedDB transaction, so this is an ordinary partial failure, not a
  // contrived one.
  //
  // If the previous command's id survives that, its old `ok` reply is still
  // matchable, and the app tells the owner "Your node has applied this" about a
  // node that is still reading Cycle. That is the worst sentence this screen can
  // produce: it is not a missing reassurance, it is a false one, about exactly
  // the disclosure the owner just tried to stop.
  it('never leaves a stale confirmation eligible when an opt-out is only half-written', async () => {
    node.value = NODE
    await commitAnswerScope(set('cycle'))
    const confirmedLog = [{ id: 'cmd-1', reply: { ok: true } }]
    expect(
      resolveNodeScopeState(await loadAnswerScope(), confirmedLog, NODE.ed, Date.now()),
    ).toEqual({ state: 'confirmed' })

    // Opt out: the scope write succeeds, the relay is down, and the very next
    // write fails.
    relayFails = true
    store.allowPuts = store.puts + 1
    await commitAnswerScope(set())

    store.allowPuts = Infinity
    // The desired scope did land — this is the half that worked.
    expect(await loadOptIns()).toEqual(set())
    const state = resolveNodeScopeState(
      await loadAnswerScope(),
      confirmedLog,
      NODE.ed,
      Date.now(),
    )
    expect(state).not.toEqual({ state: 'confirmed' })
    // And not `idle` either — that renders as "nothing to say", which is just as
    // silent. The durable answer has to be that the node was not told.
    expect(state).toEqual({ state: 'unsent' })
  })

  // Same swallowed write, but with no earlier command to go stale. The old
  // shape degraded to `idle` here, which shows the owner nothing at all.
  it('is durably unsent — never idle — when a first opt-out is only half-written', async () => {
    node.value = NODE
    relayFails = true
    store.allowPuts = store.puts + 1
    await commitAnswerScope(set())

    store.allowPuts = Infinity
    expect(
      resolveNodeScopeState(await loadAnswerScope(), [], NODE.ed, Date.now()),
    ).toEqual({ state: 'unsent' })
  })
})

describe('resolveNodeScopeState', () => {
  /** A record whose tracked command matches its desired set — the ordinary
   * shape, since both are written together. */
  const pending = (over: Partial<AnswerScopeRecord['pending']> = {}): AnswerScopeRecord => ({
    include: ['cycle'],
    generation: 1,
    pending: {
      id: 'cmd-1',
      include: ['cycle'],
      sentAt: new Date(1_000_000).toISOString(),
      nodeEd: NODE.ed,
      ...over,
    },
  })
  const now = 1_000_000

  it('is no-node when nothing is enrolled', () => {
    expect(resolveNodeScopeState(pending(), [], null, now)).toEqual({ state: 'no-node' })
  })

  it('is idle before anything has been chosen', () => {
    expect(resolveNodeScopeState(undefined, [], NODE.ed, now)).toEqual({ state: 'idle' })
  })

  it('is unsent when the command never left the device', () => {
    expect(resolveNodeScopeState(pending({ id: null }), [], NODE.ed, now)).toEqual({ state: 'unsent' })
  })

  it('is pending inside the window and unconfirmed after it', () => {
    expect(resolveNodeScopeState(pending(), [], NODE.ed, now + 1000)).toEqual({ state: 'pending' })
    expect(resolveNodeScopeState(pending(), [], NODE.ed, now + CONFIRM_WINDOW_MS)).toEqual({
      state: 'unconfirmed',
    })
  })

  // Version skew: a node too old to deserialize the command never replies at
  // all, so it presents exactly as an offline one — which is the honest reading,
  // since in both cases the node is still on its previous setting.
  it('resolves an old node that cannot parse the command to unconfirmed, never confirmed', () => {
    const state = resolveNodeScopeState(pending(), [{ id: 'other' }], NODE.ed, now + CONFIRM_WINDOW_MS)
    expect(state).toEqual({ state: 'unconfirmed' })
  })

  it('is confirmed only on an ok reply to this very command', () => {
    expect(
      resolveNodeScopeState(pending(), [{ id: 'cmd-1', reply: { ok: true } }], NODE.ed, now),
    ).toEqual({ state: 'confirmed' })
    // A reply to some other command proves nothing about this one.
    expect(
      resolveNodeScopeState(
        pending(),
        [{ id: 'cmd-0', reply: { ok: true } }],
        NODE.ed,
        now + CONFIRM_WINDOW_MS,
      ),
    ).toEqual({ state: 'unconfirmed' })
  })

  // A reply is evidence about the command it answers, nothing more. If the
  // tracked command asked for a different set than the owner now wants, its
  // `ok` says the node applied *that* — which is not agreement with this.
  it('will not confirm on a reply to a command carrying a different set', () => {
    const superseded: AnswerScopeRecord = {
      include: [],
      generation: 2,
      pending: {
        id: 'cmd-1',
        include: ['cycle'],
        sentAt: new Date(1_000_000).toISOString(),
        nodeEd: NODE.ed,
      },
    }
    expect(
      resolveNodeScopeState(superseded, [{ id: 'cmd-1', reply: { ok: true } }], NODE.ed, now),
    ).toEqual({ state: 'unsent' })
  })

  it('surfaces a refusal with the node’s reason', () => {
    expect(
      resolveNodeScopeState(
        pending(),
        [{ id: 'cmd-1', reply: { ok: false, detail: 'could not save the answer scope: EIO' } }],
        NODE.ed,
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
    expect(await loadAnswerScope()).toMatchObject({ pending: { id: null } })

    relayFails = false
    sent.length = 0
    expect((await retryAnswerScope()).node).toBe('pending')
    expect(sent).toEqual([{ command: { cmd: 'set_answer_scope', include: ['mind'] } }])
    expect(await loadOptIns()).toEqual(set('mind'))
  })

  it('is a no-op when there is nothing recorded to retry', async () => {
    expect((await retryAnswerScope()).node).toBe('unsent')
    expect(sent).toEqual([])
  })
})

// --- 1. the caller must never need a second read -----------------------------
//
// The UI used to re-read the record after committing. That read is a separate
// transaction and can reject on its own, and the old catch treated the rejection
// as a commit failure: it kept the previous in-memory record — including an
// older `ok: true` command — and told the owner nothing had changed, while the
// opt-out had in fact been persisted. "Your node has applied this" beside an off
// switch, about a node still reading Cycle.
//
// So the commit returns exactly what it persisted, and there is nothing left to
// re-read.

describe('the commit returns what the caller should install', () => {
  it('hands back the persisted record, so no second read is needed', async () => {
    node.value = NODE
    const commit = await commitAnswerScope(set('cycle'))
    expect(commit.record).toEqual(await loadAnswerScope())
    expect(commit.record.include).toEqual(['cycle'])
    expect(commit.record.pending.id).toBe('cmd-1')
  })

  it('hands back the tracking-free record when delivery failed', async () => {
    node.value = NODE
    relayFails = true
    const commit = await commitAnswerScope(set())
    expect(commit.record).toEqual(await loadAnswerScope())
    expect(commit.record.pending.id).toBeNull()
  })

  it('retry hands its record back too', async () => {
    node.value = NODE
    await commitAnswerScope(set('mind'))
    const retry = await retryAnswerScope()
    expect(retry.record).toEqual(await loadAnswerScope())
    expect(retry.node).toBe('pending')
  })
})

// --- 2. a stalled delivery must not resurrect its own stale record -----------

describe('a delivery that finishes late', () => {
  // Tab A commits Cycle-on and stalls mid-deposit. Tab B commits Cycle-off. A
  // then resumes and records its delivery. Writing its whole pre-network record
  // would put Cycle back on — silently, with no owner action, and against the
  // switch B just set.
  it('cannot overwrite a newer commit’s desired set', async () => {
    node.value = NODE

    const gate = stallRelay()
    const tabA = commitAnswerScope(set('cycle'))
    await gate.entered
    // A is now parked inside putMailbox, holding its pre-network record.
    const tabB = await commitAnswerScope(set())
    expect(tabB.record.include).toEqual([])

    gate.release()
    await tabA

    // B's choice stands. A's delivery is evidence about a superseded command and
    // must not restore its `include`.
    expect(await loadOptIns()).toEqual(set())
    const stored = await loadAnswerScope()
    expect(stored?.include).toEqual([])
    expect(stored?.pending.include).toEqual([])
  })

  it('reports itself superseded rather than claiming a pending confirmation', async () => {
    node.value = NODE
    const gate = stallRelay()
    const tabA = commitAnswerScope(set('cycle'))
    await gate.entered
    await commitAnswerScope(set())
    gate.release()
    // A's own delivery landed at the relay, but for a set nobody wants now, so
    // there is nothing for A to report as in flight.
    expect((await tabA).node).toBe('unsent')
  })

  it('retry cannot overwrite a newer commit either', async () => {
    node.value = NODE
    await commitAnswerScope(set('cycle'))

    const gate = stallRelay()
    const retry = retryAnswerScope()
    await gate.entered
    await commitAnswerScope(set())
    gate.release()
    await retry

    expect(await loadOptIns()).toEqual(set())
    expect((await loadAnswerScope())?.include).toEqual([])
  })

  it('stamps a fresh generation on every commit', async () => {
    node.value = NODE
    await commitAnswerScope(set('cycle'))
    const first = (await loadAnswerScope())!.generation
    await commitAnswerScope(set())
    expect((await loadAnswerScope())!.generation).toBe(first + 1)
  })
})

// --- 3. a confirmation belongs to the node that gave it ----------------------

describe('confirmation is bound to the node that received the command', () => {
  const NODE_B = { ed: 'b'.repeat(64), x25519: 'c'.repeat(64) }

  // Node A confirmed Cycle-off. The owner then re-enrols a different node. B has
  // never been sent the scope and may be reading Cycle, but A's durable
  // `ok: true` is still on disk — and matched by id, which knows nothing about
  // which node answered.
  it('stops confirming once a different node is enrolled', async () => {
    node.value = NODE
    const commit = await commitAnswerScope(set())
    const log = [{ id: commit.record.pending.id!, reply: { ok: true } }]

    expect(resolveNodeScopeState(commit.record, log, NODE.ed, Date.now())).toEqual({
      state: 'confirmed',
    })
    // Same record, same reply, different node now enrolled.
    expect(resolveNodeScopeState(commit.record, log, NODE_B.ed, Date.now())).toEqual({
      state: 'node-changed',
    })
  })

  it('records which node a command was addressed to', async () => {
    node.value = NODE
    const commit = await commitAnswerScope(set('cycle'))
    expect(commit.record.pending.nodeEd).toBe(NODE.ed)
  })

  it('re-sending after the swap binds the confirmation to the new node', async () => {
    node.value = NODE
    await commitAnswerScope(set())

    node.value = NODE_B
    const retry = await retryAnswerScope()
    expect(retry.record.pending.nodeEd).toBe(NODE_B.ed)
    expect(sent.at(-1)).toEqual({ command: { cmd: 'set_answer_scope', include: [] } })
    // And the new command is what B's reply will be matched against.
    expect(
      resolveNodeScopeState(
        retry.record,
        [{ id: retry.record.pending.id!, reply: { ok: true } }],
        NODE_B.ed,
        Date.now(),
      ),
    ).toEqual({ state: 'confirmed' })
  })
})
