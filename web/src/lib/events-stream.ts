// The relay push client: one long-lived authenticated `GET /v0/events` that the
// relay pokes to make this client pull sooner than its poll timer would (see
// `spec/README.md`, "Push channel", and the design's §5). The channel carries
// payload-free pokes only — `blobs` / `mailbox` / `sync` — never ids or content,
// so a poke's only job is to *trigger* the ordinary pull path, which stays the
// single source of truth. Because the pull path is authoritative, the channel is
// lossy by design: a dropped or missed poke costs nothing but latency, so the
// periodic poll in sync.ts stays as the floor.
//
// Native `EventSource` can't set the Ed25519 auth headers, so the caller opens
// the stream with fetch-streaming (a normal authed `GET` whose body is read
// incrementally); this module parses the `text/event-stream` bytes and runs the
// reconnect loop. Split from sync.ts, and taking its stream opener + poke sink as
// plain injected functions, so the parser and the reconnect/backoff logic
// unit-test with a fake stream — no network, no wasm, no browser.

/** A poke names which pull to run. `sync` is the relay's catch-up poke for a
 * client that may have fallen behind (pull everything). An unrecognized event
 * name is ignored (additive-versioning tolerance), never treated as `sync`. */
export type Poke = 'blobs' | 'mailbox' | 'sync'

const KNOWN_POKES: readonly Poke[] = ['blobs', 'mailbox', 'sync']

function asPoke(eventName: string): Poke | null {
  return (KNOWN_POKES as readonly string[]).includes(eventName) ? (eventName as Poke) : null
}

/**
 * Incremental `text/event-stream` parser. `push` is fed arbitrary byte-boundary
 * chunks (a decoded stream slice can split a line, or carry several events) and
 * returns the pokes for every event that *completed* in that chunk. Stateful: it
 * buffers a partial trailing line and the current event's `event:` field across
 * calls.
 *
 * Only what the poke channel actually uses is honored: the `event:` field names
 * the poke, a blank line dispatches it, and a comment line (`:` — the ~30s
 * heartbeat) is ignored. `data:` is present on the wire (a single non-informative
 * byte) but carries nothing, so its value is discarded; an event with no `event:`
 * field dispatches nothing.
 */
export class SseParser {
  private buffer = ''
  private eventName = ''

  push(chunk: string): Poke[] {
    this.buffer += chunk
    const pokes: Poke[] = []
    // Process only complete lines; keep the last (possibly partial) fragment.
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      // Strip a trailing CR so CRLF streams parse identically to LF ones.
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (line === '') {
        // End of an event: dispatch if it named a poke, then reset for the next.
        const poke = this.eventName ? asPoke(this.eventName) : null
        if (poke) pokes.push(poke)
        this.eventName = ''
        continue
      }
      if (line.startsWith(':')) continue // heartbeat / comment
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      // A value may have one leading space after the colon (SSE convention).
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') this.eventName = value
      // `data` (and any other field) is deliberately ignored: pokes are
      // payload-free, so only the event name matters.
    }
    return pokes
  }
}

/** Capped exponential reconnect backoff: 1s, 5s, 30s, then hold at 30s. A
 * dropped stream is expected (idle-timeout intermediaries, network blips), and
 * the poll timer covers the gap, so there is no need to reconnect aggressively. */
export const RECONNECT_BACKOFF_MS = [1000, 5000, 30_000]

export interface EventStreamOptions {
  /** Open a fresh authed streaming `GET /v0/events`. Called once per connection
   * attempt; must honor `signal` (abort tears the fetch down). */
  openStream: (signal: AbortSignal) => Promise<Response>
  /** Run the pull a poke names. Invoked per completed event. */
  onPoke: (poke: Poke) => void
  /** Optional connection-state hook (true on a live stream, false once it drops
   * before the next reconnect). Purely observational. */
  onConnected?: (connected: boolean) => void
  /** Aborting this stops the loop for good (lock/teardown). */
  signal: AbortSignal
  /** Injected for tests so backoff waits don't slow the suite; defaults to a
   * real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Overridable in tests. */
  backoffMs?: readonly number[]
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Run the push stream until `signal` aborts: open, read pokes, and on any drop
 * wait a backoff and reconnect. Resolves only once aborted. Never throws — a
 * connect/read failure is just a reason to reconnect, since the poll path
 * remains authoritative. A successful connection resets the backoff, so a stable
 * stream that occasionally drops always retries fast.
 */
export async function runEventStream(opts: EventStreamOptions): Promise<void> {
  const { openStream, onPoke, onConnected, signal } = opts
  const backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, signal))

  let attempt = 0
  while (!signal.aborted) {
    let connected = false
    try {
      const res = await openStream(signal)
      if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`)
      attempt = 0
      connected = true
      onConnected?.(true)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const poke of parser.push(decoder.decode(value, { stream: true }))) onPoke(poke)
      }
    } catch {
      // Swallow: aborted (intended stop) or a transport failure (reconnect).
    } finally {
      if (connected) onConnected?.(false)
    }

    if (signal.aborted) break
    await sleep(backoff[Math.min(attempt, backoff.length - 1)])
    attempt++
  }
}
