import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copySensitive } from '../clipboard'

const PHRASE = 'autumn blanket cabin canyon cereal clutch'

let writeText: ReturnType<typeof vi.fn>
let readText: ReturnType<typeof vi.fn>

// Node's built-in `navigator` (unlike `document`, which vitest's node
// environment doesn't provide at all — see theme.test.ts) has no `clipboard`
// property to begin with, so it can just be assigned directly, same as
// install.test.ts does for `navigator.standalone`.
beforeEach(() => {
  vi.useFakeTimers()
  writeText = vi.fn().mockResolvedValue(undefined)
  readText = vi.fn().mockResolvedValue(PHRASE)
  ;(navigator as { clipboard?: unknown }).clipboard = { writeText, readText }
  ;(globalThis as { document?: { hasFocus: () => boolean } }).document = {
    hasFocus: () => true,
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (navigator as { clipboard?: unknown }).clipboard
  delete (globalThis as { document?: unknown }).document
})

describe('copySensitive', () => {
  it('writes the phrase to the clipboard', async () => {
    await copySensitive(PHRASE)
    expect(writeText).toHaveBeenCalledWith(PHRASE)
  })

  it('clears the clipboard after the delay if it still holds the phrase', async () => {
    await copySensitive(PHRASE)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writeText).toHaveBeenLastCalledWith('')
  })

  it('leaves the clipboard alone if its content changed in the meantime', async () => {
    await copySensitive(PHRASE)
    readText.mockResolvedValue('something else the user copied since')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writeText).toHaveBeenCalledTimes(1) // only the initial write — no clear
  })

  it('does not clear while the page lacks focus', async () => {
    await copySensitive(PHRASE)
    ;(globalThis as { document: { hasFocus: () => boolean } }).document.hasFocus = () => false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('reschedules on a second call, cancelling the first clear', async () => {
    await copySensitive(PHRASE)
    await vi.advanceTimersByTimeAsync(30_000) // first timer at 30s of 60s — not due yet
    await copySensitive(PHRASE) // resets the window
    await vi.advanceTimersByTimeAsync(30_000) // 60s since the first call, 30s since the second
    expect(writeText).toHaveBeenCalledTimes(2) // two writes of PHRASE, no clear — first timer was cancelled
    await vi.advanceTimersByTimeAsync(30_000) // 60s since the second call
    expect(writeText).toHaveBeenLastCalledWith('')
  })
})
