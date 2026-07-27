// Generates every app-icon asset from the one geometry definition in
// src/lib/mark.ts: the three SVG masters, plus the four PNGs the web manifest
// and iOS actually load. Run with bun, from web/:
//
//   bun run icons
//
// Regeneration is MANUAL and the outputs ARE committed, like
// scripts/build-code-dictionary and unlike scripts/build-changelog: the web CI
// job installs no browser (only the e2e job does), and the mark changes about
// once a year, so re-deriving byte-identical files on every build is waste.
//
// Rasterisation goes through Playwright because it is already a devDependency
// (the README screenshots are generated the same way, see e2e/screenshots.spec.ts),
// which keeps a whole native image toolchain out of the dependency tree for the
// sake of four files.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { fiddlehead, VIEW_BOX } from '../../src/lib/mark.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(SCRIPT_DIR, '..', '..', 'public')
const ICONS_DIR = join(PUBLIC_DIR, 'icons')

// Mirrors --bg / --action in src/styles/tokens.css. Duplicated rather than
// imported because a build script cannot read CSS custom properties; if the
// palette moves there, move it here in the same commit.
const PLATE_LIGHT = '#F2F5F1'
const MARK_LIGHT = '#3E6B4F'
const PLATE_DARK = '#161D1A'
const MARK_DARK = '#5C9172'

/** Corner radius of the app-icon squircle, in viewBox units (21.9% of 512). */
const RADIUS = 112

interface SvgOptions {
  /** Maskable icons bleed to the edge: the launcher supplies the mask. */
  bleed?: boolean
  /** Rendered width/height attributes. The viewBox is always VIEW_BOX. */
  size?: number
  /** Follow the reader's colour scheme instead of baking the light palette. */
  themeAware?: boolean
  small?: boolean
}

function svg({ bleed = false, size = VIEW_BOX, themeAware = false, small = false }: SvgOptions): string {
  const d = fiddlehead(small)
  const plate = themeAware ? 'var(--plate)' : PLATE_LIGHT
  const ink = themeAware ? 'var(--mark)' : MARK_LIGHT
  // :root matches the <svg> element in a standalone SVG document, which is how a
  // favicon is loaded — so this tracks the browser chrome's light/dark setting.
  const theme = themeAware
    ? `\n  <style>\n    :root { --plate: ${PLATE_LIGHT}; --mark: ${MARK_LIGHT}; }\n` +
      `    @media (prefers-color-scheme: dark) {\n` +
      `      :root { --plate: ${PLATE_DARK}; --mark: ${MARK_DARK}; }\n    }\n  </style>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}"` +
    ` width="${size}" height="${size}">${theme}\n` +
    `  <rect width="${VIEW_BOX}" height="${VIEW_BOX}"${bleed ? '' : ` rx="${RADIUS}"`} fill="${plate}"/>\n` +
    `  <path d="${d}" fill="${ink}"/>\n` +
    `</svg>\n`
  )
}

const SVGS = [
  { path: join(ICONS_DIR, 'icon.svg'), body: svg({}) },
  { path: join(ICONS_DIR, 'icon-maskable.svg'), body: svg({ bleed: true }) },
  // The only asset the browser re-renders, so the only one that can follow the
  // OS theme.
  { path: join(PUBLIC_DIR, 'favicon.svg'), body: svg({ size: 32, themeAware: true, small: true }) },
]

// Every PNG is a static bitmap, so all of them bake the light plate — a launcher
// or springboard never asks an icon to re-render for dark mode.
const PNGS = [
  { out: 'apple-touch-icon.png', size: 180, bleed: false },
  { out: 'icon-192.png', size: 192, bleed: false },
  { out: 'icon-512.png', size: 512, bleed: false },
  { out: 'maskable-512.png', size: 512, bleed: true },
]

mkdirSync(ICONS_DIR, { recursive: true })
for (const { path, body } of SVGS) {
  writeFileSync(path, body)
  console.log(`icons: wrote ${path}`)
}

const browser = await chromium.launch()
try {
  for (const { out, size, bleed } of PNGS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    // Inline rather than navigating to the .svg file: a standalone SVG document
    // is laid out at its intrinsic size, so it would not scale to the viewport.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden}</style>` + svg({ bleed, size }),
    )
    const path = join(ICONS_DIR, out)
    await page.screenshot({ path })
    await page.close()
    console.log(`icons: wrote ${path} (${size}x${size})`)
  }
} finally {
  await browser.close()
}
