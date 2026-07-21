// The single classification authority: every surface that colors, groups, or
// filters events (spine, chips, recents) goes through `categorize`, so an
// event can never appear under two different categories in two places.
import type { Code } from './codes'
import { SNOMED, SVASTHA, VITAL_LOINC_CODES, EXERCISE_ACTIVITY, EXERCISE_DURATION, CYCLE_CODES } from './codes'
import type { EventKind, EventValue } from './drafts'

export type Category =
  | 'vital'
  | 'symptom'
  | 'cycle'
  | 'med'
  | 'food'
  | 'exercise'
  | 'mind'
  | 'note'
  | 'clinical'
  | 'other'

/** Stable display order (filter chips, pickers). */
export const CATEGORIES: Category[] = [
  'vital',
  'symptom',
  'cycle',
  'med',
  'food',
  'exercise',
  'mind',
  'note',
  'clinical',
  'other',
]

/** The fields classification reads — structurally satisfied by a stored
 * event's `event` and by a `Draft`/`DraftTemplate`. */
export interface Categorizable {
  kind: EventKind
  code?: Code | null
  value?: EventValue | null
}

const EXERCISE_CODES = new Set([EXERCISE_ACTIVITY.code, EXERCISE_DURATION.code])

export function categorize(event: Categorizable): Category {
  switch (event.kind) {
    case 'nutrition_intake':
      return 'food'
    case 'medication_statement':
      return 'med'
    case 'document':
      // A text document is a personal note, and a captured paper record (an
      // attachment-valued document) is filed alongside notes — both are the
      // user's own hand, and a photographed handout reads as a note, not a
      // coded clinical fact. Anything richer (an imported source-document
      // pointer, say) belongs with the clinical record.
      return event.value && ('text' in event.value || 'attachment' in event.value)
        ? 'note'
        : 'clinical'
    case 'condition':
    case 'immunization':
    case 'encounter':
    case 'procedure':
    case 'allergy_intolerance':
      return 'clinical'
    case 'observation': {
      const code = event.code
      if (code) {
        if (code.system === SVASTHA) return CYCLE_CODES.has(code.code) ? 'cycle' : 'mind'
        if (VITAL_LOINC_CODES.has(code.code)) return 'vital'
        if (EXERCISE_CODES.has(code.code)) return 'exercise'
        if (code.system === SNOMED) return 'symptom'
        return 'clinical'
      }
      // No code + text value is quick-log's free-text symptom (and matches the
      // PR-1 "Self-reported" text observations); no code + anything else has
      // no home yet.
      return event.value && 'text' in event.value ? 'symptom' : 'other'
    }
    default:
      return 'other'
  }
}

export interface CategoryMeta {
  label: string
  /** Single-character glyph — cheap to render hundreds of on the spine. */
  glyph: string
  /** Class from base.css that sets `color` to the category hue. */
  hueClass: string
  /** Excluded from a doctor share whose scope names no explicit categories —
   * see doctorShare.ts's `filterEventsForScope`. Absent (or false) means the
   * category rides along with a default-scoped share like any other. */
  sensitive?: boolean
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  vital: { label: 'Vitals', glyph: '♥', hueClass: 'cat-vital' },
  symptom: { label: 'Symptoms', glyph: '✱', hueClass: 'cat-symptom' },
  cycle: { label: 'Cycle', glyph: '◐', hueClass: 'cat-cycle', sensitive: true },
  med: { label: 'Meds', glyph: '⬡', hueClass: 'cat-med' },
  food: { label: 'Food', glyph: '◈', hueClass: 'cat-food' },
  exercise: { label: 'Move', glyph: '➚', hueClass: 'cat-exercise' },
  mind: { label: 'Mind', glyph: '✿', hueClass: 'cat-mind', sensitive: true },
  note: { label: 'Notes', glyph: '✎', hueClass: 'cat-note' },
  clinical: { label: 'Clinical', glyph: '✚', hueClass: 'cat-clinical' },
  other: { label: 'Other', glyph: '◦', hueClass: 'cat-other' },
}
