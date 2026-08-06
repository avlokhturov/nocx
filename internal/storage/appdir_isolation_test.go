package storage_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/storage/storagetest"
)

// The guarantee: a test cannot reach the profile a human owns, and cannot do so
// by forgetting something.
//
// nocx-ti8w established that the profile split must live in the build rather
// than in setup code, because an isolation somebody has to remember gets
// applied to three specs out of twenty-five. The build tag closed that for
// dev-versus-release. It does not close this one: a Go test IS a development
// build, so it resolves the development profile — the developer's own, shared
// with every other test in the run.
//
// internal/app's acceptance tests did remember, and still lost, because what
// they remembered was XDG_CONFIG_HOME. paths.go resolves darwin from
// os.UserHomeDir(), so on macOS all three XDG variables are inert: CI run
// 31083388224 logged to /Users/runner/Library/Application Support/nocx-dev
// and the tests then failed on each other's leftovers. Isolation that is
// correct on one of the two platforms we ship is the same defect wearing a
// disguise.
//
// So the guard is a refusal, not a helper. Under test, NewAppPaths resolves
// nothing at all until an isolated root is named, and it says which call names
// one. A new test that forgets cannot silently write a real profile; it fails
// on its first line with the fix in the message.
func TestNewAppPaths_UnderTestRefusesUntilIsolated(t *testing.T) {
	_, err := storage.NewAppPaths()
	if err == nil {
		t.Fatal("NewAppPaths() resolved a profile in a test that never isolated one; " +
			"an unisolated test reads and writes the developer's real documents")
	}
	// The error has to carry the remedy. A refusal a reader cannot act on
	// costs more than the write it prevented.
	if !strings.Contains(err.Error(), "storagetest.Isolate") {
		t.Errorf("refusal does not name the call that fixes it: %v", err)
	}
}

// Isolate must move all three roles, not the one the failing test happened to
// look at. The interval matters: config, data and cache are separate roles by
// ADR-0011, and a helper that redirected two of them would leave the third
// pointing at the developer's home with nothing to notice it.
func TestIsolate_RedirectsEveryRoleUnderOneRoot(t *testing.T) {
	root := storagetest.Isolate(t)

	paths, err := storage.NewAppPaths()
	if err != nil {
		t.Fatalf("NewAppPaths() after Isolate: %v", err)
	}

	for _, role := range []struct {
		name, dir string
	}{
		{"config", paths.ConfigDir()},
		{"data", paths.DataDir()},
		{"cache", paths.CacheDir()},
	} {
		rel, relErr := filepath.Rel(root, role.dir)
		if relErr != nil || strings.HasPrefix(rel, "..") {
			t.Errorf("%s dir %s is not inside the isolated root %s", role.name, role.dir, root)
		}
	}
}

// The roles stay distinct inside the root. Collapsing them would make the
// history tests pass while asserting nothing: the salt lives in the config dir
// precisely so that a copy of the data dir carries nothing that opens it, and
// a root where both names resolve to one directory cannot fail that assertion.
func TestIsolate_KeepsTheRolesDistinct(t *testing.T) {
	storagetest.Isolate(t)

	paths, err := storage.NewAppPaths()
	if err != nil {
		t.Fatalf("NewAppPaths() after Isolate: %v", err)
	}
	if paths.ConfigDir() == paths.DataDir() {
		t.Errorf("config and data resolve to one directory (%s); the salt would sit beside the database it opens", paths.ConfigDir())
	}
	if paths.CacheDir() == paths.DataDir() {
		t.Errorf("cache and data resolve to one directory (%s)", paths.DataDir())
	}
}

// Two isolated tests must not meet. This is the failure CI actually reported —
// not one test writing the wrong place, but the second one finding the first
// one's database and no key to open it.
func TestIsolate_GivesEachTestItsOwnRoot(t *testing.T) {
	var seen string
	for _, name := range []string{"first", "second"} {
		t.Run(name, func(t *testing.T) {
			storagetest.Isolate(t)
			paths, err := storage.NewAppPaths()
			if err != nil {
				t.Fatalf("NewAppPaths() after Isolate: %v", err)
			}
			if paths.DataDir() == seen {
				t.Fatalf("%s reuses the data dir of the test before it: %s", name, seen)
			}
			seen = paths.DataDir()
		})
	}
}
