// Emits web/public/changelog.json from the root CHANGELOG.md, so the
// release-notes sheet (UpdateSheet.svelte) can fetch a small, always-fresh
// JSON describing what's new in the newly deployed build — see
// vite.config.ts's globIgnores for why the file is never precached by the
// service worker.
//
// Unlike scripts/build-code-dictionary (manual, network-fetched reference
// data reviewed and committed by hand), this one is cheap, deterministic, and
// must reflect whatever CHANGELOG.md says on every single build — including
// in CI — so it's wired straight into the "build" script (package.json)
// rather than being a checked-in artifact. The root CHANGELOG.md is read only
// here, at build time; nothing outside web/ is imported at runtime.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, takeLatestReleases } from './parse.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CHANGELOG_PATH = join(SCRIPT_DIR, '..', '..', '..', 'CHANGELOG.md')
const OUT_PATH = join(SCRIPT_DIR, '..', '..', 'public', 'changelog.json')

// Enough for a "what's new since you last opened this" sheet without the
// payload growing unbounded release over release.
const RELEASES_TO_KEEP = 5

const markdown = readFileSync(CHANGELOG_PATH, 'utf8')
const releases = takeLatestReleases(parseChangelog(markdown), RELEASES_TO_KEEP)

writeFileSync(OUT_PATH, JSON.stringify(releases, null, 2) + '\n')
console.log(`changelog.json: wrote ${releases.length} release(s) to ${OUT_PATH}`)
