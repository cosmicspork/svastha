// Derives the clinical-handoff shape (problems, meds, allergies, immunizations,
// latest vitals, recent results) from the local event store. Pure functions
// over StoredEvent[] — no db, session, or wasm imports, mirroring timeline.ts —
// so this same layer can later build the payload for a doctor-share feature.
//
// Unlike buildTimeline, this INCLUDES undated events: import frequently omits
// onset/medication dates, and a clinician summary that silently dropped those
// facts would be actively misleading. Undated rows sort last and render "date
// unknown".
import { VITALS, BP_SYSTOLIC, BP_DIASTOLIC, VITAL_LOINC_CODES, shortenSystem, type Code } from './codes'
import { categorize } from './category'
import { buildCodeNameIndex, resolveDisplay } from './code-names'
import { quantityOf, renderQuantity } from './timeline'
import { cycleStats, type CycleStats } from './cycle'
import type { StoredEvent } from './events'
import { isoToMillis } from './time'

/** The cycle section's shape: exactly {@link cycleStats}' non-null result. */
export type CycleSummary = CycleStats

export interface SummaryRow {
  /** `${kind}|${system}|${code}` — the folded clinical concept. For allergies
   * the coding is the substance from `value.coded` (the event's `code` is null
   * on import); uncoded entries fall back to their text value in the code slot
   * so distinct free-text meds don't collapse into one row. */
  key: string
  /** The primary display: a resolved name, free text, or — when a coded
   * concept resolved to nothing — the literal "Unnamed entry" (never the raw
   * code; see `coding` for that). */
  label: string
  /** The row's terminology coding — shortened system (via `shortenSystem`) and
   * code — present whenever the concept is coded, whether or not it resolved
   * to a name. Null for free-text and kind-word fallback rows, which have no
   * code to show. Carried as data so the view decides how prominently to show
   * it (demoted under a resolved name, or promoted next to "Unnamed entry"). */
  coding: { system: string; code: string } | null
  /** False exactly when `label` is the "Unnamed entry" placeholder — i.e. the
   * concept is coded but nothing (own display, vault index, dictionary) named
   * it. True for every other row, including free text and kind-word labels,
   * which are real labels even though they're not a resolved coded name. */
  nameResolved: boolean
  /** Formatted value / dose count / '' — the measurement or context the label
   * doesn't already carry. */
  detail: string
  /** Representative `effective_at` (earliest onset for problems, latest mention
   * elsewhere), or null when every folded event was undated. */
  date: string | null
  /** How many source events folded into this row. */
  count: number
  eventIds: string[]
}

export interface ClinicianSummary {
  problems: SummaryRow[]
  medications: SummaryRow[]
  allergies: SummaryRow[]
  immunizations: SummaryRow[]
  latestVitals: SummaryRow[]
  recentResults: SummaryRow[]
  /** Present iff the events carry cycle data. Because it derives from the same
   * events the section renders over, a share preview shows a cycle section
   * exactly when cycle was opted into the scope — no separate flag to keep in
   * sync, and no way for the preview to claim data the share won't carry. */
  cycle?: CycleSummary
}

type Ev = StoredEvent['event']

/** The coding that identifies an event's clinical concept: the event's own
 * `code`, or — for allergies, which import with `code: null` — the substance
 * carried in `value.coded`. */
function codingFor(e: Ev): Code | null {
  if (e.code) return e.code
  if (e.value && 'coded' in e.value) return e.value.coded
  return null
}

function textOf(e: Ev): string | null {
  return e.value && 'text' in e.value ? e.value.text : null
}

interface ResolvedLabel {
  label: string
  coding: { system: string; code: string } | null
  nameResolved: boolean
}

/** Fallback chain: coded display -> allergy substance display (both via the
 * coding's `display`) -> a display resolved from the same code elsewhere in
 * the vault (see code-names.ts) -> the offline dictionary -> "Unnamed entry",
 * with the coding carried alongside so the view can still show it. Free text
 * (a quick-logged med) slots in ahead of the bare kind so it stays readable.
 * Label is never blank. */
function resolveLabel(e: Ev, nameIndex: Map<string, string>, dictionary: Map<string, string>): ResolvedLabel {
  const coding = codingFor(e)
  if (coding) {
    const shortCoding = { system: shortenSystem(coding.system), code: coding.code }
    const display = coding.display ?? resolveDisplay(nameIndex, coding, dictionary)
    if (display) return { label: display, coding: shortCoding, nameResolved: true }
    return { label: 'Unnamed entry', coding: shortCoding, nameResolved: false }
  }
  const text = textOf(e)
  if (text) return { label: text, coding: null, nameResolved: true }
  return { label: e.kind.replace(/_/g, ' '), coding: null, nameResolved: true }
}

/** The grouping key. Uncoded entries key on their text so two distinct
 * free-text meds stay separate rows rather than folding into `kind||`. */
function keyFor(e: Ev): string {
  const coding = codingFor(e)
  const system = coding?.system ?? ''
  const code = coding?.code ?? textOf(e) ?? ''
  return `${e.kind}|${system}|${code}`
}

/** Ordering millis; undated ranks oldest so a dated event always wins the
 * "latest" comparisons (label source, representative date). */
function millis(e: Ev): number {
  return e.effective_at ? isoToMillis(e.effective_at) : -Infinity
}

function mostRecent(events: Ev[]): Ev | undefined {
  if (events.length === 0) return undefined
  return events.reduce((best, e) => (millis(e) > millis(best) ? e : best))
}

/** The event whose display sources the row's label: the most recently dated, on
 * the assumption a later document carries a better display. */
function labelSource(events: Ev[]): Ev {
  return mostRecent(events)!
}

function representativeDate(events: Ev[], strategy: 'earliest' | 'latest'): string | null {
  const dated = events.filter((e) => e.effective_at)
  if (dated.length === 0) return null
  const pick = dated.reduce((a, b) => {
    const cmp = isoToMillis(a.effective_at!) - isoToMillis(b.effective_at!)
    return (strategy === 'earliest' ? cmp <= 0 : cmp >= 0) ? a : b
  })
  return pick.effective_at
}

/** date desc, undated (null) last. */
function byDateDescNullLast(a: SummaryRow, b: SummaryRow): number {
  if (a.date === b.date) return 0
  if (a.date === null) return 1
  if (b.date === null) return -1
  return isoToMillis(b.date) - isoToMillis(a.date)
}

/** Fold a set of same-kind events into one row per clinical concept. */
function foldSection(
  events: Ev[],
  dateStrategy: 'earliest' | 'latest',
  detailFor: (labelEvent: Ev, group: Ev[]) => string,
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
): SummaryRow[] {
  const groups = new Map<string, Ev[]>()
  for (const e of events) {
    const key = keyFor(e)
    const group = groups.get(key) ?? []
    group.push(e)
    groups.set(key, group)
  }
  const rows: SummaryRow[] = []
  for (const [key, group] of groups) {
    const ls = labelSource(group)
    const resolved = resolveLabel(ls, nameIndex, dictionary)
    rows.push({
      key,
      label: resolved.label,
      coding: resolved.coding,
      nameResolved: resolved.nameResolved,
      detail: detailFor(ls, group),
      date: representativeDate(group, dateStrategy),
      count: group.length,
      eventIds: group.map((e) => e.id),
    })
  }
  return rows
}

function quantityString(e: Ev): string {
  const q = quantityOf(e)
  return q ? renderQuantity(q) : ''
}

/** One row per vital code, each showing that vital's single most-recent
 * reading. BP folds its systolic/diastolic pair (paired by shared
 * effective_at, as the spine does) into one "120/80" row. Rows stay in the
 * VITALS declaration order for stability. */
function buildVitals(observations: Ev[]): SummaryRow[] {
  const vitals = observations.filter((e) => e.code && VITAL_LOINC_CODES.has(e.code.code) && quantityOf(e))
  const byCode = new Map<string, Ev[]>()
  for (const e of vitals) {
    const code = e.code!.code
    const group = byCode.get(code) ?? []
    group.push(e)
    byCode.set(code, group)
  }

  const rows: SummaryRow[] = []
  for (const def of VITALS) {
    if (def.key === 'bp') {
      const sys = byCode.get(BP_SYSTOLIC.code) ?? []
      const dia = byCode.get(BP_DIASTOLIC.code) ?? []
      if (sys.length === 0 && dia.length === 0) continue
      const latestSys = mostRecent(sys)
      const pairedDia = latestSys
        ? dia.find((d) => d.effective_at === latestSys.effective_at)
        : mostRecent(dia)
      const sQ = latestSys ? quantityOf(latestSys) : null
      const dQ = pairedDia ? quantityOf(pairedDia) : null
      let detail = ''
      if (sQ && dQ) detail = `${sQ.value}/${dQ.value} ${sQ.unit}`.trim()
      else if (sQ) detail = renderQuantity(sQ)
      else if (dQ) detail = renderQuantity(dQ)
      const rep = latestSys ?? pairedDia
      rows.push({
        key: `observation|${BP_SYSTOLIC.system}|${BP_SYSTOLIC.code}`,
        label: 'Blood pressure',
        // The paired systolic/diastolic label is bespoke ("Blood pressure"),
        // not the systolic code's own display — no single coding identifies
        // it, so there's nothing accurate to show demoted beneath it.
        coding: null,
        nameResolved: true,
        detail,
        date: rep?.effective_at ?? null,
        count: sys.length + dia.length,
        eventIds: [...sys, ...dia].map((e) => e.id),
      })
    } else {
      const evs = byCode.get(def.loinc.code) ?? []
      if (evs.length === 0) continue
      const latest = mostRecent(evs)!
      rows.push({
        key: `observation|${def.loinc.system}|${def.loinc.code}`,
        label: def.label,
        coding: { system: shortenSystem(def.loinc.system), code: def.loinc.code },
        nameResolved: true,
        detail: quantityString(latest),
        date: latest.effective_at,
        count: evs.length,
        eventIds: evs.map((e) => e.id),
      })
    }
  }
  return rows
}

export function buildSummary(
  events: StoredEvent[],
  opts: { hiddenIds?: Set<string>; resultLimit?: number; dictionary?: Map<string, string> } = {},
): ClinicianSummary {
  // `dictionary`: the offline code dictionary (see dictionary.ts), hydrated once
  // and passed in. Empty by default, which makes its resolution layer a no-op.
  const { hiddenIds, resultLimit = 20, dictionary = new Map() } = opts
  // Subtract hides before grouping; dropped silently — a clinical summary
  // shouldn't advertise redactions with a "hidden entry" placeholder. The name
  // index is built from this same visible set, so a hidden event's display
  // can't leak into another row's label either.
  const visible = hiddenIds ? events.filter((se) => !hiddenIds.has(se.event.id)) : events
  const nameIndex = buildCodeNameIndex(visible)
  const evs = visible.map((se) => se.event)

  const conditions = evs.filter((e) => e.kind === 'condition')
  const meds = evs.filter((e) => e.kind === 'medication_statement')
  const allergyEvents = evs.filter((e) => e.kind === 'allergy_intolerance')
  const immunizations = evs.filter((e) => e.kind === 'immunization')
  const observations = evs.filter((e) => e.kind === 'observation')
  // Coded, non-vital observations: labs and the like. categorize() already
  // routes vitals to 'vital' and coded symptoms/mind to their own categories,
  // so 'clinical' is exactly the lab-result bucket.
  const results = observations.filter((e) => categorize(e) === 'clinical')

  // Undefined (not an empty object) when there are no cycle events, so the
  // section is absent — not a blank shell — from a share that didn't opt in.
  const cycle = cycleStats(visible) ?? undefined

  return {
    problems: foldSection(conditions, 'earliest', () => '', nameIndex, dictionary).sort(byDateDescNullLast),
    medications: foldSection(meds, 'latest', (ls) => quantityString(ls), nameIndex, dictionary).sort(
      byDateDescNullLast,
    ),
    allergies: foldSection(allergyEvents, 'latest', () => '', nameIndex, dictionary).sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
    immunizations: foldSection(
      immunizations,
      'latest',
      (_ls, group) => (group.length > 1 ? `${group.length} doses` : ''),
      nameIndex,
      dictionary,
    ).sort(byDateDescNullLast),
    latestVitals: buildVitals(observations),
    recentResults: foldSection(
      results,
      'latest',
      (ls) => quantityString(ls) || textOf(ls) || '',
      nameIndex,
      dictionary,
    )
      .sort(byDateDescNullLast)
      .slice(0, resultLimit),
    cycle,
  }
}
