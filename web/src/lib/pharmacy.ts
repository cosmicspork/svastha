// The pharmacy handoff: the same medication fold the owner's Medications page
// shows, flattened into one numbered list a pharmacist can read down.
//
// Pure over `SummaryRow[]` (see summary.ts's stance), so the page, its print
// stylesheet, and the exported PDF all render from one call rather than three
// walks that could disagree about order or numbering.
import type { Regimen } from './curation'
import { REGIMEN_ROUTE_LABELS, type RegimenRoute } from './curation'
import { shelveMedications, type SummaryRow } from './summary'

export type PharmacyGroupId = 'unrouted' | RegimenRoute | 'past'

/** One medication as a pharmacist reads it. Every string field is '' when the
 * owner recorded nothing — never a placeholder, so a view can decide between
 * omitting the line and saying "not recorded" rather than inheriting a guess
 * from here. */
export interface PharmacyRow {
  /** 1-based position in the whole list, continuous across every group. */
  n: number
  key: string
  name: string
  /** The curated dose, else the recorded dose quantity (`SummaryRow.detail`). */
  dose: string
  /** How it is taken: schedule and instructions, joined. Never the prescriber —
   * the row carries that separately, and a sig that names a doctor reads like
   * part of the direction. */
  sig: string
  asNeeded: boolean
  prescriber: string
  /** The row's terminology coding, rendered as "RxNorm 6809", or '' when the
   * entry is free text. A pharmacist reads the name, but the code is what
   * identifies the drug unambiguously — and when nothing named the concept it
   * is the only identity the row has. */
  code: string
  past: boolean
}

export interface PharmacyGroup {
  id: PharmacyGroupId
  title: string
  rows: PharmacyRow[]
}

/** The unrouted shelf's pharmacist-facing title. The owner's page says "Needs
 * a route" because filing it is the owner's job; a pharmacist can only be told
 * what is and isn't on file. */
export const UNROUTED_TITLE = 'Route not recorded'

/**
 * How a medication is taken, from the owner's curated regimen.
 *
 * Schedule and instructions are separate free-text fields and both are honest
 * ("twice a day", "with food"); joined they read as one direction. Empty when
 * neither was recorded — a pharmacist reading "—" would have to guess whether
 * that means no direction or none recorded.
 */
export function sigLine(regimen: Regimen | undefined): string {
  if (!regimen) return ''
  return [regimen.schedule, regimen.instructions].filter(Boolean).join(' · ')
}

/**
 * Flatten the medication fold into numbered groups.
 *
 * Group order matches the owner's Medications page (unrouted, then each route
 * shelf, then past) so the two screens number a med identically — someone
 * reading "number six" off the pharmacy list finds the same drug on the page.
 * Numbering is continuous across every group, past meds included: the number is
 * a position in one list, not an index within a shelf.
 *
 * Empty groups are dropped. Order within a group is order in — rows arrive
 * `byLabel`-sorted from `buildSummary` and nothing here re-sorts them.
 */
export function buildPharmacyGroups(rows: SummaryRow[]): PharmacyGroup[] {
  const shelved = shelveMedications(rows)
  const groups: PharmacyGroup[] = []
  let n = 0

  const add = (id: PharmacyGroupId, title: string, shelfRows: SummaryRow[]): void => {
    if (shelfRows.length === 0) return
    groups.push({
      id,
      title,
      rows: shelfRows.map((row) => ({
        n: ++n,
        key: row.key,
        name: row.label,
        dose: row.detail,
        sig: sigLine(row.regimen),
        asNeeded: row.regimen?.as_needed === true,
        prescriber: row.regimen?.prescriber ?? '',
        code: row.coding ? `${row.coding.system} ${row.coding.code}` : '',
        past: row.status === 'inactive',
      })),
    })
  }

  add('unrouted', UNROUTED_TITLE, shelved.unrouted)
  for (const shelf of shelved.shelves) {
    add(shelf.route, REGIMEN_ROUTE_LABELS[shelf.route], shelf.rows)
  }
  add('past', 'Past', shelved.past)
  return groups
}

/** How many rows the groups carry, for a count a view would otherwise derive by
 * flattening them again. */
export function pharmacyRowCount(groups: PharmacyGroup[]): number {
  return groups.reduce((total, group) => total + group.rows.length, 0)
}
