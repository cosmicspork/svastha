import { describe, expect, it } from 'vitest'
import { FrameParser, pageFromResponse, type BatchBlob } from '../blob-batch'

// Local mirror of the relay's framing (`id_len u16 BE | id UTF-8 | blob_len u32
// BE | blob`) — deliberately independent of the parser under test, so a bug
// that flips both encode and decode the same way can't hide.
function encodeFrame(id: string, blob: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id)
  const out = new Uint8Array(2 + idBytes.length + 4 + blob.length)
  out[0] = (idBytes.length >>> 8) & 0xff
  out[1] = idBytes.length & 0xff
  out.set(idBytes, 2)
  const lenOffset = 2 + idBytes.length
  out[lenOffset] = (blob.length >>> 24) & 0xff
  out[lenOffset + 1] = (blob.length >>> 16) & 0xff
  out[lenOffset + 2] = (blob.length >>> 8) & 0xff
  out[lenOffset + 3] = blob.length & 0xff
  out.set(blob, lenOffset + 4)
  return out
}

function encodePage(frames: { id: string; blob: Uint8Array }[]): Uint8Array {
  const parts = frames.map((f) => encodeFrame(f.id, f.blob))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function blobOf(fill: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

const FRAMES = [
  { id: 'ev-a', blob: blobOf(1, 3) },
  { id: 'att-b', blob: blobOf(2, 0) },
  { id: 'cur-c', blob: blobOf(3, 500) },
]

describe('FrameParser', () => {
  it('parses a page fed as a single chunk', () => {
    const parser = new FrameParser()
    const out = parser.push(encodePage(FRAMES))
    parser.finish()
    expect(out).toHaveLength(3)
    expect(out.map((f) => f.id)).toEqual(['ev-a', 'att-b', 'cur-c'])
    expect(out[0].blob).toEqual(FRAMES[0].blob)
    expect(out[1].blob).toEqual(FRAMES[1].blob)
    expect(out[2].blob).toEqual(FRAMES[2].blob)
  })

  it('parses correctly when fed byte-by-byte', () => {
    const page = encodePage(FRAMES)
    const parser = new FrameParser()
    const out: BatchBlob[] = []
    for (let i = 0; i < page.length; i++) {
      out.push(...parser.push(page.subarray(i, i + 1)))
    }
    parser.finish()
    expect(out.map((f) => f.id)).toEqual(['ev-a', 'att-b', 'cur-c'])
    expect(out.map((f) => f.blob)).toEqual(FRAMES.map((f) => f.blob))
  })

  it('parses correctly across many random chunk splits', () => {
    const page = encodePage(FRAMES)
    for (let trial = 0; trial < 25; trial++) {
      const parser = new FrameParser()
      const out: BatchBlob[] = []
      let offset = 0
      while (offset < page.length) {
        const take = 1 + Math.floor(Math.random() * 7)
        const end = Math.min(offset + take, page.length)
        out.push(...parser.push(page.subarray(offset, end)))
        offset = end
      }
      parser.finish()
      expect(out.map((f) => f.id)).toEqual(['ev-a', 'att-b', 'cur-c'])
      expect(out.map((f) => f.blob)).toEqual(FRAMES.map((f) => f.blob))
    }
  })

  it('finish() throws on a truncated trailing frame', () => {
    const page = encodePage(FRAMES)
    const parser = new FrameParser()
    // Drop the final byte of the last frame's blob — a well-formed prefix
    // followed by a frame that never completes.
    parser.push(page.subarray(0, page.length - 1))
    expect(() => parser.finish()).toThrow(/truncated/)
  })

  it('finish() does not throw on a clean end (no carry-over)', () => {
    const parser = new FrameParser()
    parser.push(encodePage(FRAMES))
    expect(() => parser.finish()).not.toThrow()
  })

  it('rejects an absurd blob_len before allocating', () => {
    const idBytes = new TextEncoder().encode('ev-a')
    const header = new Uint8Array(2 + idBytes.length + 4)
    header[0] = (idBytes.length >>> 8) & 0xff
    header[1] = idBytes.length & 0xff
    header.set(idBytes, 2)
    const lenOffset = 2 + idBytes.length
    // 0xFFFFFFFF bytes — far past the 16 MiB cap; must reject on the length
    // prefix alone, never touching an allocation of that size.
    header[lenOffset] = 0xff
    header[lenOffset + 1] = 0xff
    header[lenOffset + 2] = 0xff
    header[lenOffset + 3] = 0xff

    const parser = new FrameParser()
    expect(() => parser.push(header)).toThrow(/blob_len/)
  })

  it('rejects id_len 0 and id_len over the 128-char cap', () => {
    const zero = new Uint8Array([0, 0])
    expect(() => new FrameParser().push(zero)).toThrow(/id_len/)

    const tooLong = new Uint8Array([0, 129])
    expect(() => new FrameParser().push(tooLong)).toThrow(/id_len/)
  })
})

describe('pageFromResponse', () => {
  it('returns unsupported for a non-octet-stream (JSON) response', () => {
    const res = new Response(JSON.stringify({ ids: ['ev-a'] }), {
      headers: { 'content-type': 'application/json' },
    })
    const page = pageFromResponse(res)
    expect(page.kind).toBe('unsupported')
  })

  it('reads svastha-next and streams frames from a ReadableStream body', async () => {
    const bytes = encodePage(FRAMES)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split into a few chunks to exercise the streaming path, not just a
        // single-shot body.
        const mid = Math.floor(bytes.length / 2)
        controller.enqueue(bytes.subarray(0, mid))
        controller.enqueue(bytes.subarray(mid))
        controller.close()
      },
    })
    const res = new Response(stream, {
      headers: { 'content-type': 'application/octet-stream', 'svastha-next': 'cur-c' },
    })

    const page = pageFromResponse(res)
    expect(page.kind).toBe('page')
    if (page.kind !== 'page') throw new Error('unreachable')
    expect(page.next).toBe('cur-c')

    const collected: BatchBlob[] = []
    for await (const frame of page.blobs) collected.push(frame)
    expect(collected.map((f) => f.id)).toEqual(['ev-a', 'att-b', 'cur-c'])
    expect(collected.map((f) => f.blob)).toEqual(FRAMES.map((f) => f.blob))
  })

  it('reports next: null when the header is absent (last page)', () => {
    // Same TS/DOM BodyInit cast the private `fetch` in relay.ts uses — a
    // Uint8Array is a valid Response body at runtime.
    const res = new Response(encodePage(FRAMES) as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    })
    const page = pageFromResponse(res)
    expect(page.kind).toBe('page')
    if (page.kind !== 'page') throw new Error('unreachable')
    expect(page.next).toBeNull()
  })

  it('falls back to arrayBuffer() when res.body is null (still parses)', async () => {
    // Some environments/mocks report a body-bearing Response without a
    // streamable `.body` (null) — the arrayBuffer() fallback must still work.
    const res = new Response(encodePage(FRAMES) as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    })
    Object.defineProperty(res, 'body', { value: null })

    const page = pageFromResponse(res)
    expect(page.kind).toBe('page')
    if (page.kind !== 'page') throw new Error('unreachable')
    const collected: BatchBlob[] = []
    for await (const frame of page.blobs) collected.push(frame)
    expect(collected.map((f) => f.id)).toEqual(['ev-a', 'att-b', 'cur-c'])
  })
})
