import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATES, type Scheme, type Size } from './manifest'

// manifest.json and the index.html contact sheet over it. The manifest records
// what each state's shots ran into, so a screen that looks broken explains
// itself; the contact sheet flags those states.

export interface ShotRecord {
  file: string
  ms: number
}

export interface StateRecord {
  id: string
  area: string
  route: string
  title: string
  note: string
  /** Keyed `<size>-<scheme>`. */
  shots: Record<string, ShotRecord>
  consoleErrors: string[]
  pageErrors: string[]
  failedRequests: string[]
  /** Why a shot could not be taken, after its one retry. */
  failures: string[]
  sweptAt: string
}

export const variantKey = (size: Size, scheme: Scheme) => `${size}-${scheme}`

/** Fold this run's records into an earlier manifest: a narrowed run replaces
 * its own states and keeps the rest. Ordered as the manifest module lists
 * states; records for states that no longer exist are dropped. */
export function mergeManifest(outDir: string, fresh: StateRecord[]): StateRecord[] {
  let prior: StateRecord[] = []
  try {
    prior = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  } catch {
    // No earlier manifest: this run is the whole of it.
  }
  const byId = new Map(prior.map((r) => [r.id, r]))
  for (const r of fresh) byId.set(r.id, r)
  return STATES.flatMap((s) => byId.get(s.id) ?? [])
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function writeReport(outDir: string, records: StateRecord[], variants: string[]): void {
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(records, null, 2))

  const areas = [...new Set(records.map((r) => r.area))]
  const flagged = (r: StateRecord) =>
    r.failures.length + r.pageErrors.length + r.consoleErrors.length + r.failedRequests.length > 0
  const list = (label: string, items: string[]) =>
    items.length ? `<details open><summary>${label} (${items.length})</summary><ul>${items.map((i) => `<li><code>${esc(i)}</code></li>`).join('')}</ul></details>` : ''

  const section = (r: StateRecord) => {
    const cells = variants
      .map((v) => {
        const shot = r.shots[v]
        return shot
          ? `<figure><a href="${esc(shot.file)}"><img src="${esc(shot.file)}" loading="lazy" alt="${esc(`${r.title}, ${v}`)}"></a><figcaption>${esc(v)}</figcaption></figure>`
          : `<figure class="none"><div>not shot</div><figcaption>${esc(v)}</figcaption></figure>`
      })
      .join('')
    return `<section id="${esc(r.id)}" class="${flagged(r) ? 'flag' : ''}">
  <h3>${esc(r.title)} <a class="id" href="#${esc(r.id)}">${esc(r.id)}</a></h3>
  <p class="meta"><code>#${esc(r.route)}</code>${r.note ? ` · ${esc(r.note)}` : ''}</p>
  ${list('Shot failures', r.failures)}${list('Page errors', r.pageErrors)}${list('Console errors', r.consoleErrors)}${list('Failed requests', r.failedRequests)}
  <div class="row">${cells}</div>
</section>`
  }

  const nav = areas
    .map((a) => {
      const n = records.filter((r) => r.area === a)
      const bad = n.filter(flagged).length
      return `<a href="#area-${esc(a)}">${esc(a)} <span>${n.length}${bad ? ` · ${bad} flagged` : ''}</span></a>`
    })
    .join('')

  const body = areas
    .map((a) => `<h2 id="area-${esc(a)}">${esc(a)}</h2>${records.filter((r) => r.area === a).map(section).join('')}`)
    .join('')

  const shots = records.reduce((n, r) => n + Object.keys(r.shots).length, 0)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Svastha screen sweep</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f3; --fg: #1b1f1d; --muted: #5d6661; --card: #fff; --line: #d9ddd9; --flag: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151917; --fg: #e4e8e5; --muted: #9aa49e; --card: #1f2522; --line: #333b37; --flag: #f2b8b5; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; }
  header h1 { margin: 0 0 6px; font-size: 18px; }
  header p { margin: 0 0 8px; color: var(--muted); }
  nav { display: flex; flex-wrap: wrap; gap: 6px; }
  nav a { padding: 3px 9px; border: 1px solid var(--line); border-radius: 99px; color: inherit; text-decoration: none; }
  nav a span { color: var(--muted); }
  main { padding: 0 16px 48px; }
  h2 { margin: 32px 0 8px; text-transform: capitalize; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  section.flag { border-color: var(--flag); border-width: 2px; }
  h3 { margin: 0; font-size: 15px; }
  .id { font: 12px ui-monospace, monospace; color: var(--muted); margin-left: 6px; }
  .meta { margin: 2px 0 8px; color: var(--muted); }
  details { color: var(--flag); margin: 4px 0; }
  details code { white-space: pre-wrap; word-break: break-word; }
  .row { display: flex; gap: 12px; overflow-x: auto; align-items: flex-start; padding-bottom: 4px; }
  figure { margin: 0; flex: none; }
  figure img { display: block; width: 240px; height: auto; border: 1px solid var(--line); border-radius: 6px; }
  figure.none div { width: 240px; height: 120px; display: grid; place-items: center; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 3px; }
</style>
</head>
<body>
<header>
  <h1>Svastha screen sweep</h1>
  <p>${records.length} states, ${shots} shots, synthetic vault. ${records.filter(flagged).length} flagged. Click a shot for full size.</p>
  <nav>${nav}</nav>
</header>
<main>${body}</main>
</body>
</html>
`
  writeFileSync(join(outDir, 'index.html'), html)
}
