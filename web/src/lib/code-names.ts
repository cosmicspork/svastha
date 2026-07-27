// A render-time index of code -> display name, reused across the vault.
// `Code.display` is part of the signed canonical event content (see
// docs/ARCHITECTURE.md and codes.ts) — it is never rewritten on stored
// events. Import leaves it null on most coded events, but the same
// system|code is often named by a different source document elsewhere in the
// vault, so labels can borrow that name at render time without touching
// anything signed.
import { canonicalSystem, SYMPTOMS, type Code } from './codes'
import type { StoredEvent } from './events'

type Ev = StoredEvent['event']

/** The app's own name for each quick-log symptom code. These are the picker's
 * button labels (codes.ts `SymptomDef.label`) — this app's UI text, not
 * terminology content — so they stay available with the offline dictionary
 * switched off, which is the default. They also read better than the raw
 * preferred term for several concepts ("Shortness of breath", not "Dyspnea"). */
const SYMPTOM_LABELS: Map<string, string> = new Map(
  SYMPTOMS.map((s) => [`${canonicalSystem(s.snomed.system)}|${s.snomed.code}`, s.label]),
)

// Key by the canonical system so an OID-form coding (`urn:oid:…`) and its
// URL-form twin land on the same key — both when indexing the vault's own
// displays and when looking a code up against the offline dictionary (which is
// keyed by canonical `system|code`). The event's stored system is never
// changed; this is a lookup-key transform only.
function keyFor(code: Code): string {
  return `${canonicalSystem(code.system)}|${code.code}`
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

/** Look up a resolved display for a Code. Returns null when nothing names it —
 * callers should check the code's own `display` first, since a code's own
 * display always wins over a borrowed one.
 *
 * Priority after that: a name borrowed from the user's own records, then the
 * app's own label for a code it quick-logs, then the optional offline
 * dictionary (see dictionary.ts) — the generic reference name ranks last
 * because it is the least specific to this record. All of them beat the raw
 * "LOINC 39156-5" the callers render on a miss. */
export function resolveDisplay(
  index: Map<string, string>,
  code: Code | null | undefined,
  dictionary?: Map<string, string>,
): string | null {
  if (!code) return null
  const key = keyFor(code)
  return index.get(key) ?? SYMPTOM_LABELS.get(key) ?? dictionary?.get(key) ?? null
}
