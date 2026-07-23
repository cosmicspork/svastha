import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, get } from '../db'
import { storeAttachment, attachmentBytes, MAX_ATTACHMENT_BYTES } from '../attachments'
import type { AttachmentRecord } from '../attachments'

// deleteDb() between tests so the module's memoized connection is closed and
// cleared — same pattern as db.test.ts / sync.test.ts.
beforeEach(deleteDb)

describe('storeAttachment', () => {
  it('preserves an application/pdf mime and size, keyed by the content hash', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]) // "%PDF-"
    const ref = await storeAttachment(bytes, 'application/pdf')

    expect(ref.mime).toBe('application/pdf')
    expect(ref.size).toBe(bytes.length)
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)

    const stored = await get<AttachmentRecord>('attachments', ref.sha256)
    expect(stored?.mime).toBe('application/pdf')
    expect(stored?.size).toBe(bytes.length)
    expect(stored?.bytes).toEqual(bytes)
  })

  it('defaults the mime to image/jpeg', async () => {
    const ref = await storeAttachment(new Uint8Array([255, 216, 255]))
    expect(ref.mime).toBe('image/jpeg')
  })

  it('throws (file-generic copy) when the bytes exceed the ceiling', async () => {
    const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    await expect(storeAttachment(tooBig, 'application/pdf')).rejects.toThrow(/too large to attach/)
  })

  it('is idempotent for identical bytes (same content id, one row)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const a = await storeAttachment(bytes, 'application/pdf')
    const b = await storeAttachment(bytes, 'application/pdf')

    expect(a.sha256).toBe(b.sha256)
    expect(await attachmentBytes(a.sha256)).toEqual(bytes)
  })
})
