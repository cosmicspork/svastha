import { describe, expect, it } from 'vitest'
import { SseParser, runEventStream, type Poke } from '../events-stream'

describe('SseParser', () => {
  it('parses a single named poke terminated by a blank line', () => {
    const p = new SseParser()
    expect(p.push('event: mailbox\ndata: x\n\n')).toEqual(['mailbox'])
  })

  it('ignores heartbeat comment lines', () => {
    const p = new SseParser()
    // A ~30s heartbeat is a bare `:` comment; it must yield no poke.
    expect(p.push(':\n')).toEqual([])
    expect(p.push(': keep-alive\n')).toEqual([])
    expect(p.push('event: blobs\ndata: 1\n\n')).toEqual(['blobs'])
  })

  it('reassembles an event split across chunk boundaries', () => {
    const p = new SseParser()
    expect(p.push('event: mail')).toEqual([])
    expect(p.push('box\nda')).toEqual([])
    expect(p.push('ta: x\n')).toEqual([])
    expect(p.push('\n')).toEqual(['mailbox'])
  })

  it('emits several pokes from one chunk', () => {
    const p = new SseParser()
    expect(p.push('event: blobs\ndata: 1\n\nevent: mailbox\ndata: 1\n\n')).toEqual([
      'blobs',
      'mailbox',
    ])
  })

  it('parses CRLF line endings identically to LF', () => {
    const p = new SseParser()
    expect(p.push('event: sync\r\ndata: 1\r\n\r\n')).toEqual(['sync'])
  })

  it('ignores an unrecognized event name (never coerced to sync)', () => {
    const p = new SseParser()
    expect(p.push('event: gossip\ndata: 1\n\n')).toEqual([])
  })

  it('dispatches nothing for an event that names no poke', () => {
    const p = new SseParser()
    // data with no `event:` field: not a poke.
    expect(p.push('data: 1\n\n')).toEqual([])
  })
})

/** A one-shot streaming `Response` over the given string chunks. Only the fields
 * runEventStream reads (`ok`, `status`, `body.getReader`) are provided. */
function streamOf(chunks: string[], ok = true, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return { ok, status, body } as unknown as Response
}

describe('runEventStream', () => {
  it('dispatches pokes and reconnects after the stream drops', async () => {
    const pokes: Poke[] = []
    const delays: number[] = []
    const controller = new AbortController()
    let opens = 0

    await runEventStream({
      openStream: async () => {
        opens++
        return streamOf(['event: mailbox\ndata: x\n\n'])
      },
      onPoke: (p) => {
        pokes.push(p)
        // Stop after the reconnect has proven itself (second connection).
        if (pokes.length >= 2) controller.abort()
      },
      signal: controller.signal,
      backoffMs: [10, 20, 30],
      sleep: async (ms) => void delays.push(ms),
    })

    expect(opens).toBe(2)
    expect(pokes).toEqual(['mailbox', 'mailbox'])
    // A successful connection resets the backoff, so each drop waits backoff[0].
    expect(delays).toEqual([10])
  })

  it('escalates the backoff while connections keep failing', async () => {
    const delays: number[] = []
    const controller = new AbortController()
    let opens = 0

    await runEventStream({
      openStream: async () => {
        opens++
        throw new Error('relay down')
      },
      onPoke: () => {},
      signal: controller.signal,
      backoffMs: [10, 20, 30],
      sleep: async (ms) => {
        delays.push(ms)
        if (delays.length >= 4) controller.abort()
      },
    })

    expect(opens).toBe(4)
    // 1s, 5s, 30s schedule shape: climb then hold at the ceiling.
    expect(delays).toEqual([10, 20, 30, 30])
  })

  it('treats a non-ok response as a failed connection and retries', async () => {
    const delays: number[] = []
    const controller = new AbortController()
    let opens = 0

    await runEventStream({
      openStream: async () => {
        opens++
        return streamOf([], false, 503)
      },
      onPoke: () => {},
      signal: controller.signal,
      backoffMs: [5],
      sleep: async () => {
        delays.push(1)
        if (delays.length >= 2) controller.abort()
      },
    })

    expect(opens).toBe(2)
  })

  it('does nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let opens = 0

    await runEventStream({
      openStream: async () => {
        opens++
        return streamOf([])
      },
      onPoke: () => {},
      signal: controller.signal,
      sleep: async () => {},
    })

    expect(opens).toBe(0)
  })

  it('reports connection state transitions', async () => {
    const states: boolean[] = []
    const controller = new AbortController()

    await runEventStream({
      openStream: async () => streamOf(['event: blobs\ndata: 1\n\n']),
      onPoke: () => {},
      onConnected: (c) => {
        states.push(c)
        if (!c) controller.abort()
      },
      signal: controller.signal,
      backoffMs: [1],
      sleep: async () => {},
    })

    expect(states).toEqual([true, false])
  })
})
