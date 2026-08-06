//go:build !release

package storage

import "testing"

// The guard this file exists for: a build that is not the shipped one must not
// resolve the shipped profile. It needs no flag, no environment variable and
// nothing for a test runner to remember, which is the point — the e2e isolation
// that already existed (XDG_CONFIG_HOME in e2e/harness.ts) was correct and was
// simply never applied to the default path, and no amount of care catches that
// class of mistake. A default that is safe does (nocx-ti8w).
//
// The direction matters as much as the split. `-tags release` selects the
// shipped profile; forgetting it yields the development one. The reverse would
// mean a forgotten tag silently writes the user's real profile, which is the
// failure being fixed.
func TestAppDirName_DevelopmentBuildDoesNotResolveTheShippedProfile(t *testing.T) {
	if AppDirName == "" {
		t.Fatal("AppDirName is empty: every build must name a profile directory")
	}
	if AppDirName == shippedAppDirName {
		t.Fatalf("a build without -tags release resolves the shipped profile %q; "+
			"the unsafe direction must be the one that needs the explicit tag", AppDirName)
	}
}

// NewAppPaths is what the composition root calls, so the guarantee has to hold
// through it and not only through the constant. Asserted separately because a
// correct AppDirName reached by nobody is precisely the shape of defect the two
// beads behind this change are about.
//
// Under test the guarantee is stronger than "not the shipped profile": an
// isolated root is not the developer's profile either, and that is what a test
// run must never touch (nocx-8ax9). Both are asserted here, because the weaker
// one is the property production relies on and the stronger one is the property
// this suite relies on — and neither implies the other.
func TestNewAppPaths_UnderTestResolvesNeitherRealProfile(t *testing.T) {
	root := t.TempDir()
	t.Setenv(TestAppDirEnv, root)

	app, err := NewAppPaths()
	if err != nil {
		t.Fatalf("NewAppPaths(): %v", err)
	}
	for _, name := range []string{shippedAppDirName, AppDirName} {
		real, realErr := newOSPaths(name)
		if realErr != nil {
			t.Fatalf("newOSPaths(%q): %v", name, realErr)
		}
		if app.ConfigDir() == real.ConfigDir() {
			t.Errorf("NewAppPaths() under test resolves the %q config dir %s", name, real.ConfigDir())
		}
		if app.DataDir() == real.DataDir() {
			t.Errorf("NewAppPaths() under test resolves the %q data dir %s", name, real.DataDir())
		}
	}
}

// The property a developer actually cares about: running the dev stand or the
// e2e suite cannot read or write the documents the installed app owns. Asserted
// on the resolved paths rather than on the name, because the name is only a
// means — what must differ is the directory the DocumentStore is pointed at.
func TestNewOSPaths_DevelopmentProfileIsDisjointFromTheShippedOne(t *testing.T) {
	dev, err := newOSPaths(AppDirName)
	if err != nil {
		t.Fatalf("newOSPaths(%q): %v", AppDirName, err)
	}
	shipped, err := newOSPaths(shippedAppDirName)
	if err != nil {
		t.Fatalf("newOSPaths(%q): %v", shippedAppDirName, err)
	}

	for _, c := range []struct {
		role       string
		dev, shipp string
	}{
		{"config", dev.ConfigDir(), shipped.ConfigDir()},
		{"data", dev.DataDir(), shipped.DataDir()},
		{"cache", dev.CacheDir(), shipped.CacheDir()},
	} {
		if c.dev == c.shipp {
			t.Errorf("%s dir is shared between the development and shipped profiles: %s", c.role, c.dev)
		}
	}
}
