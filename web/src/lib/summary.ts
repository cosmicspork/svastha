// Derives the clinical-handoff shape (problems, meds, allergies, immunizations,
// latest vitals, recent results) from the local event store. Pure functions
// over StoredEvent[] — no db, session, or wasm imports, mirroring timeline.ts —
// so this same layer can later build the payload for a doctor-share feature.
//
// Unlike buildTimeline, this INCLUDES undated events: import frequently omits
// onset/medication dates, and a clinician summary that silently dropped those
// facts would be actively misleading. Undated rows sort last and render "date
// unknown".
//
// Immunizations, vitals, and results are split around a recency window (see
// RECENT_WINDOW_MONTHS) rather than filtered by it — same reason: the older
// rows stay in the payload, the view just doesn't lead with them.
import {
  VITALS,
  BP_SYSTOLIC,
  BP_DIASTOLIC,
  VITAL_LOINC_CODES,
  LOINC,
  OCCUPATION,
  OCCUPATIONAL_HAZARD,
  OCCUPATION_INDUSTRY,
  VALUE_KEYED_LOINC_CODES,
  shortenSystem,
  type Code,
} from './codes'
import { categorize } from './category'
import { buildCodeNameIndex, resolveDisplay } from './code-names'
import { quantityOf, renderQuantity } from './timeline'
import { cycleStats, type CycleStats } from './cycle'
import type { StoredEvent } from './events'
import {
  REGIMEN_ROUTES,
  hiddenConceptsFrom,
  type ConceptPriority,
  type ConceptStatus,
  type Regimen,
  type RegimenRoute,
} from './curation'
import { isoToMillis } from './time'

/** The cycle section's shape: exactly {@link cycleStats}' non-null result. */
export type CycleSummary = CycleStats

/** How far back the windowed sections (immunizations, vitals, results) reach
 * before a row is demoted to `older`. A visit asks "what's happened lately";
 * a decade of flu shots and old lab panels buries the answer. Nothing is
 * dropped — `older` still carries every row, one tap away. */
export const RECENT_WINDOW_MONTHS = 12

/** A section split around {@link RECENT_WINDOW_MONTHS}. `older` holds the rows
 * outside the window *and* every undated row: an undated fact cannot be shown
 * to be recent, and presenting it as such would be a claim the data doesn't
 * support. */
export interface WindowedSection {
  recent: SummaryRow[]
  older: SummaryRow[]
}

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
  /** Formatted value / dose / dose count / '' — the measurement or context the
   * label doesn't already carry. For a medication this is the owner's curated
   * regimen dose if there is one, else the recorded dose quantity (see
   * `medicationDose`); the strength baked into a drug name stays in the label,
   * never re-derived here. */
  detail: string
  /** Representative `effective_at` (earliest onset for problems, latest mention
   * elsewhere), or null when every folded event was undated. */
  date: string | null
  /** How many source events folded into this row. */
  count: number
  eventIds: string[]
  /** The single event this row stands for — the one whose `effective_at` is
   * `date` (or, when the whole group is undated, the one that named the row).
   * "See on timeline" focuses this id, so the spine lands on the mention the
   * summary is actually showing rather than an arbitrary member of the fold. */
  focusId: string
  /** The owner's curated lifecycle for this concept (see curation.ts's
   * `status:` namespace), `'active'` by default. Only the meds and problems
   * sections split on it (current/past, active/resolved); it is `'active'` and
   * inert elsewhere. A read-only (recipient) render leaves it `'active'` — the
   * owner's curation is owner-only in v1. */
  status: ConceptStatus
  /** The owner's curated regimen for this concept (see curation.ts's `regimen:`
   * namespace), absent when there is none. Only medication rows are expected to
   * carry one; elsewhere it is inert data the view simply never renders. */
  regimen?: Regimen
  /** Whether the owner pinned this concept (curation.ts's `priority:`). Only
   * problems and allergies are reordered on it; elsewhere it is inert. */
  pinned: boolean
  /** A short status chip beside the label ("current" / "past"). Work rows only. */
  chip?: string
  /** A quiet second line under the label; takes the place of the regimen line.
   * Work rows only (a job's exposures). */
  subline?: string
  /** Suppress the trailing full date. A job's `date` is a start year in
   * practice, and "Jan 1, 2019" would claim a precision nobody gave. */
  hideDate?: boolean
}

export interface ClinicianSummary {
  problems: SummaryRow[]
  /** Alphabetical, not newest-first: in a visit the name is what you're
   * looking up, and a med list you can't scan by name is a list you have to
   * read end to end. */
  medications: SummaryRow[]
  allergies: SummaryRow[]
  /** The problems and allergies the owner hid (curation.ts's `priority:`),
   * folded so the owner's "N hidden · manage" list can name them. They are in
   * no other section. A hidden concept of another kind is dropped the same way
   * but listed nowhere: this build offers the control on these two only. A
   * recipient's render has none to list — see doctorShare.ts's
   * `shareableEvents` and `curationForBundle`. */
  hidden: { problems: SummaryRow[]; allergies: SummaryRow[] }
  immunizations: WindowedSection
  latestVitals: WindowedSection
  recentResults: WindowedSection
  /** One row per job (exposures folded into its sub-line), plus a row per
   * exposure that matches no job. Empty when there is no work history. */
  work: SummaryRow[]
  /** The window the three sections above were split on, so the view can name
   * it ("older than 12 months") without hardcoding the same number twice. */
  windowMonths: number
  /** Present iff the events carry cycle data. Because it derives from the same
   * events the section renders over, a share preview shows a cycle section
   * exactly when cycle was opted into the scope — no separate flag to keep in
   * sync, and no way for the preview to claim data the share won't carry. */
  cycle?: CycleSummary
}

/** One route's current medications, in the order they arrived. */
export interface MedShelf {
  route: RegimenRoute
  rows: SummaryRow[]
}

/** The medications page's grouping of {@link ClinicianSummary.medications}. */
export interface MedShelves {
  /** Current meds with no curated route. They lead the page rather than
   * trailing it: a route is only ever set by hand, so an unrouted med is the
   * one asking for attention, not the leftover. */
  unrouted: SummaryRow[]
  /** Non-empty shelves only, in {@link REGIMEN_ROUTES} order. */
  shelves: MedShelf[]
  past: SummaryRow[]
}

/**
 * Group medication rows into the page's route shelves.
 *
 * Shelving reads `regimen.route` and nothing else — route and form are never
 * parsed out of a drug name (see `medicationDose`'s stance on strengths), so a
 * med nobody has filed stays honestly unfiled instead of being guessed onto a
 * shelf.
 *
 * Order in equals order out within every bucket: rows arrive `byLabel`-sorted
 * from `buildSummary`, so each shelf is alphabetical without re-sorting here.
 * "As needed" is a property of a current med, never a bucket of its own — a PRN
 * med stays on its route shelf and out of `past`.
 */
export function shelveMedications(rows: SummaryRow[]): MedShelves {
  const unrouted: SummaryRow[] = []
  const past: SummaryRow[] = []
  const byRoute = new Map<RegimenRoute, SummaryRow[]>()
  for (const row of rows) {
    if (row.status === 'inactive') {
      past.push(row)
      continue
    }
    const route = row.regimen?.route
    if (route === undefined) {
      unrouted.push(row)
      continue
    }
    const shelf = byRoute.get(route)
    if (shelf) shelf.push(row)
    else byRoute.set(route, [row])
  }
  const shelves: MedShelf[] = []
  for (const route of REGIMEN_ROUTES) {
    const shelfRows = byRoute.get(route)
    if (shelfRows) shelves.push({ route, rows: shelfRows })
  }
  return { unrouted, shelves, past }
}

/** The Problems section's two lists: the main one and the collapsed
 * "resolved" group. A pinned problem stays in the main list whatever its
 * status — the owner pinned it because it matters at a visit, and behind "Show
 * 3 resolved" it would be the one thing nobody opens — and the view marks it
 * resolved there with a chip. Order in equals order out, so pinned rows still
 * lead `active`. */
export function splitProblems(rows: SummaryRow[]): { active: SummaryRow[]; resolved: SummaryRow[] } {
  const active: SummaryRow[] = []
  const resolved: SummaryRow[] = []
  for (const row of rows) {
    if (row.status === 'active' || row.pinned) active.push(row)
    else resolved.push(row)
  }
  return { active, resolved }
}

type Ev = StoredEvent['event']

/** The coding that identifies an event's clinical concept: the event's own
 * `code`, or — for allergies, which import with `code: null` — the substance
 * carried in `value.coded`. */
function codingFor(e: Keyed): Code | null {
  if (e.code) return e.code
  if (e.value && 'coded' in e.value) return e.value.coded
  return null
}

function textOf(e: Keyed): string | null {
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

/** The slice of an event the concept key reads, so a form can compute the key
 * of a draft it has not signed yet. */
type Keyed = { kind: Ev['kind']; code?: Code | null; value?: Ev['value'] }

/** The value half of a work concept key, or null when the event is not a
 * value-keyed work observation (every other event, which keeps its existing
 * key unchanged). Every job shares LOINC 11341-5 and every hazard 87729-0, so
 * these two codes alone key on their value:
 *
 *   text value  -> `text:<value as written>`
 *   coded value -> `coded:<system>|<code>`, each part percent-encoded
 *
 * The tag keeps a text value from imitating a coded one, and the encoding
 * keeps a `|` inside a system or code from shifting the split. The text is the
 * last field, so it needs no escaping. Like a free-text med it is compared as
 * written (no trim, no case fold); the log form trims before it saves. Any
 * other value shape (or none) adds nothing, so those events fold by code. */
function workValueKey(e: Keyed): string | null {
  if (!e.code || e.code.system !== LOINC || !VALUE_KEYED_LOINC_CODES.has(e.code.code)) return null
  if (e.value && 'text' in e.value) return `text:${e.value.text}`
  if (e.value && 'coded' in e.value) {
    const { system, code } = e.value.coded
    return `coded:${encodeURIComponent(system)}|${encodeURIComponent(code)}`
  }
  return null
}

/** The grouping key. Uncoded entries key on their text so two distinct
 * free-text meds stay separate rows rather than folding into `kind||`. */
function keyFor(e: Keyed): string {
  const coding = codingFor(e)
  const system = coding?.system ?? ''
  const code = coding?.code ?? textOf(e) ?? ''
  const valueKey = workValueKey(e)
  return valueKey === null ? `${e.kind}|${system}|${code}` : `${e.kind}|${system}|${code}|${valueKey}`
}

/** The folded clinical-concept key of one event — the same `${kind}|${system}
 * |${code}` the summary groups on and the `status:`/`name:` curation namespaces
 * key against (plus the value suffix of {@link workValueKey} for jobs and
 * occupational hazards). Exported so the doctor-share builder can decide which
 * of the owner's status/name records apply to a given bundle of events without
 * duplicating this grouping rule. */
export function conceptKey(event: Keyed): string {
  return keyFor(event)
}

/** Drop every event of a hidden concept (curation.ts's `priority:` hide). The
 * one rule the summary and the doctor-share sheet both apply, so the owner's
 * summary, the share preview, and the bundle agree on what a hide removes. */
export function withoutHiddenConcepts(events: StoredEvent[], hiddenConcepts: Set<string>): StoredEvent[] {
  if (hiddenConcepts.size === 0) return events
  return events.filter((se) => !hiddenConcepts.has(keyFor(se.event)))
}

/** The distinct concept keys present across a set of events — the intersection
 * target when selecting which `status:`/`name:` curation records a share bundle
 * should carry. */
export function conceptKeysForEvents(events: StoredEvent[]): Set<string> {
  return new Set(events.map((se) => keyFor(se.event)))
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

/** The event a row stands for: earliest onset for problems, latest mention
 * elsewhere. Null when every folded event was undated. */
function representative(events: Ev[], strategy: 'earliest' | 'latest'): Ev | null {
  const dated = events.filter((e) => e.effective_at)
  if (dated.length === 0) return null
  return dated.reduce((a, b) => {
    const cmp = isoToMillis(a.effective_at!) - isoToMillis(b.effective_at!)
    return (strategy === 'earliest' ? cmp <= 0 : cmp >= 0) ? a : b
  })
}

function byDateDescNullLast(a: SummaryRow, b: SummaryRow): number {
  if (a.date === b.date) return 0
  if (a.date === null) return 1
  if (b.date === null) return -1
  return isoToMillis(b.date) - isoToMillis(a.date)
}

/** Name order, case- and accent-insensitive, with the date as a stable
 * tie-break so two same-named concepts keep a deterministic order. */
function byLabel(a: SummaryRow, b: SummaryRow): number {
  return (
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || byDateDescNullLast(a, b)
  )
}

/** Pinned rows first, each group keeping the order it arrived in — so pinned
 * problems stay newest-first among themselves and pinned allergies stay
 * alphabetical. */
function pinnedFirst(rows: SummaryRow[]): SummaryRow[] {
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)]
}

/** The start of the recency window: `months` before `nowMs`. Month arithmetic,
 * not a 365-day approximation, so "the last 12 months" means the same calendar
 * date a year ago however the leap years fall. */
function windowStartMillis(nowMs: number, months: number): number {
  const d = new Date(nowMs)
  d.setMonth(d.getMonth() - months)
  return d.getTime()
}

/** Split rows around the window cutoff, preserving each bucket's incoming
 * order. Undated rows land in `older` — see {@link WindowedSection}. */
function splitByWindow(rows: SummaryRow[], cutoffMillis: number): WindowedSection {
  const recent: SummaryRow[] = []
  const older: SummaryRow[] = []
  for (const row of rows) {
    if (row.date !== null && isoToMillis(row.date) >= cutoffMillis) recent.push(row)
    else older.push(row)
  }
  return { recent, older }
}

/** Curation layered over the folded concepts: the owner's per-concept status,
 * display-name overrides, medication regimens, and priorities (see curation.ts's
 * `status:`/`name:`/`regimen:`/`priority:` namespaces), keyed on the same
 * `${kind}|${system}|${code}` as {@link keyFor}. */
interface Curation {
  status: Map<string, ConceptStatus>
  names: Map<string, string>
  regimen: Map<string, Regimen>
  priority: Map<string, ConceptPriority>
}

/** Fold a set of same-kind events into one row per clinical concept. */
function foldSection(
  events: Ev[],
  dateStrategy: 'earliest' | 'latest',
  detailFor: (labelEvent: Ev, group: Ev[]) => string,
  nameIndex: Map<string, string>,
  dictionary: Map<string, string>,
  curation: Curation,
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
    const rep = representative(group, dateStrategy)
    const resolved = resolveLabel(ls, nameIndex, dictionary)
    // The owner's name override is the top of the render-time name chain (above
    // the event's own display, the vault index, and the dictionary — see
    // code-names.ts). It always resolves the name, and the coding stays carried
    // so the demoted code line remains visible under the override.
    const override = curation.names.get(key)
    const named = override ? { label: override, coding: resolved.coding, nameResolved: true } : resolved
    rows.push({
      key,
      label: named.label,
      coding: named.coding,
      nameResolved: named.nameResolved,
      detail: detailFor(ls, group),
      date: rep?.effective_at ?? null,
      count: group.length,
      eventIds: group.map((e) => e.id),
      focusId: (rep ?? ls).id,
      status: curation.status.get(key) ?? 'active',
      regimen: curation.regimen.get(key),
      pinned: curation.priority.get(key) === 'pinned',
    })
  }
  return rows
}

function quantityString(e: Ev): string {
  const q = quantityOf(e)
  return q ? renderQuantity(q) : ''
}

/** A medication row's dose: the most recent dose quantity anywhere in the fold,
 * not just on the event that happened to name the row. Sources are uneven — a
 * later refill often arrives as a bare coded statement with no doseQuantity —
 * and reading only the label source dropped a dose the record plainly holds.
 *
 * Nothing is parsed out of the *name*: an RxNorm display carries its strength
 * verbatim ("Amoxicillin 400 MG/5 ML Suspension"), and splitting a strength out
 * of one would sooner or later print "400 MG" for a per-5-mL concentration.
 * The name keeps its strength; this slot carries only what the source recorded
 * as a dose. */
function medicationDose(group: Ev[]): string {
  const dosed = group.filter((e) => quantityOf(e))
  const latest = mostRecent(dosed)
  return latest ? quantityString(latest) : ''
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
      const rep = (latestSys ?? pairedDia)!
      rows.push({
        key: `observation|${BP_SYSTOLIC.system}|${BP_SYSTOLIC.code}`,
        label: 'Blood pressure',
        // The paired systolic/diastolic label is bespoke ("Blood pressure"),
        // not the systolic code's own display — no single coding identifies
        // it, so there's nothing accurate to show demoted beneath it.
        coding: null,
        nameResolved: true,
        detail,
        date: rep.effective_at,
        count: sys.length + dia.length,
        eventIds: [...sys, ...dia].map((e) => e.id),
        focusId: rep.id,
        status: 'active',
        pinned: false,
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
        focusId: latest.id,
        status: 'active',
        pinned: false,
      })
    }
  }
  return rows
}

/** The year a start date was written in. Read from the string, not through
 * `Date`, so a local-offset ISO from `toLocalIso` cannot slide a year in a
 * timezone west of UTC (same reason `fmtDate` slices). */
function startYear(iso: string | null): string {
  return iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : ''
}

/** Jobs and occupational exposures as summary rows.
 *
 * A job is an 11341-5 observation, an exposure an 87729-0 observation, and an
 * exposure belongs to the job it shares an `effective_at` with (the multi-part
 * convention: one event per component, one timestamp). A job logged more than
 * once folds by its text, like any concept; it owns every timestamp it was
 * logged at. An exposure that matches no job (undated, or dated differently)
 * keeps a row of its own so it is never silently dropped.
 *
 * Industry (86188-0), which only import writes, attaches to a job by the same
 * shared effective_at and leads its sub-line ("Hospitals · needlesticks, night
 * shifts"). It is not an exposure, so an industry matching no job is left off
 * the summary rather than given a row of its own. */
function buildWork(observations: Ev[], curation: Curation): SummaryRow[] {
  const isCode = (e: Ev, c: Code) => e.code?.system === c.system && e.code.code === c.code
  const jobs = observations.filter((e) => isCode(e, OCCUPATION))
  const hazards = observations.filter((e) => isCode(e, OCCUPATIONAL_HAZARD))
  const industries = observations.filter((e) => isCode(e, OCCUPATION_INDUSTRY))

  const chipFor = (key: string) => (curation.status.get(key) === 'inactive' ? 'past' : 'current')
  const rowFor = (key: string, group: Ev[], subline: string): SummaryRow => {
    const ls = labelSource(group)
    const rep = representative(group, 'earliest')
    const override = curation.names.get(key)
    // Not resolveLabel: the event's own code display is the generic "History of
    // Occupation", and the value is the substance.
    const coded = ls.value && 'coded' in ls.value ? ls.value.coded.display : undefined
    const year = startYear(rep?.effective_at ?? null)
    return {
      key,
      label: override || textOf(ls) || coded || 'Unnamed entry',
      // The LOINC code is the category's plumbing, not something to show.
      coding: null,
      nameResolved: true,
      detail: year ? `since ${year}` : '',
      date: rep?.effective_at ?? null,
      count: group.length,
      eventIds: group.map((e) => e.id),
      focusId: (rep ?? ls).id,
      status: curation.status.get(key) ?? 'active',
      // Work rows take no priority controls yet (D1 covers problems and
      // allergies), so a job is never pinned.
      pinned: false,
      chip: chipFor(key),
      subline,
      hideDate: true,
    }
  }

  const jobGroups = new Map<string, Ev[]>()
  for (const e of jobs) {
    const key = keyFor(e)
    jobGroups.set(key, [...(jobGroups.get(key) ?? []), e])
  }
  const jobTimes = new Map<string, Set<string>>()
  for (const [key, group] of jobGroups) {
    jobTimes.set(key, new Set(group.flatMap((e) => (e.effective_at ? [e.effective_at] : []))))
  }
  const claimed = new Set<string>()
  for (const times of jobTimes.values()) for (const t of times) claimed.add(t)

  const exposureNames = (evs: Ev[]): string[] =>
    [...new Set(evs.map((e) => textOf(e)?.trim()).filter((t): t is string => !!t))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )

  // A coded industry is shown by its display; one without a display has no words to show.
  const industryNames = (evs: Ev[]): string[] =>
    [
      ...new Set(
        evs.map((e) => (e.value && 'coded' in e.value ? e.value.coded.display : textOf(e))?.trim()).filter((t): t is string => !!t),
      ),
    ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  const rows: SummaryRow[] = []
  for (const [key, group] of jobGroups) {
    const times = jobTimes.get(key)!
    const attached = hazards.filter((h) => h.effective_at && times.has(h.effective_at))
    const industry = industryNames(industries.filter((i) => i.effective_at && times.has(i.effective_at)))
    const subline = [industry.join(' / '), exposureNames(attached).join(', ')].filter(Boolean).join(' · ')
    rows.push(rowFor(key, group, subline))
  }
  rows.sort(byDateDescNullLast)

  const orphans = new Map<string, Ev[]>()
  for (const h of hazards) {
    if (h.effective_at && claimed.has(h.effective_at)) continue
    const key = keyFor(h)
    orphans.set(key, [...(orphans.get(key) ?? []), h])
  }
  const orphanRows = [...orphans].map(([key, group]) => rowFor(key, group, '')).sort(byLabel)
  return [...rows, ...orphanRows]
}

/** Cap each bucket separately: a windowed section that shared one limit would
 * let a long recent list swallow the older one's entire allowance. */
function limitBoth(section: WindowedSection, limit: number): WindowedSection {
  return { recent: section.recent.slice(0, limit), older: section.older.slice(0, limit) }
}

export function buildSummary(
  events: StoredEvent[],
  opts: {
    hiddenIds?: Set<string>
    resultLimit?: number
    dictionary?: Map<string, string>
    /** The owner's per-concept status/name/regimen curation (see curation.ts), loaded
     * by ClinicianSummary the same way the dictionary is and passed in. Empty
     * by default — and left empty for a read-only (recipient) render, whose
     * rows all stay `'active'` with no name overrides. Keeps `buildSummary`
     * pure (no db/session/wasm). */
    status?: Map<string, ConceptStatus>
    names?: Map<string, string>
    regimen?: Map<string, Regimen>
    /** The owner's per-concept priority (curation.ts's `priority:`): pinned
     * problems and allergies lead their section, and a hidden concept's events
     * are dropped before anything folds, leaving it only in `hidden`. */
    priority?: Map<string, ConceptPriority>
    /** "Now" for the recency window, injectable so the split is testable
     * without freezing the clock. */
    now?: number
    /** How far back the windowed sections reach; see
     * {@link RECENT_WINDOW_MONTHS}. `0` puts every dated row in `older`. */
    windowMonths?: number
  } = {},
): ClinicianSummary {
  // `dictionary`: the offline code dictionary (see dictionary.ts), hydrated once
  // and passed in. Empty by default, which makes its resolution layer a no-op.
  const {
    hiddenIds,
    resultLimit = 20,
    dictionary = new Map(),
    now = Date.now(),
    windowMonths = RECENT_WINDOW_MONTHS,
  } = opts
  const cutoff = windowStartMillis(now, windowMonths)
  const curation: Curation = {
    status: opts.status ?? new Map(),
    names: opts.names ?? new Map(),
    regimen: opts.regimen ?? new Map(),
    priority: opts.priority ?? new Map(),
  }
  // Subtract hides before grouping; dropped silently — a clinical summary
  // shouldn't advertise redactions with a "hidden entry" placeholder. The name
  // index is built from this same visible set, so a hidden event's display
  // can't leak into another row's label either.
  const visible = hiddenIds ? events.filter((se) => !hiddenIds.has(se.event.id)) : events
  // A hidden concept is a presentation choice, not a redaction like the above:
  // it leaves every section, but the owner still lists it to unhide. So its
  // events are dropped from `shown` (and from `shown`'s name index, so the
  // summary names rows the way the share preview does — the preview never sees
  // them), while its own manage-list rows are named from the wider `visible` set.
  const hiddenConcepts = hiddenConceptsFrom(curation.priority)
  const shown = withoutHiddenConcepts(visible, hiddenConcepts)
  const nameIndex = buildCodeNameIndex(shown)
  const evs = shown.map((se) => se.event)
  const hiddenEvs =
    hiddenConcepts.size === 0
      ? []
      : visible.map((se) => se.event).filter((e) => hiddenConcepts.has(keyFor(e)))
  const hiddenNameIndex = hiddenEvs.length === 0 ? nameIndex : buildCodeNameIndex(visible)

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
  const cycle = cycleStats(shown) ?? undefined

  return {
    problems: pinnedFirst(
      foldSection(conditions, 'earliest', () => '', nameIndex, dictionary, curation).sort(
        byDateDescNullLast,
      ),
    ),
    medications: foldSection(
      meds,
      'latest',
      // A curated dose outranks the quantity-derived one: the owner typed what
      // they actually take, while `medicationDose` reports what some source
      // document once recorded.
      (ls, group) => curation.regimen.get(keyFor(ls))?.dose ?? medicationDose(group),
      nameIndex,
      dictionary,
      curation,
    ).sort(byLabel),
    allergies: pinnedFirst(
      foldSection(allergyEvents, 'latest', () => '', nameIndex, dictionary, curation).sort(byLabel),
    ),
    hidden: {
      problems: foldSection(
        hiddenEvs.filter((e) => e.kind === 'condition'),
        'earliest',
        () => '',
        hiddenNameIndex,
        dictionary,
        curation,
      ).sort(byDateDescNullLast),
      allergies: foldSection(
        hiddenEvs.filter((e) => e.kind === 'allergy_intolerance'),
        'latest',
        () => '',
        hiddenNameIndex,
        dictionary,
        curation,
      ).sort(byLabel),
    },
    immunizations: splitByWindow(
      foldSection(
        immunizations,
        'latest',
        (_ls, group) => (group.length > 1 ? `${group.length} doses` : ''),
        nameIndex,
        dictionary,
        curation,
      ).sort(byDateDescNullLast),
      cutoff,
    ),
    latestVitals: splitByWindow(buildVitals(observations), cutoff),
    recentResults: limitBoth(
      splitByWindow(
        foldSection(
          results,
          'latest',
          (ls) => quantityString(ls) || textOf(ls) || '',
          nameIndex,
          dictionary,
          curation,
        ).sort(byDateDescNullLast),
        cutoff,
      ),
      resultLimit,
    ),
    work: buildWork(observations, curation),
    windowMonths,
    cycle,
  }
}
