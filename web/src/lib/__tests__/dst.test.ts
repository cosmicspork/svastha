// DST-crossing correctness for correlate.ts / time.ts's real-instant time
// math. Pinned to a fixed zone with a known 2026 transition (America/Chicago:
// spring-forward Mar 8, fall-back Nov 1 — see the git history for how these
// were derived by scanning `getTimezoneOffset()`), set BEFORE any import so
// every `Date`/`toLocaleString` call in this file resolves against it
// regardless of the runner's own machine timezone.
//
// vitest runs under Node, where `process` exists, but tsconfig.app.json
// typechecks against DOM libs only — declare the one property this file
// needs rather than pulling all of @types/node into the app's typecheck
// (same reasoning as sync.test.ts's `declare function setImmediate`).
declare const process: { env: Record<string, string | undefined> }
process.env.TZ = 'America/Chicago'

import { describe, expect, it } from 'vitest'
import { addHoursIso } from '../time'
import { preceding } from '../correlate'
import type { StoredEvent } from '../events'

let nextId = 0
function foodEvent(effective_at: string, item: string): StoredEvent {
  return {
    event: {
      id: `evt-${nextId++}`,
      kind: 'nutrition_intake',
      code: null,
      effective_at,
      value: { text: item },
      provenance: { source: 'self', source_doc: null },
    },
    author: 'author-hex',
    signature: 'signature-hex',
  }
}

describe('addHoursIso across a DST boundary (America/Chicago, 2026)', () => {
  it('spring-forward (Mar 8, 2am -> 3am): adding 2 real hours skips the lost hour on the wall clock', () => {
    expect(addHoursIso('2026-03-08T01:30:00-06:00', 2)).toBe('2026-03-08T04:30:00-05:00')
  })

  it('fall-back (Nov 1, 2am -> 1am): adding 2 real hours only advances the wall clock by 1', () => {
    expect(addHoursIso('2026-11-01T00:30:00-05:00', 2)).toBe('2026-11-01T01:30:00-06:00')
  })
})

describe('preceding() window math across the spring-forward boundary', () => {
  it('computes real elapsed hours, not naive wall-clock subtraction', () => {
    // Wall-clock subtraction (04:00 - 01:15 = 2h45m) would overcount by the
    // skipped hour; the true elapsed time is 1h45m (1.75h), since one of
    // those clock-hours never happened. A 2h window should include this item
    // under the correct (real-instant) math and wrongly exclude it under a
    // naive wall-clock one, so this test pins the correct behavior.
    const symptomAt = '2026-03-08T04:00:00-05:00'
    const events = [foodEvent('2026-03-08T01:15:00-06:00', 'toast')]

    const result = preceding(events, symptomAt, 2)
    expect(result).toHaveLength(1)
    expect(result[0].deltaHours).toBeCloseTo(1.75, 5)
  })
})
