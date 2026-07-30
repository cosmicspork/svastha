// Which endpoint the owner's node runs *their* work against.
//
// The node resolves this per owner (see `crates/node/src/inference.rs`): the
// owner's own endpoint if they set one, else whatever the operator configured on
// the node, else nothing. So this is a setting the owner makes here and the node
// applies there — and, exactly like the answer scope, a deposited command is not
// an applied one. The same three facts have to line up before this device may
// say the node agrees, and they are checked by the same shared resolution
// (`trackedCommand.ts`).
//
// The API key is deliberately **not** stored here. It goes into the sealed
// command and nowhere else: this device does not need it again, and a copy kept
// in `prefs` — which is plaintext at rest — would be a second place to lose it
// from. What is stored is the endpoint, which is what the owner has to be able
// to see and re-send.
import { get, mutate } from './db'
import {
  resolveTrackedState,
  type NodeCommandState,
  type TrackedReplyLookup,
} from './trackedCommand'

/** `prefs` key. Device-local: a setting, not record content. */
const ENDPOINT_KEY = 'node-inference-endpoint'

/** The last endpoint command this device issued, kept so a reload can still tell
 * the owner whether the node ever confirmed it. */
export interface PendingEndpointCommand {
  id: string | null
  /** The endpoint *this command* carried. */
  endpoint: string
  sentAt: string
  /** The node it was addressed to (Ed25519 hex), or null when none was enrolled.
   * A confirmation from a node the owner has since replaced says nothing about
   * the one enrolled now. */
  nodeEd: string | null
}

/** This device's whole node-endpoint state, written as one value — for the
 * reason `answerScope.ts` argues at length: the desire and the tracking of the
 * command carrying it must land together, or a stale reply stays matchable
 * against a desire it never answered. */
export interface NodeEndpointRecord {
  /** What the owner last told the node to use. */
  endpoint: string
  generation: number
  pending: PendingEndpointCommand
}

/** What this device knows about the node's agreement. `superseded` carries the
 * host the node says it is actually using. */
export type NodeEndpointState = NodeCommandState<string>

/**
 * Read the host a node stated in an `admin_reply` detail: `[endpoint: host]`, or
 * `[endpoint: none]` when it has none at all. Null when the detail states no
 * endpoint — the one thing a caller must not read as agreement.
 *
 * The node states a **host**, never the full URL, because a URL is where a
 * credential hides (`https://host/v1?api-key=…`). So this device compares hosts,
 * which is also the comparison that matters: the host is who receives the
 * record.
 */
export function parseEndpointMarker(detail: string | undefined): string | null {
  if (!detail) return null
  const match = /\[endpoint: ([^\]]+)\]/.exec(detail)
  if (!match) return null
  const body = match[1].trim()
  return body === 'none' ? '' : body
}

/**
 * The host of an endpoint URL, or the trimmed input when it will not parse.
 *
 * Falling back to the raw string rather than throwing keeps a half-typed value
 * comparable instead of crashing a settings screen; it can only ever fail to
 * match a real host, which is the safe direction.
 */
export function endpointHost(endpoint: string): string {
  const raw = endpoint.trim()
  if (!raw) return ''
  try {
    return new URL(raw).host
  } catch {
    return raw
  }
}

/** Whether the host a node stated is the host this device asked for. */
export function sameEndpoint(applied: string, desired: string): boolean {
  return applied === endpointHost(desired)
}

/** Whether two desires are the same endpoint. Compared by host for the same
 * reason the node states one: `https://h/v1` and `https://h/v1/` are the same
 * recipient, and a trailing slash is not a change of mind. */
function sameDesiredEndpoint(a: string, b: string): boolean {
  return endpointHost(a) === endpointHost(b)
}

export function loadNodeEndpoint(): Promise<NodeEndpointRecord | undefined> {
  return get<NodeEndpointRecord>('prefs', ENDPOINT_KEY)
}

/**
 * Commit `endpoint` as the desired one and invalidate any previous
 * confirmation, in one transaction — the commit point, exactly as
 * `commitScopeLocally` is for the scope. Returns the record it wrote, so the
 * caller needs no second read that could fail on its own.
 */
export async function commitEndpointLocally(endpoint: string): Promise<NodeEndpointRecord> {
  const sentAt = new Date().toISOString()
  const { value } = await mutate<NodeEndpointRecord>('prefs', ENDPOINT_KEY, (current) => ({
    endpoint,
    generation: (current?.generation ?? 0) + 1,
    pending: { id: null, endpoint, sentAt, nodeEd: null },
  }))
  // `mutate` resolves `written: false` only when the mutator declines, and this
  // one never does.
  return value!
}

/**
 * Record that the command for `generation` reached the relay under `id`, sent to
 * `nodeEd` — but only if `generation` is still the stored one.
 *
 * A compare-and-update, not a write: a delivery can finish after a newer commit
 * replaced the choice that started it, and writing then would restore an
 * endpoint the owner has already moved away from. Failure is not raised; the
 * caller treats it as `unsent`, which is what is durably on disk.
 */
export async function trackEndpointDelivery(
  generation: number,
  id: string,
  nodeEd: string,
): Promise<{ applied: boolean; record: NodeEndpointRecord | undefined }> {
  try {
    const { written, value } = await mutate<NodeEndpointRecord>(
      'prefs',
      ENDPOINT_KEY,
      (current) => {
        if (!current || current.generation !== generation) return undefined
        return { ...current, pending: { ...current.pending, id, nodeEd } }
      },
    )
    return { applied: written, record: value }
  } catch {
    return { applied: false, record: undefined }
  }
}

/** Resolve what this device can honestly say about the node's endpoint. Pure. */
export function resolveNodeEndpointState(
  record: NodeEndpointRecord | undefined,
  log: TrackedReplyLookup[],
  enrolledNodeEd: string | null,
  now: number,
): NodeEndpointState {
  return resolveTrackedState(
    record && {
      payload: record.endpoint,
      pending: { ...record.pending, payload: record.pending.endpoint },
    },
    log,
    enrolledNodeEd,
    now,
    {
      same: sameEndpoint,
      sameDesire: sameDesiredEndpoint,
      parseMarker: parseEndpointMarker,
    },
  )
}

// --- reading the node's job_status ------------------------------------------

/** The parts of a `job_status` detail this screen renders. Every field is
 * optional because a node older (or newer) than this build may not state it —
 * an absent field is shown as unknown rather than guessed at. */
export interface JobStatus {
  /** Whether the node is reading this owner's pages. `null` when unstated. */
  reading: boolean | null
  /** Pages queued for reading. */
  queued: number | null
  /** The node's per-pass page cap. */
  maxPerPass: number | null
}

/**
 * Read the status rows out of a `job_status` reply detail.
 *
 * Tolerant by construction: the detail is a human-readable line, not a wire
 * format, so anything unrecognised reads as unknown. Showing "—" for a field a
 * node did not state is honest; inventing a zero is not, and a queue of "0"
 * where the node said nothing would read as "nothing waiting".
 */
export function parseJobStatus(detail: string | undefined): JobStatus {
  const empty: JobStatus = { reading: null, queued: null, maxPerPass: null }
  if (!detail) return empty
  const number = (field: string): number | null => {
    const match = new RegExp(`${field}=(\\d+)`).exec(detail)
    return match ? Number(match[1]) : null
  }
  // The node says "paused by you" or "reading" — whose pause it is matters, and
  // the node is explicit about it, so this does not have to guess.
  const reading = /ocr: reading/.test(detail)
    ? true
    : /ocr: paused/.test(detail)
      ? false
      : null
  return { reading, queued: number('queued'), maxPerPass: number('max-per-pass') }
}
