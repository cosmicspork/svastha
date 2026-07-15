// A render-time index of code -> display name, reused across the vault.
// `Code.display` is part of the signed canonical event content (see
// docs/ARCHITECTURE.md and codes.ts) — it is never rewritten on stored
// events. Import leaves it null on most coded events, but the same
// system|code is often named by a different source document elsewhere in the
// vault, so labels can borrow that name at render time without touching
// anything signed.
import type { Code } from './codes'
import type { StoredEvent } from './events'

type Ev = StoredEvent['event']

function keyFor(code: Code): string {
  return `${code.system}|${code.code}`
}

/** Every Code an event carries that's worth indexing: its own `code`, and —
 * for coded values (symptom severities, allergy substances, and the like) —
 * the value's coding too. Either can independently carry a display. */
function codesOf(e: Ev): Code[] {
  const codes: Code[] = []
  if (e.code) codes.push(e.code)
  if (e.value && 'coded' in e.value) codes.push(e.value.coded)
  return codes
}

/** `system|code` -> the best display name seen for it anywhere in `events`.
 * A code with no display-bearing occurrence has no entry (callers fall back
 * to their existing raw-code/kind label).
 *
 * When a code carries more than one distinct display — different source
 * documents naming it differently — the most frequent wins; ties break
 * shortest-then-lexicographic, since the longer variant is typically a more
 * verbose source-system rendering (e.g. "Body mass index (BMI) [Ratio]" vs.
 * "BMI"). The tie-break is independent of input order, so the result is
 * deterministic regardless of how `events` is sorted. */
export function buildCodeNameIndex(events: StoredEvent[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const { event } of events) {
    for (const code of codesOf(event)) {
      if (!code.display) continue
      const key = keyFor(code)
      const byDisplay = counts.get(key) ?? new Map<string, number>()
      byDisplay.set(code.display, (byDisplay.get(code.display) ?? 0) + 1)
      counts.set(key, byDisplay)
    }
  }

  const index = new Map<string, string>()
  for (const [key, byDisplay] of counts) {
    const [[bestDisplay]] = [...byDisplay.entries()].sort(([aDisplay, aCount], [bDisplay, bCount]) => {
      if (aCount !== bCount) return bCount - aCount
      if (aDisplay.length !== bDisplay.length) return aDisplay.length - bDisplay.length
      // Plain code-point order, not localeCompare — deterministic across
      // environments/locales rather than merely "reads right" in one.
      return aDisplay < bDisplay ? -1 : aDisplay > bDisplay ? 1 : 0
    })
    index.set(key, bestDisplay)
  }
  return index
}

/** Look up a resolved display for a Code. Returns null when the index has
 * nothing for it — callers should check the code's own `display` first,
 * since a code's own display always wins over a borrowed one. */
export function resolveDisplay(index: Map<string, string>, code: Code | null | undefined): string | null {
  if (!code) return null
  return index.get(keyFor(code)) ?? null
}
