// The JS -> Rust boundary itself, driven with the real wasm module and the real
// candidate builder.
//
// ask.test.ts mocks `../svastha` wholesale, which is right for testing what
// leaves the device but leaves the boundary untested: a renamed field on either
// side of `rank_context` would pass every test in both languages and ship a PWA
// that silently retrieves nothing. So this file loads the actual compiled module
// and asserts on what comes back.
//
// It also runs the browser-specific layer the shared crate deliberately does not
// own — `conceptKey` / `codingFor` / `resolveName` / `buildCandidates` — because
// that layer is where the node and the browser actually drifted apart, and a
// hand-written candidate would not exercise it at all.
//
// The wasm package is a build artifact (`bun run wasm`, gitignored); both
// `bun run check` and `bun run test` build it first, so the import below is
// always satisfied by the time vitest runs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import init, { rank_context } from '../../wasm/svastha'

// `../ask` reaches IndexedDB and the session rune at module scope (through
// inference.ts), which node vitest has neither of. Everything that decides a
// *name* — summary.ts, code-names.ts, ask.ts itself — stays real.
vi.mock('../db', () => ({
  get: vi.fn(async () => undefined),
  put: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
}))
vi.mock('../session.svelte', () => ({ session: { vaultKey: null } }))

import { buildCandidates } from '../ask'
import type { StoredEvent } from '../events'

// wasm-pack's `web` target fetches its own `.wasm` relative to import.meta.url,
// which node cannot do for a file: URL — hand it the bytes instead.
beforeAll(async () => {
  // `.href`, not the URL object: the app's tsconfig has the DOM lib, whose URL
  // type is not node's.
  const wasm = fileURLToPath(new URL('../../wasm/svastha_bg.wasm', import.meta.url).href)
  await init({ module_or_path: readFileSync(wasm) })
})

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

/** A candidate in exactly the shape `buildCandidates` produces. */
function candidate(id: string, code: string, display: string, effective_at: string) {
  return {
    event: {
      id: id.repeat(64),
      kind: 'medication_statement',
      code: { system: RXNORM, code, display },
      effective_at,
      value: null,
      provenance: { source: 'import', source_doc: null },
    },
    name: display,
    status: 'active',
  }
}

const metformin = candidate('a', '860975', 'Metformin 500 MG', '2024-03-02')
const lisinopril = candidate('b', '197361', 'Lisinopril 10 MG', '2010-05-05')

interface ContextItem {
  event_id: string
  text: string
  score: number
}
interface Ranked {
  items: ContextItem[]
  unreadable: number
}

function rank(candidates: unknown[], question: string): Ranked {
  return JSON.parse(rank_context(JSON.stringify(candidates), question, 12)) as Ranked
}

describe('rank_context across the wasm boundary', () => {
  it('returns the ranker order, with the fields ask.ts reads', () => {
    const { items, unreadable } = rank([lisinopril, metformin], 'am i on metformin or lisinopril')
    expect(items.map((i) => i.event_id)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(items[0].text).toContain('Metformin 500 MG')
    expect(items[0].score).toBeGreaterThan(items[1].score)
    expect(unreadable).toBe(0)
  })

  // The property ask.ts depends on to answer honestly without calling a model.
  it('returns nothing for a question the record cannot answer', () => {
    expect(rank([metformin, lisinopril], 'what vaccines have i had').items).toEqual([])
  })

  // Contract skew in a deployed PWA costs the one event, not the question — and
  // is reported, so the caller can say the answer was drawn from a partial
  // record instead of presenting it as complete.
  it('ranks the candidates it can decode and counts the ones it cannot', () => {
    const broken = {
      ...metformin,
      event: { ...metformin.event, kind: 'kind_from_a_newer_contract' },
    }
    const { items, unreadable } = rank([broken, lisinopril], 'am i on lisinopril')
    expect(items.map((i) => i.event_id)).toEqual(['b'.repeat(64)])
    expect(unreadable).toBe(1)
  })

  it('reports unreadable candidates even when nothing ranks at all', () => {
    const broken = {
      ...metformin,
      event: { ...metformin.event, kind: 'kind_from_a_newer_contract' },
    }
    expect(rank([broken], 'am i on metformin')).toEqual({ items: [], unreadable: 1 })
  })
})

// The line the model reads has to be identical on both clients. The node asserts
// this same string in `crates/node/src/retrieval.rs`
// (`an_allergy_renders_identically_on_the_node_and_in_the_browser`); if either
// side moves, one of the two tests fails.
const ALLERGY_LINE = 'allergy_intolerance 2024-01-01 Peanut'

describe('the browser name chain, against the node', () => {
  // An allergy is the case that drifted: it imports with `code: null` and its
  // substance in `value.coded`, so a resolver that only reads `event.code` puts
  // the bare kind in the name slot. This builds the candidate the way the app
  // does — through the real conceptKey/codingFor/resolveName — rather than
  // asserting a name a test author chose.
  const allergy = {
    event: {
      id: 'c'.repeat(64),
      kind: 'allergy_intolerance',
      code: null,
      effective_at: '2024-01-01',
      value: { coded: { system: 'http://snomed.info/sct', code: '256349002', display: 'Peanut' } },
      provenance: { source: 'import', source_doc: null },
    },
  } as unknown as StoredEvent

  it('renders an allergy exactly as the node renders it', () => {
    const candidates = buildCandidates([allergy], new Map(), new Map(), new Map(), new Map())
    expect(candidates[0].name).toBe('Peanut')

    const { items } = rank(candidates, 'peanut allergy')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe(ALLERGY_LINE)
  })

  // The owner's rename still wins over the coded substance, and still reaches
  // the model as the name.
  it('lets a name: override replace the substance', () => {
    const names = new Map([['allergy_intolerance|http://snomed.info/sct|256349002', 'Groundnut']])
    const candidates = buildCandidates([allergy], new Map(), names, new Map(), new Map())
    expect(candidates[0].name).toBe('Groundnut')
    expect(rank(candidates, 'groundnut allergy').items[0].text).toContain('Groundnut')
  })
})
