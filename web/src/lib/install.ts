// Standalone/platform detection and the "have we nudged this device to
// install yet" pref, backing the first-run InstallSheet (see
// components/InstallSheet.svelte).
import { get, put } from './db'

const PREFS_KEY = 'install-nudge-dismissed'

/** True once the PWA is running from a home-screen icon rather than a browser
 * tab. `navigator.standalone` is iOS Safari's pre-standard legacy flag —
 * display-mode: standalone never matches there. */
export function isStandalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

/** True on iPhone/iPad, including iPadOS 13+ which disguises its UA as a Mac
 * — `maxTouchPoints > 1` is the standard way to tell those apart from an
 * actual (non-touch) Mac. */
export function isIos(): boolean {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/** Whether the first-run install sheet should be shown: not if already
 * standalone, and not if the user already dismissed it once (ever). */
export async function shouldNudgeInstall(): Promise<boolean> {
  if (isStandalone()) return false
  const dismissed = await get<boolean>('prefs', PREFS_KEY)
  return !dismissed
}

/** Persists that the sheet was dismissed (either button) so it never shows
 * again on this device. */
export async function dismissInstallNudge(): Promise<void> {
  await put('prefs', true, PREFS_KEY)
}
