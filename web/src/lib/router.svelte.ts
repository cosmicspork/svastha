// Hand-rolled hash router — the app has five screens and no nested layouts, so
// a routing library would be pure overhead. Match logic lives in
// ./router-match.ts so it can be unit tested without runes.
import { matchRoute, type RouteMatch } from './router-match'
import { NavStack } from './nav-stack'

function currentHash(): string {
  return (typeof window === 'undefined' ? '' : window.location.hash) || '#/'
}

// Records screens as they are left so back() can return to the previous one.
const history = new NavStack()

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
  const from = currentHash()
  if (from === hash) {
    sync() // same hash won't fire hashchange; sync so params still update
    return
  }
  history.push(from)
  window.location.hash = hash
}

/**
 * Return to the previously visited screen, falling back to the dashboard when
 * there is no history (a fresh deep-link). Does not itself push, so repeated
 * Back walks the stack rather than ping-ponging.
 */
export function back(): void {
  const to = history.pop() ?? '#/'
  if (currentHash() === to) {
    sync()
  } else {
    window.location.hash = to
  }
}

export function canGoBack(): boolean {
  return history.canGoBack
}

export { matchRoute }
