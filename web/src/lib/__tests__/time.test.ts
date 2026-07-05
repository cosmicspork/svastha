import { describe, expect, it } from 'vitest'
import { toLocalIso, dayKey, formatTime, formatDay, isoToMillis, addHoursIso } from '../time'

/** The expected `±HH:MM` suffix for a date in the runner's local timezone —
 * derived independently of toLocalIso so the tests hold in any TZ. */
function expectedOffset(date: Date): string {
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

describe('toLocalIso', () => {
  it('emits second precision with an explicit local offset', () => {
    const date = new Date(2026, 6, 4, 8, 30, 0)
    const iso = toLocalIso(date)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/)
    expect(iso.startsWith('2026-07-04T08:30:00')).toBe(true)
    expect(iso.endsWith(expectedOffset(date))).toBe(true)
  })

  it('uses the offset in effect at that date, not today (DST)', () => {
    // In a DST timezone these differ; in a fixed-offset timezone both still
    // match their own date's offset.
    const winter = new Date(2026, 0, 15, 12, 0, 0)
    const summer = new Date(2026, 6, 15, 12, 0, 0)
    expect(toLocalIso(winter).endsWith(expectedOffset(winter))).toBe(true)
    expect(toLocalIso(summer).endsWith(expectedOffset(summer))).toBe(true)
  })

  it('rounds to the nearest minute, seconds pinned to :00', () => {
    expect(toLocalIso(new Date(2026, 6, 4, 8, 30, 29))).toContain('T08:30:00')
    expect(toLocalIso(new Date(2026, 6, 4, 8, 30, 31))).toContain('T08:31:00')
  })

  it('rounding across midnight moves the date forward', () => {
    const iso = toLocalIso(new Date(2026, 6, 3, 23, 59, 45))
    expect(iso.startsWith('2026-07-04T00:00:00')).toBe(true)
  })
})

describe('dayKey', () => {
  it('reads the local calendar day straight off the string', () => {
    expect(dayKey('2026-07-04T00:00:00-05:00')).toBe('2026-07-04')
    expect(dayKey('2026-07-04T23:59:00+14:00')).toBe('2026-07-04')
  })

  it('agrees with toLocalIso around midnight', () => {
    expect(dayKey(toLocalIso(new Date(2026, 6, 4, 0, 0, 0)))).toBe('2026-07-04')
    expect(dayKey(toLocalIso(new Date(2026, 6, 3, 23, 59, 0)))).toBe('2026-07-03')
  })
})

describe('formatTime', () => {
  it('formats wall-clock time without timezone conversion', () => {
    expect(formatTime('2026-07-04T08:30:00-05:00')).toBe('8:30 AM')
    expect(formatTime('2026-07-04T00:05:00-05:00')).toBe('12:05 AM')
    expect(formatTime('2026-07-04T12:00:00+09:00')).toBe('12:00 PM')
    expect(formatTime('2026-07-04T23:59:00Z')).toBe('11:59 PM')
  })
})

describe('isoToMillis', () => {
  it('is a true instant comparison, not a lexical string comparison', () => {
    // Same instant, two different (both valid) offset spellings — a lexical
    // string comparison would treat these as unequal or misordered.
    expect(isoToMillis('2026-07-04T12:00:00+00:00')).toBe(isoToMillis('2026-07-04T07:00:00-05:00'))
  })
})

describe('addHoursIso', () => {
  // Built from toLocalIso(new Date(...)) rather than a hardcoded offset
  // string, same reasoning as expectedOffset() above: this file doesn't pin
  // a timezone, so the expected offset has to be whatever the runner's own
  // zone says. None of these three dates are near a DST transition in any
  // real-world zone, so wall-clock and real-elapsed-time addition agree —
  // the boundary-crossing case (where they don't) is dst.test.ts's job.
  it('adds whole hours', () => {
    const start = toLocalIso(new Date(2026, 6, 4, 8, 30, 0))
    expect(addHoursIso(start, 3)).toBe(toLocalIso(new Date(2026, 6, 4, 11, 30, 0)))
  })

  it('adds fractional hours', () => {
    const start = toLocalIso(new Date(2026, 6, 4, 8, 0, 0))
    expect(addHoursIso(start, 1.5)).toBe(toLocalIso(new Date(2026, 6, 4, 9, 30, 0)))
  })

  it('supports negative hours (looking backward)', () => {
    const start = toLocalIso(new Date(2026, 6, 4, 8, 0, 0))
    expect(addHoursIso(start, -2)).toBe(toLocalIso(new Date(2026, 6, 4, 6, 0, 0)))
  })
})

describe('formatDay', () => {
  it('labels today and yesterday relatively', () => {
    const now = new Date()
    const today = dayKey(toLocalIso(now))
    expect(formatDay(today)).toBe('Today')

    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    expect(formatDay(dayKey(toLocalIso(y)))).toBe('Yesterday')
  })

  it('labels older days with weekday and date', () => {
    // A Saturday, far in the past so it can never collide with today.
    expect(formatDay('2020-02-01')).toMatch(/Saturday/)
    expect(formatDay('2020-02-01')).toMatch(/1/)
  })
})
