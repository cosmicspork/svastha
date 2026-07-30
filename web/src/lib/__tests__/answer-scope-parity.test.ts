// Node ↔ device parity for the exclusion rule itself.
//
// The device decides what an answer may read with `category.ts` (TypeScript);
// the node decides the same thing with `svastha_retrieval::scope` (Rust). Two
// implementations of one privacy promise is exactly the shape that drifts
// silently: a new app-local code would be sensitive on the device and ordinary
// on the node, and the only symptom would be a period log arriving at an
// inference endpoint — nothing would fail, nothing would log.
//
// So this file runs both against the same synthetic events and asserts they
// exclude the identical set. The Rust side is reached through the real compiled
// wasm (`answer_scope_exclusions`), which is the same code the node links, not a
// second port of it.
//
// The wasm package is a build artifact (`bun run wasm`, gitignored); both
// `bun run check` and `bun run test` build it first, so the import below is
// always satisfied by the time vitest runs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { answer_scope_exclusions } from '../../wasm/svastha'

import { filterSensitive, includeList } from '../answerScope'
import { CYCLE_START, CYCLE_FLOW, CYCLE_CLOTS, CYCLE_END, MOOD, MOOD_NOTE, GRATITUDE, BP_SYSTOLIC, BP_DIASTOLIC } from '../codes'
import type { Category } from '../category'
import type { StoredEvent } from '../events'

beforeAll(async () => {
  const wasm = fileURLToPath(new URL('../../wasm/svastha_bg.wasm', import.meta.url).href)
  await init({ module_or_path: readFileSync(wasm) })
})

/** A stored event whose id is valid content-id hex (the Rust side parses it),
 * derived from a readable label so a failure names the entry that disagreed. */
function ev(
  label: string,
  code: StoredEvent['event']['code'],
  kind: StoredEvent['event']['kind'] = 'observation',
): StoredEvent {
  return {
    event: {
      id: idFor(label),
      kind,
      code,
      effective_at: '2026-03-15T09:00:00Z',
      value: { text: 'x' },
      provenance: { source: 'self', source_doc: null },
    },
    author: 'a'.repeat(64),
    signature: 'b'.repeat(128),
  }
}

/** Labels are hex-free words, so map each to a distinct valid 64-char hex id. */
const LABELS = [
  'cycle-start',
  'cycle-end',
  'cycle-flow',
  'cycle-clots',
  'mood',
  'mood-note',
  'gratitude',
  'dream',
  'systolic',
  'diastolic',
  'symptom',
  'note',
  'immunization',
  'med',
] as const
const idFor = (label: string) =>
  (LABELS.indexOf(label as (typeof LABELS)[number]) + 1).toString(16).padStart(64, '0')

const VAULT: StoredEvent[] = [
  ev('cycle-start', CYCLE_START),
  ev('cycle-end', CYCLE_END),
  ev('cycle-flow', CYCLE_FLOW),
  ev('cycle-clots', CYCLE_CLOTS),
  ev('mood', MOOD),
  ev('mood-note', MOOD_NOTE),
  ev('gratitude', GRATITUDE),
  // A code in the app-local system that neither side has ever seen: both must
  // land on the same answer, or a future feature quietly opens a hole.
  ev('dream', { system: 'urn:svastha:codes', code: 'dream-journal', display: 'Dream' }),
  ev('systolic', BP_SYSTOLIC),
  ev('diastolic', BP_DIASTOLIC),
  ev('symptom', { system: 'http://snomed.info/sct', code: '25064002', display: 'Headache' }),
  ev('note', null, 'document'),
  ev('immunization', null, 'immunization'),
  // Same app-local code, wrong kind: sensitivity is reached only through an
  // observation on both sides.
  ev('med', { system: 'urn:svastha:codes', code: 'mood', display: 'Mood' }, 'medication_statement'),
]

/** The ids the device leaves out — the complement of what `filterSensitive` keeps. */
function deviceExclusions(optIns: Set<Category>): string[] {
  const kept = new Set(filterSensitive(VAULT, optIns).map((e) => e.event.id))
  return VAULT.map((e) => e.event.id).filter((id) => !kept.has(id))
}

/** The ids the node leaves out, via the shared Rust rule compiled to wasm. */
function nodeExclusions(optIns: Set<Category>): string[] {
  return JSON.parse(
    answer_scope_exclusions(
      JSON.stringify(VAULT.map((e) => e.event)),
      JSON.stringify(includeList(optIns)),
    ),
  ) as string[]
}

const set = (...cats: Category[]) => new Set<Category>(cats)

describe('node and device exclude the identical set', () => {
  for (const optIns of [set(), set('cycle'), set('mind'), set('cycle', 'mind')]) {
    it(`with opt-ins [${[...optIns].join(', ') || 'none'}]`, () => {
      expect(nodeExclusions(optIns)).toEqual(deviceExclusions(optIns))
    })
  }

  // Parity alone would be satisfied by two implementations that are identically
  // wrong, so pin what the agreed answer actually is.
  it('and the agreed default is every cycle and mind entry, nothing else', () => {
    expect(deviceExclusions(set())).toEqual(
      ['cycle-start', 'cycle-end', 'cycle-flow', 'cycle-clots', 'mood', 'mood-note', 'gratitude', 'dream'].map(
        idFor,
      ),
    )
  })

  it('and opting cycle in releases only the cycle entries', () => {
    const released = deviceExclusions(set()).filter((id) => !deviceExclusions(set('cycle')).includes(id))
    expect(released).toEqual(['cycle-start', 'cycle-end', 'cycle-flow', 'cycle-clots'].map(idFor))
  })
})
