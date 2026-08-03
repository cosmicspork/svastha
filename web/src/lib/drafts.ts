// Unsigned event drafts and the pure per-form builders. No wasm, no session,
// no storage — signing and persistence live in ./events.ts (logEvent), so
// these builders stay unit testable in plain node.
import type { Code, VitalDef } from './codes'
import {
  BP_SYSTOLIC,
  BP_DIASTOLIC,
  MMHG,
  EXERCISE_ACTIVITY,
  EXERCISE_DURATION,
  MINUTES,
  MOOD,
  MOOD_NOTE,
  GRATITUDE,
  CYCLE_START,
  CYCLE_END,
  CYCLE_FLOW,
  CYCLE_CLOTS,
} from './codes'

/** Wire names of `EventKind` (serde `snake_case`); see crates/core/src/event.rs. */
export type EventKind =
  | 'observation'
  | 'condition'
  | 'medication_statement'
  | 'immunization'
  | 'encounter'
  | 'procedure'
  | 'allergy_intolerance'
  | 'document'
  | 'nutrition_intake'

/** The JSON form of core's `EventValue` — externally tagged with snake_case
 * variant names, pinned by spec/vectors/event.json. Quantities are decimal
 * *strings*, matching the contract (floats would break canonical bytes). */
export type EventValue =
  | { quantity: { value: string; unit: Code | null } }
  | { coded: Code }
  | { text: string }
  | { attachment: { sha256: string; mime: string; size: number } }

/** An event ready to sign: everything but `id` (derived) and `provenance`
 * (stamped by logEvent). Quick-log always dates its facts. `value` is
 * nullable for a marker fact — e.g. cycle start/end — whose meaning is
 * entirely in its code; core's `EventValue` is `Option`-typed for the same
 * reason. */
export interface Draft {
  kind: EventKind
  code?: Code
  effective_at: string
  value: EventValue | null
}

/** A draft with the timestamp stripped — the reusable part of a logged combo,
 * stored as favorites and offered as recents. */
export type DraftTemplate = Omit<Draft, 'effective_at'>

export function quantity(value: string, unit: Code | null = null): EventValue {
  return { quantity: { value, unit } }
}

export function text(value: string): EventValue {
  return { text: value }
}

/** Stamp templates with one shared timestamp (the group key on the timeline). */
export function fromTemplates(templates: DraftTemplate[], effectiveAt: string): Draft[] {
  return templates.map((t) => ({ ...t, effective_at: effectiveAt }))
}

export function toTemplate(draft: Draft): DraftTemplate {
  const template: DraftTemplate = { kind: draft.kind, value: draft.value }
  if (draft.code) template.code = draft.code
  return template
}

// --- vitals ---

/** A blood pressure reading is TWO observations (systolic + diastolic) sharing
 * an `effective_at`; the timeline re-pairs them by timestamp. */
export function bpDrafts(systolic: string, diastolic: string, effectiveAt: string): Draft[] {
  return [
    { kind: 'observation', code: BP_SYSTOLIC, effective_at: effectiveAt, value: quantity(systolic, MMHG) },
    { kind: 'observation', code: BP_DIASTOLIC, effective_at: effectiveAt, value: quantity(diastolic, MMHG) },
  ]
}

export function vitalDraft(loinc: Code, value: string, unit: Code, effectiveAt: string): Draft {
  return { kind: 'observation', code: loinc, effective_at: effectiveAt, value: quantity(value, unit) }
}

// --- symptoms ---

/** A coded symptom carries its 0-10 severity as a unitless quantity. */
export function symptomDraft(snomed: Code, severity: number, effectiveAt: string): Draft {
  return {
    kind: 'observation',
    code: snomed,
    effective_at: effectiveAt,
    value: quantity(String(severity)),
  }
}

/** A free-text symptom is one observation whose text IS the symptom name — no
 * code, and no severity: a single event can't carry both a text value and a
 * severity quantity, and the name is the more useful half. Severity applies to
 * coded symptoms only. */
export function freeTextSymptomDraft(name: string, effectiveAt: string): Draft {
  return { kind: 'observation', effective_at: effectiveAt, value: text(name) }
}

// --- meds ---

/** One medication_statement with no code and a text value like
 * "ibuprofen — 400 mg". Folding the dose into the text loses structure, but
 * the alternatives are worse: a quantity value drops the name, and a fake
 * RxNorm code lies about what we know. Proper RxNorm coding arrives with
 * import/curation; until then the text is honest and readable. */
export function medDraft(
  name: string,
  effectiveAt: string,
  dose?: string,
  unit?: string,
): Draft {
  return {
    kind: 'medication_statement',
    effective_at: effectiveAt,
    value: text(dose ? `${name} — ${dose} ${unit ?? 'mg'}` : name),
  }
}

// --- food ---

/** One nutrition_intake per item (matching core's "one event per item; a
 * multi-item meal shares an effective_at"). */
export function foodDrafts(items: string[], effectiveAt: string): Draft[] {
  return items.map((item) => ({
    kind: 'nutrition_intake' as const,
    effective_at: effectiveAt,
    value: text(item),
  }))
}

// --- exercise ---

/** An activity observation, plus a separate duration observation when minutes
 * are given — two facts, one timestamp. */
export function exerciseDrafts(activity: string, effectiveAt: string, minutes?: string): Draft[] {
  const drafts: Draft[] = [
    { kind: 'observation', code: EXERCISE_ACTIVITY, effective_at: effectiveAt, value: text(activity) },
  ]
  if (minutes) {
    drafts.push({
      kind: 'observation',
      code: EXERCISE_DURATION,
      effective_at: effectiveAt,
      value: quantity(minutes, MINUTES),
    })
  }
  return drafts
}

// --- notes ---

export function noteDraft(body: string, effectiveAt: string): Draft {
  return { kind: 'document', effective_at: effectiveAt, value: text(body) }
}

// --- paper records (captured documents) ---

/** Metadata for one captured photo, produced by the capture form after
 * downscaling: the content address of the plaintext bytes plus its type/size.
 * The bytes themselves are stored separately (see lib/attachments.ts). */
export interface CapturedPhoto {
  sha256: string
  mime: string
  size: number
}

/** One `document` event per photo carrying an `attachment` value, plus a
 * caption sibling (a plain text `document`, i.e. a note) sharing the same
 * `effective_at` when the caption is non-empty. The shared timestamp is what
 * folds a multi-page capture and its caption into one spine entry — the same
 * convention a BP pair or a multi-item meal uses. The caption lives where a
 * note's text lives, never inside the attachment value, so each photo's id is a
 * pure function of its bytes. */
export function paperRecordDrafts(
  photos: CapturedPhoto[],
  caption: string,
  effectiveAt: string,
): Draft[] {
  const drafts: Draft[] = photos.map((p) => ({
    kind: 'document' as const,
    effective_at: effectiveAt,
    value: { attachment: { sha256: p.sha256, mime: p.mime, size: p.size } },
  }))
  const trimmed = caption.trim()
  if (trimmed) drafts.push(noteDraft(trimmed, effectiveAt))
  return drafts
}

// --- visits ---

/** One `encounter` with no code and a text value like "Dr. Sharma — cardiology
 * follow-up". The reason folds into the text for the same reason a dose folds
 * into medDraft's: a made-up encounter-type code would lie about what we know,
 * and a coded value would drop the provider's name. A visit note is a separate
 * `document` sharing this `effective_at` (see noteDraft) — the timeline's
 * same-timestamp grouping and C2 note-nesting associate the two, so there is no
 * link field to invent. */
export function encounterDraft(provider: string, reason: string, effectiveAt: string): Draft {
  const name = provider.trim()
  const why = reason.trim()
  return { kind: 'encounter', effective_at: effectiveAt, value: text(why ? `${name} — ${why}` : name) }
}

// --- clinical history (diagnoses, procedures, immunizations, allergies) ---

/** One `condition` with no code and a text value — e.g. "sinus infection".
 * Coded (ICD-10) diagnoses are a roadmap item; free text is honest until
 * then, same trade-off as encounterDraft and medDraft. */
export function conditionDraft(name: string, effectiveAt: string): Draft {
  return { kind: 'condition', effective_at: effectiveAt, value: text(name.trim()) }
}

/** One `procedure` with no code and a text value — e.g. "mole removal". */
export function procedureDraft(name: string, effectiveAt: string): Draft {
  return { kind: 'procedure', effective_at: effectiveAt, value: text(name.trim()) }
}

/** One `immunization` with no code and a text value — e.g. "flu shot". CVX
 * coding is deferred with the rest of clinical history. */
export function immunizationDraft(name: string, effectiveAt: string): Draft {
  return { kind: 'immunization', effective_at: effectiveAt, value: text(name.trim()) }
}

/** One `allergy_intolerance` with no code and a text value like "peanuts —
 * hives": the reaction folds into the text the same way encounterDraft folds
 * a visit's reason, because a coded substance would drop the reaction and a
 * quantity value can't hold either. Reaction is optional — just the
 * substance when it's blank. */
export function allergyDraft(substance: string, reaction: string, effectiveAt: string): Draft {
  const what = substance.trim()
  const why = reaction.trim()
  return {
    kind: 'allergy_intolerance',
    effective_at: effectiveAt,
    value: text(why ? `${what} — ${why}` : what),
  }
}

// --- visit sections (diagnoses, procedures, immunizations, allergies) ---
//
// Same "add another" free-text row shape as the vitals/meds sections below,
// but simpler: a bare name (or a substance with an optional reaction) has no
// malformed case, so a blank row just contributes nothing — no null branch
// to block the save.

export interface VisitConditionRow {
  name: string
}

export function visitConditionsDrafts(rows: VisitConditionRow[], effectiveAt: string): Draft[] {
  return rows.filter((r) => r.name.trim()).map((r) => conditionDraft(r.name, effectiveAt))
}

export interface VisitProcedureRow {
  name: string
}

export function visitProceduresDrafts(rows: VisitProcedureRow[], effectiveAt: string): Draft[] {
  return rows.filter((r) => r.name.trim()).map((r) => procedureDraft(r.name, effectiveAt))
}

export interface VisitImmunizationRow {
  name: string
}

export function visitImmunizationsDrafts(rows: VisitImmunizationRow[], effectiveAt: string): Draft[] {
  return rows.filter((r) => r.name.trim()).map((r) => immunizationDraft(r.name, effectiveAt))
}

export interface VisitAllergyRow {
  substance: string
  reaction: string
}

export function visitAllergiesDrafts(rows: VisitAllergyRow[], effectiveAt: string): Draft[] {
  return rows
    .filter((r) => r.substance.trim())
    .map((r) => allergyDraft(r.substance, r.reaction, effectiveAt))
}

// --- visit sections (vitals and meds taken alongside a visit) ---
//
// A visit's optional vitals/meds sections repeat VitalsForm's and MedForm's
// row shapes (an "add another" list of them) so the same input patterns and
// codes carry over; these helpers assemble the whole section's drafts,
// sharing the visit's effective_at, so VisitForm's buildDrafts stays a thin
// composition of encounter + note + vitals + meds.

function validNumber(raw: string, decimals: number): boolean {
  const v = raw.trim()
  return decimals === 0 ? /^\d+$/.test(v) : /^\d+(\.\d+)?$/.test(v)
}

/** One vitals-section row: a BP pair when `vital.key === 'bp'`, otherwise a
 * single reading in `single` — the same split VitalsForm makes. A row with
 * no input is blank (contributes nothing); a row with some input that
 * doesn't parse is malformed. */
export interface VisitVitalRow {
  vital: VitalDef
  systolic: string
  diastolic: string
  single: string
  unit: Code
}

/** Drafts for one row, `[]` if blank, or `null` if malformed. */
function visitVitalRowDrafts(row: VisitVitalRow, effectiveAt: string): Draft[] | null {
  if (row.vital.key === 'bp') {
    if (!row.systolic.trim() && !row.diastolic.trim()) return []
    if (!validNumber(row.systolic, 0) || !validNumber(row.diastolic, 0)) return null
    return bpDrafts(row.systolic.trim(), row.diastolic.trim(), effectiveAt)
  }
  if (!row.single.trim()) return []
  if (!validNumber(row.single, row.vital.decimals)) return null
  return [vitalDraft(row.vital.loinc, row.single.trim(), row.unit, effectiveAt)]
}

/** All vitals-section rows for one visit, sharing `effectiveAt`. `null` if
 * any row is malformed — a bad row blocks the whole visit save rather than
 * silently dropping it, same as the standalone Vitals form refusing to save
 * bad input. A blank row (the "add another" default) contributes nothing. */
export function visitVitalsDrafts(rows: VisitVitalRow[], effectiveAt: string): Draft[] | null {
  const drafts: Draft[] = []
  for (const row of rows) {
    const rowDrafts = visitVitalRowDrafts(row, effectiveAt)
    if (rowDrafts === null) return null
    drafts.push(...rowDrafts)
  }
  return drafts
}

/** One "now taking" medication row — MedForm's name/dose/unit fields. Never
 * "prescribed": an order is not a taken medication, and the vault refuses to
 * assert medication history it wasn't told. */
export interface VisitMedRow {
  name: string
  dose: string
  doseUnit: string
}

function visitMedRowDrafts(row: VisitMedRow, effectiveAt: string): Draft[] | null {
  const name = row.name.trim()
  if (!name) return []
  const dose = row.dose.trim()
  if (dose && !/^\d+(\.\d+)?$/.test(dose)) return null
  return [medDraft(name, effectiveAt, dose || undefined, row.doseUnit)]
}

/** All meds-section rows for one visit, sharing `effectiveAt`. Same
 * blank-contributes-nothing / malformed-blocks-save rules as
 * `visitVitalsDrafts`. */
export function visitMedsDrafts(rows: VisitMedRow[], effectiveAt: string): Draft[] | null {
  const drafts: Draft[] = []
  for (const row of rows) {
    const rowDrafts = visitMedRowDrafts(row, effectiveAt)
    if (rowDrafts === null) return null
    drafts.push(...rowDrafts)
  }
  return drafts
}

// --- mindfulness ---

/** A 1–5 mood score as a unitless quantity (an ordinal scale, not a
 * measurement — no unit code applies), plus an optional text note sharing
 * the timestamp. Grouping is presentational, same as the BP pair. */
export function moodDraft(score: number, note: string, effectiveAt: string): Draft[] {
  const drafts: Draft[] = [
    { kind: 'observation', code: MOOD, effective_at: effectiveAt, value: quantity(String(score)) },
  ]
  const trimmed = note.trim()
  if (trimmed) {
    drafts.push({ kind: 'observation', code: MOOD_NOTE, effective_at: effectiveAt, value: text(trimmed) })
  }
  return drafts
}

/** One observation per gratitude item (matching food's "one event per item;
 * a shared effective_at"). Trims and drops empties itself, unlike foodDrafts,
 * since chip entry here has no un-chipped-pending-text special case. */
export function gratitudeDrafts(items: string[], effectiveAt: string): Draft[] {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ({
      kind: 'observation' as const,
      code: GRATITUDE,
      effective_at: effectiveAt,
      value: text(item),
    }))
}

// --- cycle ---

/** Flow intensity as a 1–4 ordinal (spotting..heavy) — a unitless quantity,
 * same convention as mood's 1–5 score: an ordinal scale, not a measurement. */
function flowSibling(level: number, effectiveAt: string): Draft {
  return { kind: 'observation', code: CYCLE_FLOW, effective_at: effectiveAt, value: quantity(String(level)) }
}

/** Clots is presence-only (no severity scale yet), so the sibling carries no
 * value — the code alone is the fact. */
function clotsSibling(effectiveAt: string): Draft {
  return { kind: 'observation', code: CYCLE_CLOTS, effective_at: effectiveAt, value: null }
}

/** The first day of a period: a marker observation (no value — the code IS
 * the fact, same "no value" shape core's `Option<EventValue>` already allows)
 * plus optional flow/clots siblings sharing the timestamp — the same "one
 * event per component" convention a BP pair or a mood note uses. */
export function cycleStartDraft(flow: number | null, clots: boolean, effectiveAt: string): Draft[] {
  const drafts: Draft[] = [{ kind: 'observation', code: CYCLE_START, effective_at: effectiveAt, value: null }]
  if (flow !== null) drafts.push(flowSibling(flow, effectiveAt))
  if (clots) drafts.push(clotsSibling(effectiveAt))
  return drafts
}

/** A flow reading logged on any day the period is active (not just day one),
 * plus an optional clots sibling. */
export function cycleFlowDraft(level: number, clots: boolean, effectiveAt: string): Draft[] {
  const drafts: Draft[] = [flowSibling(level, effectiveAt)]
  if (clots) drafts.push(clotsSibling(effectiveAt))
  return drafts
}

/** The last day of a period: a marker observation, no value, no siblings —
 * flow and clots belong to the days the period is active. */
export function cycleEndDraft(effectiveAt: string): Draft {
  return { kind: 'observation', code: CYCLE_END, effective_at: effectiveAt, value: null }
}
