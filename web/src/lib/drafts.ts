// Unsigned event drafts and the pure per-form builders. No wasm, no session,
// no storage — signing and persistence live in ./events.ts (logEvent), so
// these builders stay unit testable in plain node.
import type { Code } from './codes'
import {
  BP_SYSTOLIC,
  BP_DIASTOLIC,
  MMHG,
  EXERCISE_ACTIVITY,
  EXERCISE_DURATION,
  MINUTES,
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

/** An event ready to sign: everything but `id` (derived) and `provenance`
 * (stamped by logEvent). Quick-log always dates its facts. */
export interface Draft {
  kind: EventKind
  code?: Code
  effective_at: string
  value: EventValue
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
