package settings

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// themeDir is the frontend directory that owns the theme files, relative to this
// package. The Go setting is downstream of it: a theme exists because a
// stylesheet exists, and `ui.theme` only decides which of them the user can pick.
const themeDir = "../../frontend/src/styles/themes"

// TestUIThemeOptionsMatchStylesheets is the Go half of the theme-registration
// invariant. Adding a theme means adding a file plus three registrations, and
// this end catches the one an agent working in Go is most likely to get wrong.
//
// Both failure directions are real and neither raises an error at runtime:
//
//   - An option with no stylesheet is a theme the picker offers and the frontend
//     silently refuses — `KNOWN_THEME_IDS` rewrites the unknown id back to the
//     default, so the setting reads "Dracula" while the window stays Tokyo Night.
//   - A stylesheet with no option is a file that ships in the bundle, is parsed
//     on every launch, and can never be selected.
//
// The frontend half — that the same ids appear in style.css and in
// KNOWN_THEME_IDS — is asserted in frontend/src/theme-catalogue.test.ts. Split
// this way each side fails in its own test run (nocx-7o42).
func TestUIThemeOptionsMatchStylesheets(t *testing.T) {
	entries, err := os.ReadDir(themeDir)
	if err != nil {
		t.Fatalf("reading %s: %v", themeDir, err)
	}

	var onDisk []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".css") {
			continue
		}
		onDisk = append(onDisk, strings.TrimSuffix(e.Name(), ".css"))
	}
	if len(onDisk) == 0 {
		t.Fatalf("no theme stylesheets found in %s — the test is not really running", themeDir)
	}

	var offered []string
	for _, o := range UITheme.Options() {
		offered = append(offered, o.Value)
	}

	sort.Strings(onDisk)
	sort.Strings(offered)

	if strings.Join(onDisk, ",") != strings.Join(offered, ",") {
		t.Errorf("ui.theme options do not match the stylesheets on disk\n  on disk: %v\n  offered: %v", onDisk, offered)
	}
}

// TestUIThemeDefaultHasAStylesheet guards the one option whose absence is not
// merely unreachable but fatal to first launch: the default is what bootstrap
// falls back to when the cache is empty or the id is unknown, so if it names a
// file that is not there the fallback has nowhere to land.
func TestUIThemeDefaultHasAStylesheet(t *testing.T) {
	id, ok := UITheme.Default().(string)
	if !ok {
		t.Fatalf("ui.theme default is %T, not a string", UITheme.Default())
	}
	path := filepath.Join(themeDir, id+".css")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("default theme %q has no stylesheet at %s: %v", id, path, err)
	}
}

// TestUIThemeOptionsHaveLabels catches the copy-paste that leaves an option
// showing its raw id. The picker renders Label, so an empty one is a blank row
// and an id-shaped one ("solarized-dark") reads as a bug to the user.
func TestUIThemeOptionsHaveLabels(t *testing.T) {
	for _, o := range UITheme.Options() {
		if o.Label == "" {
			t.Errorf("theme option %q has no label", o.Value)
			continue
		}
		if o.Label == o.Value {
			t.Errorf("theme option %q uses its id as its label", o.Value)
		}
	}
}
