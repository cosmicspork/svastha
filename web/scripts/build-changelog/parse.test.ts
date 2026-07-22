import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseChangelog, stripMarkdownEmphasis, stripReferenceLinks, takeLatestReleases } from './parse.ts'

// The fixture is a genuine excerpt of the repo's own root CHANGELOG.md (same
// release-please format), not a hand-rolled approximation — see its own
// comment-free header for the source lines.
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/changelog.fixture.md')
const fixture = readFileSync(FIXTURE_PATH, 'utf8')

describe('stripReferenceLinks', () => {
  it('strips a trailing PR link and commit link pair', () => {
    expect(
      stripReferenceLinks(
        '**web:** cycle event modeling foundation ([#78](https://x/issues/78)) ([42d3185](https://x/commit/42d3185))',
      ),
    ).toBe('**web:** cycle event modeling foundation')
  })

  it('strips a lone trailing commit link (no PR/issue reference)', () => {
    expect(
      stripReferenceLinks(
        '**web:** show version info on unlock and onboard pages ([4f59d74](https://x/commit/4f59d74))',
      ),
    ).toBe('**web:** show version info on unlock and onboard pages')
  })

  it('leaves text with no reference links untouched', () => {
    expect(stripReferenceLinks('plain description')).toBe('plain description')
  })
})

describe('stripMarkdownEmphasis', () => {
  it('unwraps a bold scope prefix', () => {
    expect(stripMarkdownEmphasis('**web:** did a thing')).toBe('web: did a thing')
  })

  it('leaves unscoped text untouched', () => {
    expect(stripMarkdownEmphasis('did a thing')).toBe('did a thing')
  })
})

describe('parseChangelog', () => {
  const releases = parseChangelog(fixture)

  it('parses every release, newest first, with version and date', () => {
    expect(releases.map((r) => r.version)).toEqual(['0.8.0', '0.7.0', '0.6.0', '0.5.1'])
    expect(releases[0].date).toBe('2026-07-21')
    expect(releases[2].date).toBe('2026-07-14')
  })

  it('groups items under their section heading', () => {
    const v07 = releases.find((r) => r.version === '0.7.0')!
    expect(v07.sections.map((s) => s.heading)).toEqual(['Features', 'Bug Fixes'])
    expect(v07.sections[0].items).toHaveLength(3)
    expect(v07.sections[1].items).toHaveLength(3)
  })

  it('strips reference links and bold markers from every item, keeping scope prefixes', () => {
    const v08 = releases.find((r) => r.version === '0.8.0')!
    expect(v08.sections[0].items).toContain('web: cycle event modeling foundation')
    // The no-PR-link entry (single trailing commit link) is stripped too.
    expect(v08.sections[0].items).toContain('web: show version info on unlock and onboard pages')
  })

  it('handles a release with only one section', () => {
    const v051 = releases.find((r) => r.version === '0.5.1')!
    expect(v051.sections).toHaveLength(1)
    expect(v051.sections[0].heading).toBe('Bug Fixes')
  })

  it('ignores the `# Changelog` preamble before the first release', () => {
    expect(releases.every((r) => r.version !== undefined)).toBe(true)
  })
})

describe('takeLatestReleases', () => {
  it('truncates to the first N without reordering', () => {
    const releases = parseChangelog(fixture)
    const latest = takeLatestReleases(releases, 2)
    expect(latest.map((r) => r.version)).toEqual(['0.8.0', '0.7.0'])
  })

  it('returns everything when N exceeds the release count', () => {
    const releases = parseChangelog(fixture)
    expect(takeLatestReleases(releases, 100)).toHaveLength(releases.length)
  })
})
