// Captured-document bytes: the storage side of paper records. One row per
// photographed page in the IndexedDB `attachments` store, keyed by the content
// hash of its plaintext bytes — exactly how `import.ts` keeps imported source
// documents in `provenance`. The bytes are at rest as plaintext (origin
// isolation + OS disk encryption are the boundary, same as the event log); the
// `att-` sync codec (see sync.ts) seals them under the vault key for transport.
//
// Downscaling lives here too: it normalizes whatever the camera/library hands
// us (including iOS HEIC) to a bounded JPEG before hashing, so every device that
// captures the same page from the same source produces the same content id.
import { get, put } from './db'
import type { CapturedPhoto } from './drafts'

/** One captured page as stored. `bytes` are the downscaled JPEG plaintext. */
export interface AttachmentRecord {
  sha256: string
  mime: string
  size: number
  bytes: Uint8Array
  capturedAt: string
}

/** Long-edge ceiling and JPEG quality for capture downscaling. ~2048px at
 * q0.82 keeps a full page legible while landing most photos at ~1–2 MB, well
 * under the relay's 16 MiB blob cap even after base64 + sealing overhead. */
export const MAX_EDGE_PX = 2048
export const JPEG_QUALITY = 0.82

/** Hard ceiling on a single page's plaintext bytes. The relay caps a blob body
 * at 16 MiB; base64 (~1.34×) plus the JSON envelope inflate the sealed form, so
 * bound the raw bytes with headroom. Downscaling keeps real captures far below
 * this — the guard only catches a pathological input, mirroring the doc- path's
 * reliance on the same relay cap. */
export const MAX_ATTACHMENT_BYTES = 11 * 1024 * 1024

/** Duplicated from import.ts's own `sha256Hex` (kept local to avoid an import
 * cycle, the same reason sync.ts duplicates it): lowercase-hex SHA-256 of the
 * plaintext bytes — the content address the `attachment` event value carries
 * and this store keys on. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Downscale a captured image file to a bounded JPEG. Draws through a canvas,
 * which also transcodes iOS HEIC to JPEG (the browser decodes HEIC into the
 * `ImageBitmap`, and we re-encode as JPEG). Returns the encoded bytes; the
 * caller hashes and stores them. Browser-only (needs `createImageBitmap` and a
 * canvas), so it is exercised by the capture flow, not unit tests.
 */
export async function downscaleToJpeg(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file)
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const scale = longEdge > MAX_EDGE_PX ? MAX_EDGE_PX / longEdge : 1
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas context.')
    ctx.drawImage(bitmap, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    )
    if (!blob) throw new Error('Could not encode the image.')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/** Store one captured page's bytes and return its content descriptor for the
 * event value. Content-addressed, so re-storing identical bytes is an idempotent
 * `put`. Throws if the bytes exceed {@link MAX_ATTACHMENT_BYTES}. */
export async function storeAttachment(
  bytes: Uint8Array,
  mime = 'image/jpeg',
): Promise<CapturedPhoto> {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('That image is too large to store — try a smaller photo.')
  }
  const sha256 = await sha256Hex(bytes)
  const record: AttachmentRecord = {
    sha256,
    mime,
    size: bytes.length,
    bytes,
    capturedAt: new Date().toISOString(),
  }
  await put('attachments', record)
  return { sha256, mime, size: bytes.length }
}

export function getAttachment(sha256: string): Promise<AttachmentRecord | undefined> {
  return get<AttachmentRecord>('attachments', sha256)
}

/** Bytes for one stored page, or null if this device doesn't hold them (e.g. a
 * synced event whose `att-` blob hasn't been pulled yet). */
export async function attachmentBytes(sha256: string): Promise<Uint8Array | null> {
  const record = await getAttachment(sha256)
  return record?.bytes ?? null
}
