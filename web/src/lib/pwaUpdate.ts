// Bridges the service-worker update handle from main.ts (where `registerSW`
// returns it, once, at app boot) to the UI action that applies it
// (UpdateSheet's "Relaunch now", surfaced arbitrarily later via the
// notification the SW's onNeedRefresh fires). A plain module-level binding
// rather than a store: there is at most one pending updateSW function for the
// life of the tab, and nothing needs to react to it changing — it either
// exists by the time the user taps Relaunch, or (dev / pre-onNeedRefresh) it
// doesn't and the tap is a no-op.
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null

export function setUpdateHandler(fn: (reloadPage?: boolean) => Promise<void>): void {
  applyUpdate = fn
}

/** Applies the waiting service worker and reloads. No-ops if no update is
 * pending (e.g. tapped before onNeedRefresh ever fired). */
export async function relaunchForUpdate(): Promise<void> {
  if (applyUpdate) await applyUpdate(true)
}
