// Clipboard hygiene for one-time secrets (seed phrases). Writes the text,
// then schedules a best-effort clear — this is convenience cleanup for while
// the page stays open, not a security boundary (an attacker with device
// access already has more direct routes to the phrase than the clipboard).
// The UI caption next to the copy button says this plainly.

let clearTimer: ReturnType<typeof setTimeout> | undefined

/** Copies `text` to the clipboard, then clears it after `clearAfterMs` if the
 * clipboard still holds exactly what we wrote and the page still has focus.
 * A second call before the delay elapses cancels the pending clear and
 * reschedules from the new copy. */
export async function copySensitive(text: string, clearAfterMs = 60_000): Promise<void> {
  await navigator.clipboard.writeText(text)

  if (clearTimer !== undefined) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = undefined
    void maybeClear(text)
  }, clearAfterMs)
}

async function maybeClear(text: string): Promise<void> {
  if (!document.hasFocus()) return
  try {
    // Reading back requires clipboard-read permission, which may be denied
    // or prompt-blocked by then — either way, just skip the clear.
    const current = await navigator.clipboard.readText()
    if (current !== text) return
    await navigator.clipboard.writeText('')
  } catch {
    // Permission denied, or the clipboard API misbehaved — nothing to do.
  }
}
