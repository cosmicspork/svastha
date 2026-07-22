// Single source for the loggable kinds shown in the bloom. Log.svelte's
// kind→form dispatch must cover every kind listed here.
import type { Category } from './category'

export interface LogKind {
  kind: string
  label: string
  category: Category
  /** Single-character glyph for the bloom petal. Defaults to category glyph;
   * override for kinds that share a category but need distinct icons. */
  glyph?: string
}

/** Default order: a most-to-least frequent guess, used until real usage
 * counts are loaded (and as the stable tiebreak within a frequency bucket). */
export const LOG_KINDS: LogKind[] = [
  { kind: 'vitals', label: 'Vitals', category: 'vital' },
  { kind: 'med', label: 'Meds', category: 'med' },
  { kind: 'food', label: 'Food', category: 'food' },
  { kind: 'mind', label: 'Mind', category: 'mind' },
  { kind: 'symptom', label: 'Symptom', category: 'symptom' },
  { kind: 'exercise', label: 'Move', category: 'exercise' },
  { kind: 'note', label: 'Note', category: 'note' },
  { kind: 'paper', label: 'Paper record', category: 'note', glyph: '⛶' },
  { kind: 'cycle', label: 'Cycle', category: 'cycle' },
]
