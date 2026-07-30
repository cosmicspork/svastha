// What this device may claim about the endpoint its node is using, and how it
// reads the node's own account of itself.
//
// Same posture as the answer scope: a deposited command is not an applied one,
// and `ok` alone never confirms — the node states the host in force and this
// device checks it. The consequence of getting it wrong is the same shape too:
// the owner believes their record is going to one host while it goes to another.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  puts: 0,
  allowPuts: Infinity,
}))
vi.mock('../db', () => ({
  get: vi.fn(async (_s: string, key: string) => store.values.get(key)),
  put: vi.fn(async (_s: string, value: unknown, key: string) => {
    store.values.set(key, value)
  }),
  // One readwrite transaction: read, decide, write, with no suspension between.
  mutate: vi.fn(async (_s: string, key: string, fn: (c: unknown) => unknown) => {
    const current = store.values.get(key)
    const next = fn(current)
    if (next === undefined) return { written: false, value: current }
    if (store.puts++ >= store.allowPuts) throw new Error('QuotaExceededError')
    store.values.set(key, next)
    return { written: true, value: next }
  }),
  del: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
}))

const node = vi.hoisted(() => ({
  value: null as null | { ed: string; x25519: string },
  logged: [] as unknown[],
}))
vi.mock('../nodeadmin', async () => {
  const actual = await vi.importActual<typeof import('../nodeadmin')>('../nodeadmin')
  return {
    ...actual,
    enrolledNode: vi.fn(async () => node.value),
    recordCommand: vi.fn(async (entry: unknown) => {
      node.logged.push(entry)
    }),
    refreshAdminLog: vi.fn(async () => {}),
  }
})
vi.mock('../svastha', () => ({ WasmDataKey: class {}, initSvastha: vi.fn(async () => {}) }))

import {
  commitEndpointLocally,
  endpointHost,
  loadNodeEndpoint,
  parseEndpointMarker,
  parseJobStatus,
  resolveNodeEndpointState,
  sameEndpoint,
  trackEndpointDelivery,
  type NodeEndpointRecord,
} from '../nodeEndpoint'
import {
  commitNodeEndpoint,
  configureMailbox,
  teardownMailbox,
  type MailboxClient,
  type MailboxIdentity,
} from '../mailbox'
import { CONFIRM_WINDOW_MS } from '../trackedCommand'

const NODE = { ed: 'a'.repeat(64), x25519: 'e'.repeat(64) }

/** The plaintext `{ command }` of the most recent seal. */
let lastBody: { command: { cmd: string; endpoint?: string; api_key?: string } } | null = null
let sealCounter = 0
let relayFails = false

function identity(): MailboxIdentity {
  return {
    open_message: () => new Uint8Array(),
    seal_message: (_x: unknown, _kind: unknown, _sentAt: unknown, body: Uint8Array) => {
      lastBody = JSON.parse(new TextDecoder().decode(body))
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
    },
  } as MailboxClient
}

beforeEach(() => {
  store.values.clear()
  store.puts = 0
  store.allowPuts = Infinity
  node.value = null
  node.logged = []
  lastBody = null
  relayFails = false
})
afterEach(() => teardownMailbox())

describe('endpointHost and the marker', () => {
  it('compares hosts, because the host is who receives the record', () => {
    expect(endpointHost('https://h/v1')).toBe('h')
    expect(endpointHost('https://h:8443/v1/')).toBe('h:8443')
    expect(sameEndpoint('h', 'https://h/v2')).toBe(true)
    expect(sameEndpoint('h', 'https://other/v1')).toBe(false)
  })

  it('reads the host a node stated, and nothing when it stated none', () => {
    expect(parseEndpointMarker('endpoint is now h [endpoint: h]')).toBe('h')
    expect(parseEndpointMarker('nothing set [endpoint: none]')).toBe('')
    // A node too old to state one. Not agreement, and not a guess.
    expect(parseEndpointMarker('inference endpoint updated')).toBeNull()
    expect(parseEndpointMarker(undefined)).toBeNull()
  })
})

describe('resolveNodeEndpointState', () => {
  const record = (over: Partial<NodeEndpointRecord> = {}): NodeEndpointRecord => ({
    endpoint: 'https://mine/v1',
    generation: 1,
    pending: {
      id: 'cmd-1',
      endpoint: 'https://mine/v1',
      sentAt: new Date(1000).toISOString(),
      nodeEd: NODE.ed,
      ...(over.pending ?? {}),
    },
    ...over,
  })
  const at = (ms: number) => 1000 + ms

  it('claims nothing when no node is enrolled', () => {
    expect(resolveNodeEndpointState(record(), [], null, at(0))).toEqual({ state: 'no-node' })
  })

  it('is pending inside the window and unconfirmed after it', () => {
    expect(resolveNodeEndpointState(record(), [], NODE.ed, at(1))).toEqual({ state: 'pending' })
    expect(resolveNodeEndpointState(record(), [], NODE.ed, at(CONFIRM_WINDOW_MS + 1))).toEqual({
      state: 'unconfirmed',
    })
  })

  it('confirms only on a reply that states the host asked for', () => {
    const log = [{ id: 'cmd-1', reply: { ok: true, detail: 'now mine [endpoint: mine]' } }]
    expect(resolveNodeEndpointState(record(), log, NODE.ed, at(0))).toEqual({ state: 'confirmed' })
  })

  // `ok` on its own is a claim about one command, not about what is in force.
  // A node that applied a *later* command from another device answers this one
  // truthfully and is still using something else.
  it('reports superseded when the node states a different host', () => {
    const log = [
      { id: 'cmd-1', reply: { ok: false, detail: 'a later instruction [endpoint: theirs]' } },
    ]
    expect(resolveNodeEndpointState(record(), log, NODE.ed, at(0))).toEqual({
      state: 'superseded',
      applied: 'theirs',
    })
  })

  it('does not read an ok with no stated host as agreement', () => {
    const log = [{ id: 'cmd-1', reply: { ok: true, detail: 'endpoint updated' } }]
    expect(resolveNodeEndpointState(record(), log, NODE.ed, at(0))).toEqual({
      state: 'unconfirmed',
    })
  })

  it('refuses to carry a confirmation across a change of node', () => {
    expect(resolveNodeEndpointState(record(), [], 'b'.repeat(64), at(0))).toEqual({
      state: 'node-changed',
    })
  })

  it('is unsent when the command never left, or carried a different endpoint', () => {
    expect(
      resolveNodeEndpointState(
        record({ pending: { id: null, endpoint: 'https://mine/v1', sentAt: '', nodeEd: null } }),
        [],
        NODE.ed,
        at(0),
      ),
    ).toEqual({ state: 'unsent' })
    expect(
      resolveNodeEndpointState(
        record({
          pending: {
            id: 'cmd-1',
            endpoint: 'https://stale/v1',
            sentAt: new Date(1000).toISOString(),
            nodeEd: NODE.ed,
          },
        }),
        [],
        NODE.ed,
        at(0),
      ),
    ).toEqual({ state: 'unsent' })
  })

  it('treats a trailing slash as the same endpoint, not a change of mind', () => {
    const same = record({
      endpoint: 'https://mine/v1/',
      pending: {
        id: 'cmd-1',
        endpoint: 'https://mine/v1',
        sentAt: new Date(1000).toISOString(),
        nodeEd: NODE.ed,
      },
    })
    expect(resolveNodeEndpointState(same, [], NODE.ed, at(1))).toEqual({ state: 'pending' })
  })
})

describe('commitNodeEndpoint', () => {
  it('persists the endpoint and tracks the command it sent', async () => {
    configureMailbox(client(), identity(), () => true)
    node.value = NODE
    const commit = await commitNodeEndpoint('https://mine/v1', 'sk-secret')
    expect(commit.node).toBe('pending')
    expect(lastBody?.command).toEqual({
      cmd: 'set_inference_endpoint',
      endpoint: 'https://mine/v1',
      api_key: 'sk-secret',
    })
    const stored = await loadNodeEndpoint()
    expect(stored?.endpoint).toBe('https://mine/v1')
    expect(stored?.pending.id).toBe('cmd-1')
    expect(stored?.pending.nodeEd).toBe(NODE.ed)
  })

  // The key is sent and forgotten. `prefs` is plaintext at rest, so a copy kept
  // here would be a second place to lose a credential from — and this device
  // has no further use for it.
  it('never stores the API key', async () => {
    configureMailbox(client(), identity(), () => true)
    node.value = NODE
    await commitNodeEndpoint('https://mine/v1', 'sk-secret')
    expect(JSON.stringify([...store.values.values()])).not.toContain('sk-secret')
  })

  it('seals credentials to the node but redacts them from the durable admin log', async () => {
    configureMailbox(client(), identity(), () => true)
    node.value = NODE

    await commitNodeEndpoint('https://mine/v1?api_key=url-secret', 'body-secret')

    expect(lastBody?.command).toMatchObject({
      endpoint: 'https://mine/v1?api_key=url-secret',
      api_key: 'body-secret',
    })
    expect(node.logged).toHaveLength(1)
    expect(JSON.stringify(node.logged)).not.toContain('url-secret')
    expect(JSON.stringify(node.logged)).not.toContain('body-secret')
    expect(node.logged[0]).toMatchObject({
      command: { cmd: 'set_inference_endpoint', endpoint: 'mine' },
    })
  })

  it('omits the key entirely when there is none, so absent means no key', async () => {
    configureMailbox(client(), identity(), () => true)
    node.value = NODE
    await commitNodeEndpoint('https://mine/v1', '   ')
    expect(lastBody?.command).toEqual({
      cmd: 'set_inference_endpoint',
      endpoint: 'https://mine/v1',
    })
  })

  it('reports unsent — and stays unsent on disk — when the deposit fails', async () => {
    configureMailbox(client(), identity(), () => true)
    node.value = NODE
    relayFails = true
    const commit = await commitNodeEndpoint('https://mine/v1')
    expect(commit.node).toBe('unsent')
    expect((await loadNodeEndpoint())?.pending.id).toBeNull()
  })

  it('records the choice locally when there is no node to tell', async () => {
    configureMailbox(client(), identity(), () => true)
    const commit = await commitNodeEndpoint('https://mine/v1')
    expect(commit.node).toBe('no-node')
    expect((await loadNodeEndpoint())?.endpoint).toBe('https://mine/v1')
  })

  // A delivery can finish after a newer commit replaced the choice that started
  // it. Writing then would restore an endpoint the owner has already moved
  // away from — so the generation is compared inside the transaction.
  it('declines to track a delivery for a superseded generation', async () => {
    const first = await commitEndpointLocally('https://one/v1')
    await commitEndpointLocally('https://two/v1')
    const tracked = await trackEndpointDelivery(first.generation, 'cmd-late', NODE.ed)
    expect(tracked.applied).toBe(false)
    expect((await loadNodeEndpoint())?.endpoint).toBe('https://two/v1')
    expect((await loadNodeEndpoint())?.pending.id).toBeNull()
  })
})

describe('parseJobStatus', () => {
  const detail =
    'vault: events=12 attachments=3 docs=1 curation=0 | ocr: reading queued=7 processed=4 ' +
    'failed=0 max-per-pass=20 | inference: ocr=m@h chat=m@h (your endpoint) | ' +
    'answers: ordinary record only | last_reconcile=1753000000'

  it('reads the rows the node states', () => {
    expect(parseJobStatus(detail)).toEqual({ reading: true, queued: 7, maxPerPass: 20 })
  })

  it('reads a pause as a pause', () => {
    expect(parseJobStatus(detail.replace('ocr: reading', 'ocr: paused by you')).reading).toBe(false)
  })

  // A node that stated nothing must render as unknown, not as zero: "0 pages
  // waiting" is a claim this device has no basis for.
  it('reports unknown rather than inventing a zero', () => {
    expect(parseJobStatus(undefined)).toEqual({ reading: null, queued: null, maxPerPass: null })
    expect(parseJobStatus('(no log lines yet)')).toEqual({
      reading: null,
      queued: null,
      maxPerPass: null,
    })
  })
})
