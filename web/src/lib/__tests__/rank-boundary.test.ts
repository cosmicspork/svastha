// The JS -> Rust boundary itself, driven with the real wasm module.
//
// ask.test.ts mocks `../svastha` wholesale, which is right for testing what
// leaves the device but leaves the boundary untested: a renamed field on either
// side of `rank_context` would pass every test in both languages and ship a PWA
// that silently retrieves nothing. So this file loads the actual compiled
// module and asserts on what comes back.
//
// The wasm package is a build artifact (`bun run wasm`, gitignored); both
// `bun run check` and `bun run test` build it first, so the import below is
// always satisfied by the time vitest runs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { rank_context } from '../../wasm/svastha'

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

function rank(candidates: unknown[], question: string): ContextItem[] {
  return JSON.parse(rank_context(JSON.stringify(candidates), question, 12)) as ContextItem[]
}

describe('rank_context across the wasm boundary', () => {
  it('returns the ranker order, with the fields ask.ts reads', () => {
    const items = rank([lisinopril, metformin], 'am i on metformin or lisinopril')
    expect(items.map((i) => i.event_id)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(items[0].text).toContain('Metformin 500 MG')
    expect(items[0].score).toBeGreaterThan(items[1].score)
  })

  // The property ask.ts depends on to answer honestly without calling a model.
  it('returns nothing for a question the record cannot answer', () => {
    expect(rank([metformin, lisinopril], 'what vaccines have i had')).toEqual([])
  })

  // Contract skew in a deployed PWA costs the one event, not the question.
  it('ranks the candidates it can decode and drops the ones it cannot', () => {
    const broken = { ...metformin, event: { ...metformin.event, kind: 'kind_from_a_newer_contract' } }
    const items = rank([broken, lisinopril], 'am i on lisinopril')
    expect(items.map((i) => i.event_id)).toEqual(['b'.repeat(64)])
  })
})
