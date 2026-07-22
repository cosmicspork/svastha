// Local-time formatting for `effective_at`. `toLocalIso` is the SINGLE
// serializer every caller must use to produce that field: event content ids
// are hashed over the exact string (see crates/core/src/event.rs
// `canonical_content`), so two call sites that format the same instant
// differently would silently mint two different ids for "the same" fact.

/** Zero-pad to two digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * ISO-8601 with an explicit local UTC offset and second precision, seconds
 * always `:00` — quick-log only ever captures "now" or a minute picked from a
 * `datetime-local` input, neither of which has meaningful sub-minute
 * precision, so rounding to the minute keeps re-entering "the same" time
 * (e.g. re-opening the Earlier picker) content-stable.
 *
 * Deliberately local wall-clock + offset, not UTC: `dayKey`/`formatTime` below
 * read the string directly rather than re-converting through the *current*
 * device timezone, so a record made while traveling still displays the time
 * it was actually logged.
 */
export function toLocalIso(date: Date): string {
  const rounded = new Date(Math.round(date.getTime() / 60_000) * 60_000)

  const offsetMin = -rounded.getTimezoneOffset() // minutes east of UTC
  const sign = offsetMin >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMin)
  const offset = `${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`

  const date_ = `${rounded.getFullYear()}-${pad2(rounded.getMonth() + 1)}-${pad2(rounded.getDate())}`
  const time = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}:00`
  return `${date_}T${time}${offset}`
}

/** Local `YYYY-MM-DD` for day-grouping. Because `toLocalIso` never converts to
 * UTC, the date segment of any `effective_at` it produced is already the
 * correct local calendar day — no re-parsing (and no DST edge cases) needed. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

/** `h:mm AM/PM`, read straight from the string's wall-clock fields (see
 * `toLocalIso`'s doc comment on why this doesn't go through `Date`). */
export function formatTime(iso: string): string {
  const match = iso.match(/T(\d{2}):(\d{2})/)
  if (!match) return ''
  const hour24 = Number(match[1])
  const minute = match[2]
  const suffix = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 % 12 || 12
  return `${hour12}:${minute} ${suffix}`
}

/** True-instant milliseconds for an ISO string produced by `toLocalIso` (or
 * any other valid ISO-8601 offset string). Deliberately NOT a lexical string
 * comparison: two `toLocalIso` strings that straddle a DST boundary carry
 * different UTC offsets, so comparing the date/time characters directly can
 * misorder them. `Date` parses the offset correctly, so its epoch millis is
 * the one true ordering. */
export function isoToMillis(iso: string): number {
  return new Date(iso).getTime()
}

/** Add (possibly fractional, possibly negative) hours to an ISO instant and
 * re-serialize as local wall-clock time. DST-safe: the addition happens in
 * real elapsed milliseconds (via `Date`, not by editing the string's hour
 * field), and `toLocalIso` then reads whichever UTC offset is in effect at
 * the *result* instant — so "2 hours after 1:30 AM" on a spring-forward day
 * correctly lands on 4:30 AM wall-clock (1 real hour of which is the
 * skipped 2 AM hour), not 3:30 AM. Used by correlate.ts for window math. */
export function addHoursIso(iso: string, hours: number): string {
  return toLocalIso(new Date(new Date(iso).getTime() + hours * 3_600_000))
}

/** A compact "how long ago" for an ISO instant: "just now", "5m", "3h", "2d",
 * then a plain date past a week. Pure over `now` (millis) so it unit-tests
 * without a wall clock; used by the notification list where a coarse relative
 * time reads better than a full timestamp. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const deltaMs = now - isoToMillis(iso)
  const mins = Math.floor(deltaMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(isoToMillis(iso)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Today" / "Yesterday" / weekday + date, relative to the device's current
 * local date. */
export function formatDay(key: string): string {
  const today = dayKey(toLocalIso(new Date()))
  if (key === today) return 'Today'

  // Constructing from the bare date (no offset) parses as local midnight, so
  // this stays comparable to `today`/`key` (also local dates) without
  // reintroducing a timezone conversion.
  const yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dayKey(toLocalIso(yesterday))) return 'Yesterday'

  const d = new Date(`${key}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}
