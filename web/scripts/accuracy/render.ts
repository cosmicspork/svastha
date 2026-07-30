// Turn each {@link FixtureSpec} into the page image the accuracy harness reads
// and the answer key it is scored against.
//
// **The output is committed; this script is not run by the harness.** Text
// rasterization is not reproducible across machines — a different Chromium, a
// different freetype, different hinting, and the same HTML lands on different
// pixels. A harness that re-rendered its own inputs would therefore score a
// slightly different page on every developer's machine and quietly stop being a
// comparison. So the PNGs under `fixtures/ocr/` are the fixture; this script is
// how they were made and how to make them again deliberately.
//
// Fonts come from the app's own `@fontsource` packages, inlined as data URIs
// rather than named, so at least the typeset pages do not depend on what
// happens to be installed. The hand-style pages have no such option — see
// `CURSIVE_STACK`.
//
// Usage: `bun run scripts/accuracy/render.ts` from `web/`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { FIXTURES, type FixtureSpec, type Row } from './fixtures.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')
const OUT = join(WEB, '..', 'fixtures', 'ocr')

/** A4 at 150 dpi — a realistic scan resolution, and comfortably inside the
 * node's per-page pixel budget (`crates/node/src/transcribe.rs`). */
const PAGE_WIDTH = 1240
const PAGE_HEIGHT = 1754

/** Cursive faces, in preference order. None of these ships with the repo, so a
 * hand-style page can only be regenerated on a machine that has one — which is
 * exactly why the rendered PNG is committed. The script refuses rather than
 * falling back to a sans-serif: a "handwriting" fixture that quietly rendered
 * as typeset text would report a reader as handling handwriting when it had
 * never seen any. */
const CURSIVE_STACK = ['Z003', 'URW Chancery L', 'Apple Chancery', 'Segoe Script', 'Comic Sans MS']

/** Deterministic PRNG, so the per-glyph jitter on the hand-style pages is the
 * same every regeneration and only the font can move the pixels. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Per-fixture seed, so each page gets its own jitter but always the same one. */
function seedFrom(name: string): number {
  let h = 2166136261
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Wrap every glyph in its own span with a small rotation and offset. A cursive
 * font alone is still mechanically regular — identical letterforms, a perfect
 * baseline — which is the part of real handwriting that is easiest for a
 * recognizer. The jitter takes that regularity away. */
function jitter(text: string, rand: () => number): string {
  return [...text]
    .map((ch) => {
      if (ch === ' ') return ' '
      const rot = (rand() * 6 - 3).toFixed(2)
      const dy = (rand() * 4 - 2).toFixed(2)
      const dx = (rand() * 1.6 - 0.8).toFixed(2)
      return `<span style="display:inline-block;transform:translate(${dx}px,${dy}px) rotate(${rot}deg)">${escapeHtml(ch)}</span>`
    })
    .join('')
}

async function fontFace(family: string, pkg: string, file: string, weight: number): Promise<string> {
  const bytes = await readFile(join(WEB, 'node_modules', '@fontsource', pkg, 'files', file))
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`
}

function cell(text: string, hand: boolean, rand: () => number): string {
  return hand ? jitter(text, rand) : escapeHtml(text)
}

function rowHtml(row: Row, hand: boolean, rand: () => number): string {
  return `<tr>
    <td class="analyte">${cell(row.analyte, hand, rand)}</td>
    <td class="value">${cell(row.value, hand, rand)}</td>
    <td class="unit">${cell(row.unit, hand, rand)}</td>
    <td class="range">${cell(row.range, hand, rand)}</td>
  </tr>`
}

function pageHtml(spec: FixtureSpec, fonts: string): string {
  const hand = spec.hand === true
  const rand = mulberry32(seedFrom(spec.name))
  const body = spec.sections
    .map(
      (section) => `<h2>${cell(section.header, hand, rand)}</h2>
      <table>
        <thead><tr>
          <th class="analyte">${cell('Analyte', hand, rand)}</th>
          <th class="value">${cell('Result', hand, rand)}</th>
          <th class="unit">${cell('Unit', hand, rand)}</th>
          <th class="range">${cell('Reference', hand, rand)}</th>
        </tr></thead>
        <tbody>${section.rows.map((r) => rowHtml(r, hand, rand)).join('')}</tbody>
      </table>`,
    )
    .join('')

  // The typeset pages use the app's own mono face — a lab printout is tabular
  // and monospace is what such printers actually produce.
  const family = hand ? CURSIVE_STACK.map((f) => `'${f}'`).join(',') : "'Plex Mono'"
  const rowLeading = spec.tight === true ? '1' : '1.6'
  const skew = spec.skewDeg ?? 0

  return `<!doctype html><meta charset="utf-8"><style>
    ${fonts}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${PAGE_WIDTH}px;height:${PAGE_HEIGHT}px;background:#fff}
    .page{width:100%;height:100%;padding:90px 80px;transform:rotate(${skew}deg);transform-origin:center center}
    body{font-family:${family};color:#111;font-size:${hand ? 30 : 24}px}
    h1{font-size:${hand ? 34 : 27}px;font-weight:700;margin-bottom:6px}
    .meta{font-size:${hand ? 28 : 21}px;margin-bottom:${spec.tight === true ? 18 : 40}px}
    /* Several times the row height, on purpose: this is the tall run that a
       band-from-the-tallest-member grouper stretches over the rows below. */
    h2{font-size:${hand ? 40 : 44}px;font-weight:700;margin:${spec.tight === true ? '10px 0 2px' : '34px 0 14px'}}
    table{border-collapse:collapse;width:100%}
    th{text-align:left;font-weight:700}
    th,td{line-height:${rowLeading};padding:0;vertical-align:baseline;white-space:nowrap}
    .analyte{width:38%}
    .value{width:18%}
    .unit{width:20%}
    .range{width:24%}
  </style>
  <div class="page">
    <h1>${cell(spec.lab, hand, rand)}</h1>
    <div class="meta">${cell(`Patient: Synthetic Test`, hand, rand)}<br>${cell(`Collected: ${spec.collected}`, hand, rand)}</div>
    ${body}
  </div>`
}

/** The answer key: every printed result row, and nothing else on the page.
 *
 * Reference ranges are deliberately absent even though they are printed — a
 * reader that reports `Sodium 135` has read the low end of the range as the
 * result, and that has to score as a miss and a false positive, not a hit. */
function truth(spec: FixtureSpec) {
  return {
    page: `${spec.name}.png`,
    note: spec.note,
    hazard: spec.hazard,
    synthetic: true,
    expected: spec.sections.flatMap((s) =>
      s.rows.map((r) => ({ analyte: r.analyte, value: r.value, unit: r.unit })),
    ),
  }
}

async function main(): Promise<void> {
  const fonts = [
    await fontFace('Plex Mono', 'ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 400),
    await fontFace('Plex Mono', 'ibm-plex-mono', 'ibm-plex-mono-latin-700-normal.woff2', 700),
  ].join('\n')

  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT } })

  // Refuse before writing anything if no cursive face is installed, rather
  // than emitting typeset pages under handwriting filenames.
  if (FIXTURES.some((f) => f.hand === true)) {
    const available: string[] = await page.evaluate(
      `(${JSON.stringify(CURSIVE_STACK)}).filter((f) => document.fonts.check('32px "' + f + '"'))`,
    )
    if (available.length === 0) {
      await browser.close()
      throw new Error(
        `no cursive font installed (looked for ${CURSIVE_STACK.join(', ')}). The hand-style ` +
          `fixtures cannot be regenerated on this machine; the committed PNGs under fixtures/ocr/ ` +
          `are still valid. On Fedora/Bazzite: 'rpm-ostree install urw-base35-fonts'.`,
      )
    }
    console.log(`hand-style pages will use: ${available[0]}`)
  }

  for (const spec of FIXTURES) {
    await page.setContent(pageHtml(spec, fonts))
    await page.evaluate('document.fonts.ready')
    await page.screenshot({ path: join(OUT, `${spec.name}.png`), type: 'png' })
    await writeFile(join(OUT, `${spec.name}.truth.json`), `${JSON.stringify(truth(spec), null, 2)}\n`)
    console.log(`rendered ${spec.name}.png (+ .truth.json)`)
  }

  await browser.close()
}

await main()
