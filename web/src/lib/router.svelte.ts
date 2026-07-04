// Hand-rolled hash router — the app has five screens and no nested layouts, so
// a routing library would be pure overhead. Match logic lives in
// ./router-match.ts so it can be unit tested without runes.
import { matchRoute, type RouteMatch } from './router-match'

function currentHash(): string {
  return typeof window === 'undefined' ? '#/' : window.location.hash
}

export const route: RouteMatch = $state(matchRoute(currentHash()))

function sync() {
  const next = matchRoute(currentHash())
  route.path = next.path
  route.params = next.params
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', sync)
}

/** Navigate to a hash, e.g. `navigate('#/log/vitals')`. */
export function navigate(hash: string): void {
  if (window.location.hash === hash) {
    sync() // same hash won't fire hashchange; sync so params still update
  } else {
    window.location.hash = hash
  }
}

export { matchRoute }
