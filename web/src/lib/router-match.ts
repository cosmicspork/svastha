// Pure route matching, split out from router.svelte.ts so it can be unit
// tested without pulling in Svelte runes (vitest runs outside a component
// context).

export interface RouteMatch {
  /** The matched route *pattern* (e.g. `/log/:kind`), not the literal path —
   * callers switch on this, so the dynamic segment name is more useful than
   * its value (which is in `params`). */
  path: string
  params: Record<string, string>
}

const KNOWN_PATTERNS = [
  '/',
  '/log/:kind',
  '/onboard',
  '/unlock',
  '/settings',
  '/settings/appearance',
  '/settings/security',
  '/settings/sync',
  '/settings/devices',
  '/settings/data',
  '/settings/about',
  '/share',
  '/share/people',
  '/share/doctor',
  '/proposals',
  '/ask',
  // A doctor-share cold-load link. The single `:frag` segment is
  // `{token}.{key}.{relay}`; the fragment is parsed in shareRecipient.ts, not
  // here (this router only needs to route to the share view). The bare `/s` (no
  // fragment) is the relay-less file-open entry — the same cold ShareView, in
  // "open a share file" mode (see fileShare.ts).
  '/s',
  '/s/:frag',
  '/person/:ed',
  '/import',
  '/correlate',
]

/** Split a pattern and a concrete path into same-length segment arrays, or
 * `null` if the segment counts differ. */
function segments(s: string): string[] {
  return s.split('/').filter(Boolean)
}

/** Match one pattern (e.g. `/log/:kind`) against a concrete path. */
function matchOne(pattern: string, path: string): RouteMatch | null {
  const patternSegs = segments(pattern)
  const pathSegs = segments(path)
  if (patternSegs.length !== pathSegs.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i]
    const s = pathSegs[i]
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(s)
    } else if (p !== s) {
      return null
    }
  }
  return { path: pattern, params }
}

/**
 * Match a `#`-prefixed hash against the known route patterns, falling back to
 * `/` for anything unrecognized. `hash` may be `''`, `'#'`, or `'#/log/vitals'`.
 */
export function matchRoute(hash: string): RouteMatch {
  const path = (hash.replace(/^#/, '') || '/').split('?')[0]
  for (const pattern of KNOWN_PATTERNS) {
    const match = matchOne(pattern, path)
    if (match) return match
  }
  return { path: '/', params: {} }
}
