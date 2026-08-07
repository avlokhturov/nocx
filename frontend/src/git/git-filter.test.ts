// The Git panel's filter predicate (nocx-52by) — the one place a path is
// tested against a filter, so every behaviour below is the predicate's
// contract, not an accident of one call site.
import { describe, expect, it } from 'vitest'
import { matchesPathFilter } from './git-filter'

describe('matchesPathFilter', () => {
  it('matches a case-insensitive substring of the repository-relative path', () => {
    expect(matchesPathFilter('src/git/git-panel.tsx', 'git-panel')).toBe(true)
    expect(matchesPathFilter('src/git/git-panel.tsx', 'GIT-PANEL')).toBe(true)
    expect(matchesPathFilter('src/git/git-panel.tsx', 'panel.tsx')).toBe(true)
  })

  it('matches a directory component — the row renders the name first and the directory second, so a directory name must still match (nocx-uf0p)', () => {
    expect(matchesPathFilter('src/git/git-panel.tsx', 'src/git')).toBe(true)
    expect(matchesPathFilter('src/git/git-panel.tsx', 'git')).toBe(true)
    expect(matchesPathFilter('a/b/c.txt', 'b')).toBe(true)
  })

  it('does not match a filter the path does not contain', () => {
    expect(matchesPathFilter('src/git/git-panel.tsx', 'other')).toBe(false)
    expect(matchesPathFilter('a/b/c.txt', 'b/c/d')).toBe(false)
    // Substring, not a character-subsequence: scattered letters do not match.
    expect(matchesPathFilter('src/git/git-panel.tsx', 'sgp')).toBe(false)
  })

  it('an empty or whitespace-only filter matches everything — the no-filter state', () => {
    expect(matchesPathFilter('anything.txt', '')).toBe(true)
    expect(matchesPathFilter('anything.txt', '   ')).toBe(true)
  })

  it('trims the filter: a stray leading or trailing space never empties the result', () => {
    expect(matchesPathFilter('src/git/git-panel.tsx', ' git-panel ')).toBe(true)
  })

  it('treats filter characters as literals — a substring, never a regex', () => {
    expect(matchesPathFilter('weird(file).txt', '(file)')).toBe(true)
    expect(matchesPathFilter('weird(file).txt', 'weird(')).toBe(true)
    expect(matchesPathFilter('plain.txt', '(x')).toBe(false)
  })
})
