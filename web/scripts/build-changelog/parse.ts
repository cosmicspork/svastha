// Pure parser for the root CHANGELOG.md's release-please format:
//
//   ## [0.8.0](.../compare/v0.7.0...v0.8.0) (2026-07-21)
//
//   ### Features
//
//   * **web:** did a thing ([#78](.../issues/78)) ([42d3185](.../commit/42d3185...))
//   * did a thing with no scope ([hash](.../commit/hash))
//
// No network or filesystem access here — build.ts owns reading CHANGELOG.md
// and writing the output, which is what keeps this file importable and
// unit-testable from plain vitest.

export interface ChangelogSection {
  heading: string
  items: string[]
}

export interface ChangelogRelease {
  version: string
  date: string
  sections: ChangelogSection[]
}

const VERSION_LINE = /^## \[(\d+\.\d+\.\d+)\]\([^)]*\)\s*\((\d{4}-\d{2}-\d{2})\)/
const SECTION_LINE = /^### (.+)$/
const ITEM_LINE = /^\* (.+)$/

/** Strips the trailing `([#78](...)) ([hash](...))`-style reference links
 * release-please appends to every entry (a PR/issue link, a commit link, or
 * both) — this is release notes for end users, not a commit log. Matches
 * globally rather than just at the end of the line since an item can carry
 * one or two such groups; a real inline link elsewhere in a changelog entry
 * would be unusual for this generator's output. */
export function stripReferenceLinks(text: string): string {
  return text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').trim()
}

/** Un-bolds release-please's `**scope:**` prefix (Markdown emphasis has
 * nowhere to render in the plain-text sheet UpdateSheet shows) — `**web:**
 * thing` becomes `web: thing`. Any other `**bold**` in an entry is unwrapped
 * the same way, on the same reasoning. */
export function stripMarkdownEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1')
}

/** Parses every release in the changelog, newest first (the source file's own
 * order — release-please always prepends). Text before the first `## [` line
 * (the `# Changelog` heading) is ignored. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let currentRelease: ChangelogRelease | null = null
  let currentSection: ChangelogSection | null = null

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd()

    const versionMatch = VERSION_LINE.exec(line)
    if (versionMatch) {
      currentRelease = { version: versionMatch[1], date: versionMatch[2], sections: [] }
      releases.push(currentRelease)
      currentSection = null
      continue
    }
    if (!currentRelease) continue

    const sectionMatch = SECTION_LINE.exec(line)
    if (sectionMatch) {
      currentSection = { heading: sectionMatch[1].trim(), items: [] }
      currentRelease.sections.push(currentSection)
      continue
    }

    const itemMatch = ITEM_LINE.exec(line)
    if (itemMatch && currentSection) {
      currentSection.items.push(stripMarkdownEmphasis(stripReferenceLinks(itemMatch[1])))
    }
  }

  return releases
}

/** The N most recent releases. The changelog is already newest-first, so this
 * is a plain truncation — kept as a named step for readability at the call
 * site and so it's independently testable. */
export function takeLatestReleases(releases: ChangelogRelease[], n: number): ChangelogRelease[] {
  return releases.slice(0, n)
}
