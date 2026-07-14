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
import { quantityOf, renderQuantity } from './timeline'
import type { StoredEvent } from './events'
import { isoToMillis } from './time'

export interface SummaryRow {
  /** `${kind}|${system}|${code}` — the folded clinical concept. For allergies
   * the coding is the substance from `value.coded` (the event's `code` is null
   * on import); uncoded entries fall back to their text value in the code slot
   * so distinct free-text meds don't collapse into one row. */
  key: string
  label: string
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

/** Fallback chain: coded display -> allergy substance display (both via the
 * coding's `display`) -> shortened system + code -> the humanized kind word.
 * Free text (a quick-logged med) slots in ahead of the bare kind so it stays
 * readable. Never blank. */
function labelFor(e: Ev): string {
  const coding = codingFor(e)
  if (coding?.display) return coding.display
  if (coding) return `${shortenSystem(coding.system)} ${coding.code}`
  const text = textOf(e)
  if (text) return text
  return e.kind.replace(/_/g, ' ')
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
    rows.push({
      key,
      label: labelFor(ls),
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
  opts: { hiddenIds?: Set<string>; resultLimit?: number } = {},
): ClinicianSummary {
  const { hiddenIds, resultLimit = 20 } = opts
  // Subtract hides before grouping; dropped silently — a clinical summary
  // shouldn't advertise redactions with a "hidden entry" placeholder.
  const evs = (hiddenIds ? events.filter((se) => !hiddenIds.has(se.event.id)) : events).map(
    (se) => se.event,
  )

  const conditions = evs.filter((e) => e.kind === 'condition')
  const meds = evs.filter((e) => e.kind === 'medication_statement')
  const allergyEvents = evs.filter((e) => e.kind === 'allergy_intolerance')
  const immunizations = evs.filter((e) => e.kind === 'immunization')
  const observations = evs.filter((e) => e.kind === 'observation')
  // Coded, non-vital observations: labs and the like. categorize() already
  // routes vitals to 'vital' and coded symptoms/mind to their own categories,
  // so 'clinical' is exactly the lab-result bucket.
  const results = observations.filter((e) => categorize(e) === 'clinical')

  return {
    problems: foldSection(conditions, 'earliest', () => '').sort(byDateDescNullLast),
    medications: foldSection(meds, 'latest', (ls) => quantityString(ls)).sort(byDateDescNullLast),
    allergies: foldSection(allergyEvents, 'latest', () => '').sort((a, b) => a.label.localeCompare(b.label)),
    immunizations: foldSection(immunizations, 'latest', (_ls, group) =>
      group.length > 1 ? `${group.length} doses` : '',
    ).sort(byDateDescNullLast),
    latestVitals: buildVitals(observations),
    recentResults: foldSection(results, 'latest', (ls) => quantityString(ls) || textOf(ls) || '')
      .sort(byDateDescNullLast)
      .slice(0, resultLimit),
  }
}
