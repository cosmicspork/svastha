import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the module boundary is stubbed — 'tesseract.js' and './ocr-assets' —
// not any function inside ocr-engine.ts itself, so the test exercises the
// real worker-lifecycle code the fix touches.
vi.mock('../ocr-assets', () => ({
  assetsEnabled: vi.fn(async () => true),
  ASSET_BASE: '/ocr',
}))

// Each call's `createWorker()` spawns its own Worker synchronously (mirroring
// tesseract.js's real one — see getCore.js: spawnWorker runs before any
// await) and then hangs until the test releases it, so tests can control
// exactly when a given call's init settles relative to other JS running
// concurrently.
const releases: Array<(err: Error) => void> = []
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => {
    new Worker('data:application/javascript,')
    await new Promise<void>((_resolve, reject) => {
      releases.push(reject)
    })
  }),
}))

class FakeWorker {
  terminate = vi.fn()
  constructor(..._args: unknown[]) {}
}

/** Poll rather than count microtask ticks: the number of `await`s between a
 * `recognizeImage` call and its synchronous Worker-capture window is an
 * implementation detail this suite shouldn't have to track. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('waitFor: condition never became true')
}

describe('recognizeImage', () => {
  let instances: FakeWorker[]
  let RealWorker: typeof Worker
  // Every promise a test starts, so a test that asserts (and throws) before
  // releasing its own call doesn't leave a hung `await` in the mock bleeding
  // into the next test.
  let pending: Promise<unknown>[]

  beforeEach(() => {
    instances = []
    releases.length = 0
    pending = []
    RealWorker = class extends FakeWorker {
      constructor(...args: unknown[]) {
        super(...args)
        instances.push(this)
      }
    } as unknown as typeof Worker
    vi.stubGlobal('Worker', RealWorker)
  })

  afterEach(async () => {
    for (const release of releases) release(new Error('test cleanup'))
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 500))])
    vi.unstubAllGlobals()
  })

  it('terminates the worker tesseract.js spawned when init rejects, instead of leaking it', async () => {
    const { recognizeImage } = await import('../ocr-engine')

    const promise = recognizeImage(new Uint8Array([1, 2, 3]), 'image/png')
    pending.push(promise.catch(() => {}))
    await waitFor(() => releases.length >= 1)
    releases[0]!(new Error('worker init failed'))

    await expect(promise).rejects.toThrow('worker init failed')
    expect(instances).toHaveLength(1)
    expect(instances[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('restores the real Worker constructor after init fails', async () => {
    const { recognizeImage } = await import('../ocr-engine')

    const promise = recognizeImage(new Uint8Array([1]), 'image/png')
    pending.push(promise.catch(() => {}))
    await waitFor(() => releases.length >= 1)
    releases[0]!(new Error('worker init failed'))
    await expect(promise).rejects.toThrow()

    expect(globalThis.Worker).toBe(RealWorker)
  })

  // The capturing constructor used to stay installed for the entire awaited
  // createWorker() call, so anything else that spun up a Worker while init
  // was still pending — a pdf.js worker, say — got silently swept up and
  // terminated alongside a failed OCR init. Fixed by installing it only
  // around the synchronous call expression tesseract.js's spawnWorker runs
  // inside of.
  it('does not capture or terminate a worker created after createWorker returns its promise', async () => {
    const { recognizeImage } = await import('../ocr-engine')

    const promise = recognizeImage(new Uint8Array([1]), 'image/png')
    pending.push(promise.catch(() => {}))
    await waitFor(() => instances.length >= 1)
    // The synchronous window has closed by now, so the real constructor
    // must already be back in place.
    expect(globalThis.Worker).toBe(RealWorker)

    const unrelated = new globalThis.Worker('data:application/javascript,', {
      name: 'unrelated',
    }) as unknown as FakeWorker

    releases[0]!(new Error('worker init failed'))
    await expect(promise).rejects.toThrow('worker init failed')

    expect(instances).toHaveLength(2)
    expect(instances[0]?.terminate).toHaveBeenCalledOnce() // tesseract's own worker
    expect(unrelated.terminate).not.toHaveBeenCalled() // left alone
  })

  // Two overlapping reads must not let one call's capture window see the
  // other's worker, and settling them out of order must not leave a stale
  // proxy installed once both are done — resolving the *first* call last is
  // the case that exposes a leaked proxy: with a shared install window, its
  // `finally` is the last one to run and would restore to the *other* call's
  // (already-torn-down) proxy instead of the true original.
  it('keeps overlapping calls independent and restores the real constructor once both settle', async () => {
    const { recognizeImage } = await import('../ocr-engine')

    // Start the first call and let it reach its own pending (unresolved)
    // init before starting the second — both inits are then genuinely
    // in-flight at once, which is the scenario under test, without racing two
    // dynamic `import('tesseract.js')` calls against each other in the same
    // tick (a vitest module-mock resolution quirk, not a production concern).
    const p1 = recognizeImage(new Uint8Array([1]), 'image/png')
    pending.push(p1.catch(() => {}))
    await waitFor(() => instances.length >= 1)

    const p2 = recognizeImage(new Uint8Array([2]), 'image/png')
    pending.push(p2.catch(() => {}))
    await waitFor(() => instances.length >= 2)

    expect(releases).toHaveLength(2)
    // Both calls' synchronous windows have closed; nothing overlapping should
    // have left a proxy installed.
    expect(globalThis.Worker).toBe(RealWorker)

    // Settle the first call first, second call last.
    releases[0]!(new Error('first failed'))
    await expect(p1).rejects.toThrow('first failed')
    expect(instances[0]?.terminate).toHaveBeenCalledOnce()
    expect(instances[1]?.terminate).not.toHaveBeenCalled() // second call untouched

    releases[1]!(new Error('second failed'))
    await expect(p2).rejects.toThrow('second failed')
    expect(instances[1]?.terminate).toHaveBeenCalledOnce()

    expect(globalThis.Worker).toBe(RealWorker)
  })
})
