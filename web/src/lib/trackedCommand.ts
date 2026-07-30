// What this device can honestly say about a setting it asked its node to apply.
//
// Two settings now ride to the node as `admin_cmd`s the owner sets here and the
// node applies there: which categories answers may read (`answerScope.ts`) and
// which endpoint the node runs this owner's work against (`nodeEndpoint.ts`).
// The gap between "deposited" and "applied" is the same gap in both — an offline
// node, a node too old to parse the command, a node whose state file will not
// write — and so is the rule for closing it: a reply is evidence about exactly
// one command, and three facts must line up before it counts as agreement with
// what the owner wants *now*.
//
// That rule lives here once. Each setting keeps its own record shape and its own
// storage key (the persisted shapes predate this and are not worth migrating for
// a shared field name); what they share is this resolution, so neither can drift
// into claiming a confirmation the other would not.
//
// Pure — the caller supplies `now` and the comparison — so every branch is
// directly testable without a node, a relay, or a clock.

/** How long to wait for a node's `admin_reply` before calling it unconfirmed.
 * Generous next to the node's reconcile cadence: the point is to stop waiting
 * silently, not to time the node. */
export const CONFIRM_WINDOW_MS = 90_000

/** The tracking half of a setting's record, in the shape this module reasons
 * about. Callers map their own field names onto it. */
export interface TrackedCommand<T> {
  /** The `admin_cmd` envelope message id the reply carries as `in_reply_to`, or
   * null when the command never left this device at all. */
  id: string | null
  /** What *this command* asked for — stored separately from the current desire,
   * because a reply only confirms the current desire if the command it answers
   * asked for the current desire. */
  payload: T
  sentAt: string
  /**
   * The node this command was addressed to (Ed25519 hex), or null when none was
   * enrolled at the time.
   *
   * A reply is matched by command id, and an id says nothing about *which* node
   * answered. A confirmation from a node the owner has since replaced would
   * otherwise keep reading as agreement, while the node now enrolled has never
   * been told.
   */
  nodeEd: string | null
}

/** A setting's state as this module reads it: what the owner wants, and the last
 * command issued about it. */
export interface TrackedState<T> {
  payload: T
  pending: TrackedCommand<T>
}

/** The reply-bearing shape read from the admin log. Structurally satisfied by
 * `nodeadmin.ts`'s `AdminLogEntry`, taken as a parameter rather than imported so
 * this module stays free of that dependency. */
export interface TrackedReplyLookup {
  id: string
  reply?: { ok: boolean; detail?: string }
}

/** What this device knows about the node's agreement with the local choice.
 * `A` is the type a node's stated marker parses to, which need not be the type
 * of the desire it is compared against (a node states an endpoint *host*; this
 * device holds a whole URL). */
export type NodeCommandState<A> =
  /** No node is enrolled — the local choice is the whole story. */
  | { state: 'no-node' }
  /** Nothing has been sent, because nothing has been chosen since enrolment. */
  | { state: 'idle' }
  /** Deposited; no reply yet, still inside {@link CONFIRM_WINDOW_MS}. */
  | { state: 'pending' }
  /** The node replied `ok` and stated what this device asked for — the only
   * state that claims agreement. */
  | { state: 'confirmed' }
  /** The node replied, and refused. */
  | { state: 'refused'; detail?: string }
  /** Deposited, but no reply came in time: offline, or a node too old to know
   * the command (it cannot parse it, so it never replies). */
  | { state: 'unconfirmed' }
  /** Never left this device (locked vault, no relay). */
  | { state: 'unsent' }
  /** A different node is enrolled now than the one this was sent to. What the
   * current node is doing is unknown — it was never told. */
  | { state: 'node-changed' }
  /** The node answered, and stated something other than what this device asked
   * for — another device set it more recently. `applied` is what it says is in
   * force. */
  | { state: 'superseded'; applied: A }

/** How to compare a node's stated marker against the local desire, and how to
 * read that marker out of a reply's `detail`. */
export interface TrackedComparison<T, A> {
  /** Whether the node's stated value is the one this device asked for. The two
   * types differ where the node states less than this device holds — it names an
   * endpoint *host*, this device holds the whole URL. */
  same: (applied: A, desired: T) => boolean
  /** Whether the value a command carried is still the value the owner wants. */
  sameDesire: (a: T, b: T) => boolean
  /** The value a node stated in its reply, or null when it stated none — which
   * is the one thing a caller must not read as agreement. */
  parseMarker: (detail: string | undefined) => A | null
}

/**
 * Resolve what this device can honestly say about the node.
 *
 * There is deliberately no "assume it worked" branch: a missing reply resolves
 * to `unconfirmed`, never `confirmed`. And `ok` alone never confirms — the node
 * states what is in force, and this checks it, because with more than one device
 * "my command was applied" and "what is in force now" have different answers.
 *
 * `enrolledNodeEd` is the Ed25519 hex of the node enrolled right now, or null.
 */
export function resolveTrackedState<T, A>(
  record: TrackedState<T> | undefined,
  log: TrackedReplyLookup[],
  enrolledNodeEd: string | null,
  now: number,
  { same, sameDesire, parseMarker }: TrackedComparison<T, A>,
): NodeCommandState<A> {
  if (!enrolledNodeEd) return { state: 'no-node' }
  // Nothing has ever been chosen. Once anything has, `pending` is written with
  // it in the same put, so this cannot be reached by a half-written choice.
  if (!record) return { state: 'idle' }

  const { payload, pending } = record
  if (pending.id === null) return { state: 'unsent' }
  // Belt and braces over the atomic write: if the tracked command is for some
  // other value, it is not evidence about this one.
  if (!sameDesire(pending.payload, payload)) return { state: 'unsent' }
  // Addressed to a node that is no longer the one enrolled. Whatever it replied
  // was true of it, and says nothing about the node serving this vault now.
  if (pending.nodeEd !== enrolledNodeEd) return { state: 'node-changed' }

  const reply = log.find((e) => e.id === pending.id)?.reply
  if (reply) {
    const applied = parseMarker(reply.detail)
    if (applied !== null && !same(applied, payload)) return { state: 'superseded', applied }
    if (!reply.ok) return { state: 'refused', detail: reply.detail }
    // Answered ok, but stated nothing: an older node build that applies the
    // command without saying what it applied. Nothing to check it against, so it
    // gets the same treatment as a node that never answered — and the same
    // re-send offer.
    if (applied === null) return { state: 'unconfirmed' }
    return { state: 'confirmed' }
  }
  const age = now - new Date(pending.sentAt).getTime()
  return age < CONFIRM_WINDOW_MS ? { state: 'pending' } : { state: 'unconfirmed' }
}

