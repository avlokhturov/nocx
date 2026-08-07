// The Git panel's one filter predicate (nocx-52by). One predicate in one
// place, with its own tests — never a regex scattered through the render.
//
// Chosen semantics, and why:
//
// - CASE-INSENSITIVE SUBSTRING over the repository-relative path. The row
//   renders the file NAME first and its directory second (nocx-uf0p), so a
//   user typing a directory name has a reasonable expectation that it still
//   matches — matching the whole path is what buys that, because the
//   directory IS part of the path.
// - NOT fuzzy (subsequence) matching. A subsequence match on scattered
//   characters is how "src/foo.ts" matches "srt" — surprising for a user
//   who typed "srt" expecting nothing, and useless for navigating a list.
//   Substring over a path is what termic-style filters do and what the
//   section counts can honestly describe: "Staged (2)" next to two rows.
// - The filter is trimmed. A leading or trailing space in the input is
//   never a deliberate character of a path filter — the same choice
//   quick-connect and the secrets inventory make.
// - Characters are literal. The filter is a substring, never a regex: a
//   path containing "(" or "[" must match a filter containing it, not
//   explode or pattern-match.
export function matchesPathFilter(path: string, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (q === '') return true
  return path.toLowerCase().includes(q)
}
