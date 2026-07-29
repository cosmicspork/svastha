// The device half of the answer-scope promise: what retrieval is allowed to
// consider, and what the owner's stored choice does and does not permit.
//
// The exclusion is the whole feature, so it is pinned directly on the pure
// filter rather than only through `askLocally` — a regression here is a
// disclosure, not a wrong answer.
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDb, get } from '../db'
import { filterSensitive, includeList, loadOptIns, saveOptIns, OPT_IN_CATEGORIES } from '../answerScope'
import { CATEGORIES, CATEGORY_META, type Category } from '../category'
import { BP_SYSTOLIC, CYCLE_START, CYCLE_FLOW, MOOD, GRATITUDE } from '../codes'
import type { StoredEvent } from '../events'

beforeEach(async () => {
  await deleteDb()
})

function ev(
  id: string,
  code: StoredEvent['event']['code'] = null,
  kind: StoredEvent['event']['kind'] = 'observation',
): StoredEvent {
  return {
    event: {
      id,
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

const cycleStart = ev('cyc', CYCLE_START)
const cycleFlow = ev('flow', CYCLE_FLOW)
const mood = ev('mood', MOOD)
const gratitude = ev('grat', GRATITUDE)
const vital = ev('bp', BP_SYSTOLIC)
const note = ev('note', null, 'document')
const ALL = [cycleStart, cycleFlow, mood, gratitude, vital, note]

const ids = (events: StoredEvent[]) => events.map((e) => e.event.id)
const set = (...cats: Category[]) => new Set<Category>(cats)

describe('OPT_IN_CATEGORIES', () => {
  it('is exactly the categories a doctor share treats as opt-in', () => {
    expect(OPT_IN_CATEGORIES).toEqual(CATEGORIES.filter((c) => CATEGORY_META[c].sensitive))
    expect(OPT_IN_CATEGORIES).toEqual(['cycle', 'mind'])
  })
})

describe('filterSensitive', () => {
  it('leaves cycle and mind entries out by default', () => {
    expect(ids(filterSensitive(ALL, set()))).toEqual(['bp', 'note'])
  })

  it('admits only the category that was opted in', () => {
    expect(ids(filterSensitive(ALL, set('cycle')))).toEqual(['cyc', 'flow', 'bp', 'note'])
    expect(ids(filterSensitive(ALL, set('mind')))).toEqual(['mood', 'grat', 'bp', 'note'])
  })

  it('admits both when both are on, and never re-scopes anything else', () => {
    expect(ids(filterSensitive(ALL, set('cycle', 'mind')))).toEqual(ids(ALL))
  })

  it('leaves a vault with nothing sensitive untouched', () => {
    expect(filterSensitive([vital, note], set())).toEqual([vital, note])
  })
})

describe('the stored choice', () => {
  it('is empty until the owner chooses — the default is exclusion', async () => {
    expect(await loadOptIns()).toEqual(new Set())
  })

  it('round-trips through the prefs store as an explicit ordered list', async () => {
    await saveOptIns(set('mind', 'cycle'))
    expect(await get<Category[]>('prefs', 'ai-answer-opt-ins')).toEqual(['cycle', 'mind'])
    expect(await loadOptIns()).toEqual(set('cycle', 'mind'))
  })

  it('records turning the last category back off, rather than leaving the old one', async () => {
    await saveOptIns(set('cycle'))
    await saveOptIns(set())
    expect(await loadOptIns()).toEqual(new Set())
  })

  it('drops a stored category that is no longer opt-in', async () => {
    // A value written by a build with a different taxonomy must never re-open
    // something the current one does not treat as a switch.
    await get('prefs', 'ai-answer-opt-ins')
    await saveOptIns(set('cycle'))
    const { put } = await import('../db')
    await put('prefs', ['cycle', 'vital'], 'ai-answer-opt-ins')
    expect(await loadOptIns()).toEqual(set('cycle'))
  })
})

describe('includeList', () => {
  it('is the whole set of switch positions, in a stable order', () => {
    expect(includeList(set('mind', 'cycle'))).toEqual(['cycle', 'mind'])
    expect(includeList(set('mind'))).toEqual(['mind'])
  })

  it('is empty — not absent — when nothing is on, so "none" can be instructed', () => {
    expect(includeList(set())).toEqual([])
  })
})
