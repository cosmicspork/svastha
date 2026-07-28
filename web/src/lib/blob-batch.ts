// Parser for the relay's batched-blob framing (`GET /v0/blobs?include=body`
// and the shared equivalent): a repeated sequence of
// `id_len u16 BE | id UTF-8 | blob_len u32 BE | blob` frames with no envelope
// around the whole page. Pure leaf module — no imports from sync.ts/shared.ts
// or anything wasm-backed, so it's trivially unit-testable and importable from
// both.

/** One decoded frame: an id and its opaque (still-sealed) ciphertext. */
export interface BatchBlob {
  id: string
  blob: Uint8Array
}

/** Relay's `valid_id` caps ids at 128 chars; 0 is never issued. */
const MIN_ID_LEN = 1
const MAX_ID_LEN = 128

/** Relay's `auth::MAX_BODY` — a larger `blob_len` can only be a corrupt or
 * malicious frame, so it's rejected before the byte count is ever allocated. */
const MAX_BLOB_LEN = 16 * 1024 * 1024

const idDecoder = new TextDecoder()

function readU16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>>
    0
  )
}

/**
 * Incremental parser over the frame stream. A frame may split at any byte
 * boundary across chunks — that's the whole point, since `push` gets fed
 * straight from a `ReadableStream` reader with no control over chunk
 * boundaries — so each call buffers whatever trailing partial frame it saw
 * and only returns frames it could fully decode. `id_len`/`blob_len` are
 * validated as soon as their length-prefix bytes are available, before the id
 * or blob bytes (which might not have arrived yet) are ever allocated.
 */
export class FrameParser {
  private carry = new Uint8Array(0)

  push(chunk: Uint8Array): BatchBlob[] {
    // Fresh allocation, not a view onto `carry`/`chunk` — either may be a
    // pooled or soon-freed buffer the caller reuses right after this call.
    const buf = new Uint8Array(this.carry.length + chunk.length)
    buf.set(this.carry, 0)
    buf.set(chunk, this.carry.length)

    const out: BatchBlob[] = []
    let offset = 0
    for (;;) {
      if (buf.length - offset < 2) break
      const idLen = readU16be(buf, offset)
      if (idLen < MIN_ID_LEN || idLen > MAX_ID_LEN) {
        throw new Error(`blob-batch: invalid id_len ${idLen}`)
      }
      const idEnd = offset + 2 + idLen
      if (buf.length < idEnd + 4) break
      const blobLen = readU32be(buf, idEnd)
      if (blobLen > MAX_BLOB_LEN) {
        throw new Error(`blob-batch: invalid blob_len ${blobLen}`)
      }
      const blobEnd = idEnd + 4 + blobLen
      if (buf.length < blobEnd) break

      const id = idDecoder.decode(buf.subarray(offset + 2, idEnd))
      // `.slice` (copy), not `.subarray` (view) — nothing here should keep
      // `buf` (this push's full carry+chunk concatenation) alive past return.
      const blob = buf.slice(idEnd + 4, blobEnd)
      out.push({ id, blob })
      offset = blobEnd
    }

    this.carry = buf.slice(offset)
    return out
  }

  /** Call once the underlying stream has ended. A non-empty carry-over means
   * the last frame was cut off mid-way — corruption or a truncated response,
   * never a valid empty tail — so this throws rather than silently dropping
   * it. */
  finish(): void {
    if (this.carry.length > 0) {
      throw new Error('blob-batch: truncated trailing frame at end of stream')
    }
  }
}

/** The parsed shape of a batched blob-listing response: a page of frames plus
 * the opaque cursor for the next page (`null` = last page), or `'unsupported'`
 * when the relay answered the pre-batching JSON shape instead (older relay,
 * or `include=body` simply ignored). */
export type BlobBodyPage =
  | { kind: 'page'; next: string | null; blobs: AsyncIterable<BatchBlob> }
  | { kind: 'unsupported' }

const NEXT_HEADER = 'svastha-next'

/** Classify a `GET .../blobs?include=body` response and, if it's framed,
 * start streaming it. Never awaits the body itself here — that happens
 * lazily as the caller iterates `blobs`, so memory stays bounded to one frame
 * plus carry-over rather than the whole page. */
export function pageFromResponse(res: Response): BlobBodyPage {
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.startsWith('application/octet-stream')) {
    // Old relay (or `include` ignored) answering the JSON listing — release
    // the connection rather than leaving it open with nobody reading it.
    void res.body?.cancel()
    return { kind: 'unsupported' }
  }
  return { kind: 'page', next: res.headers.get(NEXT_HEADER), blobs: streamFrames(res) }
}

async function* streamFrames(res: Response): AsyncGenerator<BatchBlob> {
  const parser = new FrameParser()
  const reader = res.body?.getReader()
  if (!reader) {
    // No streaming body available in this environment — fall back to reading
    // it whole and running it through the same parser as a single chunk.
    yield* parser.push(new Uint8Array(await res.arrayBuffer()))
    parser.finish()
    return
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield* parser.push(value)
    }
    parser.finish()
  } finally {
    // Runs on early exit too (a caller breaking out of `for await` triggers
    // the generator's return): release the connection instead of leaving the
    // rest of the page streaming to nobody. No-op after a clean read-to-end.
    void reader.cancel().catch(() => {})
  }
}

/** Below this many missing ids, the per-id conditional-GET loop is cheaper
 * than a batch walk: a batch page ships every id it covers regardless of how
 * many are actually missing (byte-blind — the relay never inspects contents
 * to decide), so a small miss count doesn't earn back a page's own overhead.
 * 20 is a rough knee, not a measured constant; a `missing/total` ratio would
 * be a sharper (but pricier) refinement if this ever needs revisiting. */
export const BATCH_PULL_THRESHOLD = 20
