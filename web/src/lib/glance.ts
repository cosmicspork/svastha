// Cheap dashboard aggregates over raw events — no curation load (the full
// clinical read lives on the Summary page). Pure and `now`-injected so they
// unit-test without a clock or a DB. Consumed by the Home "At a glance" cards.
import type { StoredEvent } from './events'
import type { Category } from './category'
import { VITALS, BP_SYSTOLIC, BP_DIASTOLIC, canonicalSystem } from './codes'
import { categorize } from './category'
import { quantityOf, describeEvent } from './timeline'

const DAY = 86_400_000

function newestFirst(a: StoredEvent, b: StoredEvent): number {
  return (a.event.effective_at ?? '') < (b.event.effective_at ?? '') ? 1 : -1
}

// ---- Recently logged -------------------------------------------------------

export interface ActivityItem {
  id: string
  category: Category
  label: string
  value: string
  atIso: string
}

/** The most recently logged entries across every category, newest first. */
export function recentActivity(events: StoredEvent[], limit = 4): ActivityItem[] {
  return events
    .filter((e) => e.event.effective_at)
    .sort(newestFirst)
    .slice(0, limit)
    .map((e) => {
      const d = describeEvent(e.event)
      return {
        id: e.event.id,
        category: categorize(e.event),
        label: d.label,
        value: d.value,
        atIso: e.event.effective_at as string,
      }
    })
}

// ---- Vitals (latest + 7-day trend) -----------------------------------------

export type Trend = 'down' | 'up' | 'flat' | null

export interface VitalGlance {
  key: string
  label: string
  /** Display value: the 7-day mean when available, else the latest reading. */
  value: string
  unit: string
  trend: Trend
  /** '7-day avg' or 'latest', so the card is honest about which it shows. */
  basis: 'avg' | 'latest'
}

interface Sample {
  n: number
  at: number
  unit: string
}

function samplesFor(events: StoredEvent[], code: string): Sample[] {
  const out: Sample[] = []
  for (const { event } of events) {
    if (event.code?.code !== code || !event.effective_at) continue
    const q = quantityOf(event)
    if (!q) continue
    const n = Number(q.value)
    if (!Number.isFinite(n)) continue
    out.push({ n, at: Date.parse(event.effective_at), unit: q.unit })
  }
  return out
}

function latest(samples: Sample[]): Sample | null {
  return samples.reduce<Sample | null>((best, s) => (!best || s.at > best.at ? s : best), null)
}

function windowMean(samples: Sample[], from: number, to: number): number | null {
  const ns = samples.filter((s) => s.at >= from && s.at < to).map((s) => s.n)
  if (ns.length === 0) return null
  return ns.reduce((a, b) => a + b, 0) / ns.length
}

function trendOf(recent: number | null, prior: number | null): Trend {
  if (recent === null || prior === null) return null
  // A 2% dead-band so ordinary noise reads flat rather than flickering up/down.
  const band = Math.abs(prior) * 0.02
  if (recent - prior > band) return 'up'
  if (recent - prior < -band) return 'down'
  return 'flat'
}

/**
 * One entry per vital the record actually has, showing the 7-day average (with
 * a trend arrow vs. the prior week) or falling back to the single latest
 * reading when there isn't a week of data. Height is skipped — it's
 * constitutional, not a trend. Blood pressure folds its systolic/diastolic pair
 * back into "118/76", trending on systolic.
 */
export function vitalGlances(events: StoredEvent[], now = Date.now()): VitalGlance[] {
  const w1 = now - 7 * DAY
  const w2 = now - 14 * DAY
  const out: VitalGlance[] = []

  for (const v of VITALS) {
    if (v.key === 'height') continue

    if (v.key === 'bp') {
      const sys = samplesFor(events, BP_SYSTOLIC.code)
      const dia = samplesFor(events, BP_DIASTOLIC.code)
      const ls = latest(sys)
      const ld = latest(dia)
      if (!ls || !ld) continue
      const avgSys = windowMean(sys, w1, now)
      const avgDia = windowMean(dia, w1, now)
      const useAvg = avgSys !== null && avgDia !== null
      const s = useAvg ? Math.round(avgSys as number) : ls.n
      const d = useAvg ? Math.round(avgDia as number) : ld.n
      out.push({
        key: 'bp',
        label: v.label,
        value: `${s}/${d}`,
        unit: '',
        trend: trendOf(windowMean(sys, w1, now), windowMean(sys, w2, w1)),
        basis: useAvg ? 'avg' : 'latest',
      })
      continue
    }

    const samples = samplesFor(events, v.loinc.code)
    const l = latest(samples)
    if (!l) continue
    const avg = windowMean(samples, w1, now)
    out.push({
      key: v.key,
      label: v.label,
      value: (avg ?? l.n).toFixed(v.decimals),
      unit: l.unit,
      trend: trendOf(avg, windowMean(samples, w2, w1)),
      basis: avg !== null ? 'avg' : 'latest',
    })
  }

  return out
}

// ---- Recent symptoms -------------------------------------------------------

export interface SymptomGlance {
  label: string
  /** 0–10 for coded symptoms; null for free-text ones with no severity. */
  severity: number | null
}

/** Symptoms logged in the last `days`, most severe first, one row per symptom
 * (the worst reading of that symptom in the window). */
export function recentSymptoms(
  events: StoredEvent[],
  now = Date.now(),
  days = 14,
  limit = 5,
  // Names the coded rows (see dictionary.ts; empty means the feature is off).
  dictionary: Map<string, string> = new Map(),
): SymptomGlance[] {
  const from = now - days * DAY
  // Keyed by code, not by resolved label: a symptom carries no display of its
  // own, so with the dictionary off every coded row would otherwise share the
  // "Symptom" fallback label and collapse into a single entry. Free-text
  // symptoms have no code and key by their label, which is their identity.
  const worst = new Map<string, { label: string; severity: number | null; at: number }>()

  for (const { event } of events) {
    if (categorize(event) !== 'symptom' || !event.effective_at) continue
    const at = Date.parse(event.effective_at)
    if (at < from) continue
    const label = describeEvent(event, dictionary).label
    const key = event.code ? `${canonicalSystem(event.code.system)}|${event.code.code}` : label
    const q = quantityOf(event)
    const raw = q ? Number(q.value) : NaN
    const severity = Number.isFinite(raw) ? raw : null
    const prev = worst.get(key)
    if (!prev || (severity ?? -1) > (prev.severity ?? -1)) {
      worst.set(key, { label, severity, at })
    }
  }

  return [...worst.values()]
    .map((v) => ({ label: v.label, severity: v.severity }))
    .sort((a, b) => (b.severity ?? -1) - (a.severity ?? -1))
    .slice(0, limit)
}

// ---- Medications -----------------------------------------------------------

export interface MedsGlance {
  count: number
  names: string[]
}

/** Distinct medications on record, most-recently-logged names first. Approximate
 * — without a stop date every `medication_statement` counts, so this reads as
 * "medications on record", not a reconciled active list (that's the Summary). */
export function medicationGlance(events: StoredEvent[], limit = 4): MedsGlance {
  const names: string[] = []
  const seen = new Set<string>()
  for (const e of [...events].filter((x) => x.event.kind === 'medication_statement').sort(newestFirst)) {
    const label = describeEvent(e.event).label
    if (seen.has(label)) continue
    seen.add(label)
    if (names.length < limit) names.push(label)
  }
  return { count: seen.size, names }
}
