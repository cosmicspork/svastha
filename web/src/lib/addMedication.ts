// "Add something I take": the pure half of the Medications page's add sheet —
// what the sheet's fields become, and whether they would duplicate a medication
// already on the list. Kept apart from the sheet so the duplicate rule is tested
// without a browser.
import { standingMedDraft, type Draft } from './drafts'
import { conceptKey, type SummaryRow } from './summary'
import { normalizeRegimen, type Regimen, type RegimenRoute } from './curation'
import { toLocalIso } from './time'

export interface AddMedicationFields {
  name: string
  dose: string
  schedule: string
  route: RegimenRoute | ''
  as_needed: boolean
  /** `YYYY-MM-DD` from a date input, or '' when not given. */
  started: string
}

export type AddMedicationPlan =
  /** Not saveable yet: no name, or a start date that is not a real day up to today. */
  | { kind: 'invalid' }
  /** A current medication already has this concept key. Writing a second
   * statement would only add a row to the same fold; the owner wants to edit
   * that one's details instead. */
  | { kind: 'existing'; row: SummaryRow }
  | {
      kind: 'add'
      key: string
      draft: Draft
      /** Undefined when every regimen field was left blank. */
      regimen: Regimen | undefined
      /** A past medication of the same name is being taken again: the new
       * statement folds into it, so it has to become current or it would land
       * straight back under "Past". */
      reactivate: boolean
    }

function localDay(d: Date): string {
  return toLocalIso(d).slice(0, 10)
}

/**
 * Plan an add from the sheet's fields against the owner's current fold.
 *
 * The statement's value is the trimmed name and nothing else, so the duplicate
 * check is an exact concept-key match — "Magnesium" and "magnesium" are two
 * medications here exactly as they are two rows on the summary (no fuzzy
 * matching anywhere a free-text key is compared). Dated by the start date when
 * one is given (local midnight), else `now`.
 */
export function planAddMedication(
  fields: AddMedicationFields,
  medications: SummaryRow[],
  now: Date,
): AddMedicationPlan {
  const name = fields.name.trim()
  if (!name) return { kind: 'invalid' }
  const started = fields.started.trim()
  // normalizeRegimen drops a date that is not a real calendar day; one that it
  // dropped, or one after today, is a typo rather than a start.
  if (started && (normalizeRegimen({ started })?.started !== started || started > localDay(now))) {
    return { kind: 'invalid' }
  }

  const effectiveAt = started ? toLocalIso(new Date(`${started}T00:00:00`)) : toLocalIso(now)
  const draft = standingMedDraft(name, effectiveAt)
  const key = conceptKey(draft)
  const existing = medications.find((row) => row.key === key)
  if (existing && existing.status === 'active') return { kind: 'existing', row: existing }

  return {
    kind: 'add',
    key,
    draft,
    regimen: normalizeRegimen({
      dose: fields.dose,
      schedule: fields.schedule,
      route: fields.route,
      as_needed: fields.as_needed,
      started,
    }),
    reactivate: existing !== undefined,
  }
}
