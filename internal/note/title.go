package note

import (
	"strings"
	"unicode/utf8"
)

// maxTitleRunes bounds a derived title. A first line can be a paragraph;
// a tab strip and a list row cannot.
const maxTitleRunes = 80

// UntitledPrefix begins the name of a note with nothing in it yet. The date
// is appended by the caller that knows the person's clock — the store keeps
// epoch milliseconds and has no business formatting them.
const UntitledPrefix = "Note"

// DeriveTitle is the ONE place a note's name comes from (spec §7): the
// first non-empty line, with markdown heading marks and surrounding space
// stripped, bounded. Empty when the body has nothing to name it by — the
// caller decides what to show then, because that answer needs a clock and a
// locale.
//
// Derived rather than stored, and derived HERE rather than in each reader:
// the list row, the search hit and the tab title are the same fact, and a
// second derivation is how two of them start disagreeing.
func DeriveTitle(body string) string {
	for line := range strings.SplitSeq(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		// `#`, `##`, … — a markdown heading is how a person titles a note,
		// and the marks are syntax rather than part of the name.
		trimmed = strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
		if trimmed == "" {
			// A line of nothing but hashes names nothing; keep looking.
			continue
		}
		return boundRunes(trimmed, maxTitleRunes)
	}
	return ""
}

// boundRunes cuts at a rune boundary and marks the cut, so a bounded title
// reads as shortened rather than as mistyped.
func boundRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	out := make([]rune, 0, max)
	for _, r := range s {
		if len(out) == max {
			break
		}
		out = append(out, r)
	}
	return strings.TrimSpace(string(out)) + "…"
}
