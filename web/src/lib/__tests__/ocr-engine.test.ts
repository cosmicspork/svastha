import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the module boundary is stubbed — 'tesseract.js' and './ocr-assets' —
// not any function inside ocr-engine.ts itself, so the test exercises the
// real worker-lifecycle code the fix touches.
vi.mock('../ocr-assets', () => ({
  assetsEnabled: vi.fn(async () => true),
  ASSET_BASE: '/ocr',
}))

vi.mock('tesseract.js', () => ({
  // Mirrors the shape of the real bug: tesseract.js's createWorker spawns its
  // Worker before it knows whether init will succeed (see getCore.js), then
  // rejects with a bare error on a bad path.
  createWorker: vi.fn(async () => {
    new Worker('data:application/javascript,')
    throw new Error('worker init failed')
  }),
}))

class FakeWorker {
  terminate = vi.fn()
  onerror: unknown
  constructor(..._args: unknown[]) {}
}

describe('recognizeImage', () => {
  let instances: FakeWorker[]

  beforeEach(() => {
    instances = []
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        constructor(...args: unknown[]) {
          super(...args)
          instances.push(this)
        }
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('terminates the worker tesseract.js spawned when init rejects, instead of leaking it', async () => {
    const { recognizeImage } = await import('../ocr-engine')

    await expect(recognizeImage(new Uint8Array([1, 2, 3]), 'image/png')).rejects.toThrow(
      'worker init failed',
    )

    expect(instances).toHaveLength(1)
    expect(instances[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('restores the real Worker constructor after init fails', async () => {
    const { recognizeImage } = await import('../ocr-engine')
    const realWorker = globalThis.Worker

    await expect(recognizeImage(new Uint8Array([1]), 'image/png')).rejects.toThrow()

    expect(globalThis.Worker).toBe(realWorker)
  })
})
