// A tiny bounded history of visited hashes so the header Back button can return
// to the previous screen. The hash router (router.svelte.ts) has no history of
// its own — Back was hard-wired to the dashboard. Kept pure (no runes, no
// window) so it is unit-testable in isolation.

// Cap the depth so a long session or a navigation loop can't grow it without
// bound; the oldest entries are the least likely to be wanted on Back.
const MAX_DEPTH = 50

export class NavStack {
  private stack: string[] = []

  /** Record a screen the user is leaving. Consecutive duplicates collapse. */
  push(hash: string): void {
    if (this.stack[this.stack.length - 1] === hash) return
    this.stack.push(hash)
    if (this.stack.length > MAX_DEPTH) this.stack.shift()
  }

  /** The previous screen, or undefined when there is nowhere to go back to. */
  pop(): string | undefined {
    return this.stack.pop()
  }

  get canGoBack(): boolean {
    return this.stack.length > 0
  }

  get size(): number {
    return this.stack.length
  }
}
