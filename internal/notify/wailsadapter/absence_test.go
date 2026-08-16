package wailsadapter_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLegacyBannerPathAbsent guards the tree against the old banner path:
// pkg/mac's osascript banner sprintfed the body into an AppleScript string
// literal, so a body containing a double quote broke the banner. The banner
// path is runtime.SendNotification, where the body is data.
//
// The guard is the import, not the identifier: the defect this task exists to
// prevent is nocx reaching pkg/mac at all, so any file that imports it is a
// hit. The identifier check stays as a second net for a reimplementation
// that never imports the package. Both strings are assembled so this file
// contains neither verbatim — the function name included, which is why it
// does not carry the identifier.
func TestLegacyBannerPathAbsent(t *testing.T) {
	root := moduleRoot(t)
	identifier := "Show" + "Notification"
	importPath := "github.com/wailsapp/wails/v2/pkg/" + "mac"
	var identHits, importHits []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" || d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		b, err := os.ReadFile(path) // #nosec G304 — path comes from filepath.WalkDir over the module root, never from user input; the test reads the tree it scans
		if err != nil {
			return err
		}
		if strings.Contains(string(b), identifier) {
			identHits = append(identHits, path)
		}
		if strings.Contains(string(b), importPath) {
			importHits = append(importHits, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	if len(identHits) > 0 {
		t.Errorf("mac.%s must not exist in the tree (the osascript path mangles bodies with double quotes); found in: %v", identifier, identHits)
	}
	if len(importHits) > 0 {
		t.Errorf("%s must not be imported in the tree (the osascript path mangles bodies with double quotes); found in: %v", importPath, importHits)
	}
}

// moduleRoot walks up from the package directory to the go.mod of the module.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found above " + dir)
		}
		dir = parent
	}
}
