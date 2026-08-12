package app

// Reaching the OS keystore is a per-user OS service call, and until nocx-o4hg
// it was what a test got for saying nothing: internal/vault/system.Provider's
// Probe writes and reads a random entry under the "nocx" service, so every
// backend a test started wrote to the login keychain of whoever ran the suite.
// These are the checks that make it a decision instead of an inheritance.

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/storage/storagetest"
)

// A test that has not said what it means to do about the OS keystore is
// refused, and the refusal names both ways to say it. This is the whole
// mechanism: it fires wherever the composition root is built from a test
// binary, including from a package that does not know this helper exists.
func TestNew_RefusesATestThatHasNotDeclaredItsKeystoreStance(t *testing.T) {
	storagetest.Isolate(t)

	a, err := New(WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err == nil {
		a.Shutdown(context.Background())
		t.Fatal("New() built the app for a test that never said whether it may " +
			"reach the OS keystore; that construction performs a real keyring write")
	}
	for _, want := range []string{"newTestApp", "WithRealSystemKeystore"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal does not name %q, so the reader is not told how to say it: %v",
				want, err)
		}
	}
}

// The test constructor keeps the keystore out of reach, and the backend says
// so in its own log — the observable a developer has when a keychain dialog
// does or does not appear.
func TestNewTestApp_KeepsTheOSKeystoreOutOfReach(t *testing.T) {
	storagetest.Isolate(t)
	logPath := filepath.Join(t.TempDir(), "nocx.log")

	a, err := newTestApp(t, WithLogFilePath(logPath))
	if err != nil {
		t.Fatalf("newTestApp: %v", err)
	}
	defer a.Shutdown(context.Background())

	b, err := os.ReadFile(logPath) // #nosec G304 — the test's own temp path.
	if err != nil {
		t.Fatalf("read the backend log: %v", err)
	}
	if !bytes.Contains(b, []byte("no system keystore")) {
		t.Errorf("the startup probe did not record an absent keystore, so it "+
			"reached the real one; log:\n%s", b)
	}
	if !bytes.Contains(b, []byte("ready=false")) {
		t.Errorf("the system provider reported ready without a keystore to be "+
			"ready for; log:\n%s", b)
	}
}

// The opt-in is not a flag: a test that wants the real store states why, and
// an empty reason is refused. Without this the exception is one copy-paste
// away from being the rule again.
func TestNew_RealKeystoreOptInWithoutAReasonIsRefused(t *testing.T) {
	storagetest.Isolate(t)

	a, err := New(WithRealSystemKeystore("  "),
		WithLogFilePath(filepath.Join(t.TempDir(), "nocx.log")))
	if err == nil {
		a.Shutdown(context.Background())
		t.Fatal("New() accepted a real-keystore opt-in with no reason")
	}
	if !strings.Contains(err.Error(), "reason") {
		t.Errorf("refusal does not say a reason is what is missing: %v", err)
	}
}

// The paired half: the product still probes. The refusal is scoped to test
// binaries, so the shipped app — and cmd/devharness, and anything else that is
// not `go test` — goes on reaching the real store at startup, which is what
// tells a user's machine whether it has one.
//
// Asserted on the decision rather than by starting a real backend, because
// starting one to prove it would be the very keychain write this bead is
// about. That the probe then succeeds against a working store is
// TestProbeWithFakeKeyring in internal/vault/system.
func TestKeystoreStance(t *testing.T) {
	cases := []struct {
		name      string
		inTest    bool
		opts      []Option
		reachReal bool
		refused   bool
	}{
		{
			name:      "production says nothing and reaches the real store",
			inTest:    false,
			reachReal: true,
		},
		{
			name:    "a test that says nothing is refused",
			inTest:  true,
			refused: true,
		},
		{
			name:      "a test that opts in with a reason reaches the real store",
			inTest:    true,
			opts:      []Option{WithRealSystemKeystore("asserts the login keychain round trip")},
			reachReal: true,
		},
		{
			name:   "a test that declares the keystore absent does not reach it",
			inTest: true,
			opts:   []Option{WithoutSystemKeystore()},
		},
		{
			name:   "the dev override still means absent outside a test",
			inTest: false,
			opts:   []Option{WithoutSystemKeystore()},
		},
	}
	// The zero value is what a caller who passed no keystore option holds,
	// so "said nothing" is only detectable while the two coincide.
	var zero optionSet
	if zero.keystore != keystoreUndeclared {
		t.Fatalf("the zero stance is %v, not keystoreUndeclared: saying nothing "+
			"would then be indistinguishable from declaring something", zero.keystore)
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var o optionSet
			for _, opt := range tc.opts {
				opt(&o)
			}
			reachReal, err := resolveKeystoreStance(tc.inTest, &o)
			if tc.refused {
				if err == nil {
					t.Fatal("stance accepted, want a refusal")
				}
				return
			}
			if err != nil {
				t.Fatalf("stance refused: %v", err)
			}
			if reachReal != tc.reachReal {
				t.Errorf("reaches the real keystore = %v, want %v", reachReal, tc.reachReal)
			}
		})
	}
}
