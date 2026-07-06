// The in-app theme preference. Layered on top of tokens.css's OS-driven
// light-dark(): 'system' leaves color-scheme resolution to the OS (no
// data-theme attribute), while 'light'/'dark' pin it via the attribute
// selectors there.
import { get, put } from './db'

export type ThemePref = 'light' | 'dark' | 'system'

const PREFS_KEY = 'theme'

// Must match tokens.css's --bg for each palette exactly — this is the forced
// value written into the theme-color metas below, standing in for whichever
// side of light-dark() the OS would otherwise have picked.
const BG = { light: '#F2F5F1', dark: '#161D1A' } as const

export async function loadTheme(): Promise<ThemePref> {
  const stored = await get<ThemePref>('prefs', PREFS_KEY)
  return stored ?? 'system'
}

export async function setTheme(pref: ThemePref): Promise<void> {
  await put('prefs', pref, PREFS_KEY)
  applyTheme(pref)
}

/** Sets/removes `data-theme` on the root, and forces both `<meta
 * name="theme-color">` tags (one per prefers-color-scheme media attr, in
 * index.html) to agree with the override — those media attrs otherwise
 * ignore the app-level pref and keep following the OS regardless. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', pref)
  }

  const lightMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
  )
  const darkMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
  )

  const forced = pref === 'system' ? null : BG[pref]
  if (lightMeta) lightMeta.content = forced ?? BG.light
  if (darkMeta) darkMeta.content = forced ?? BG.dark
}
