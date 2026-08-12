package loginshell

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolve_PrecedenceAndFallbacks pins the whole decision as a table: the
// account record is the authority, $SHELL is what a shell above us claimed,
// the candidates are what the machine happens to have, and /bin/sh is the
// admission that it has nothing.
//
// The case that matters most is the first one, and it is the defect this
// package was created for: on macOS the account record says zsh, and nocx
// opened bash (nocx-wwz0). The second most is "the account record loses to
// nothing but its own absence" — a stale $SHELL from a launchd environment
// must not outrank it.
func TestResolve_PrecedenceAndFallbacks(t *testing.T) {
	const nixos = "/run/current-system/sw/bin/bash"
	accountErr := func() (string, error) { return "", errNoAccountShell }

	tests := []struct {
		name       string
		account    func() (string, error)
		env        map[string]string
		present    map[string]bool
		wantShell  string
		wantSource Source
	}{
		{
			name:       "the account record wins, even against a $SHELL that disagrees",
			account:    func() (string, error) { return "/bin/zsh", nil },
			env:        map[string]string{"SHELL": "/bin/bash"},
			present:    map[string]bool{"/bin/zsh": true, "/bin/bash": true},
			wantShell:  "/bin/zsh",
			wantSource: SourceAccount,
		},
		{
			name:       "no account record: $SHELL is the shell's own claim and is believed",
			account:    accountErr,
			env:        map[string]string{"SHELL": "/usr/bin/fish"},
			present:    map[string]bool{"/usr/bin/fish": true, "/bin/bash": true},
			wantShell:  "/usr/bin/fish",
			wantSource: SourceEnv,
		},
		{
			name:       "an account record naming an uninstalled shell falls through",
			account:    func() (string, error) { return "/usr/local/bin/fish", nil },
			env:        map[string]string{"SHELL": "/bin/zsh"},
			present:    map[string]bool{"/bin/zsh": true},
			wantShell:  "/bin/zsh",
			wantSource: SourceEnv,
		},
		{
			name:       "a $SHELL naming an uninstalled shell falls through too",
			account:    accountErr,
			env:        map[string]string{"SHELL": "/usr/local/bin/fish"},
			present:    map[string]bool{"/bin/bash": true},
			wantShell:  "/bin/bash",
			wantSource: SourceDetected,
		},
		{
			name:       "an account reader that fails is not an answer",
			account:    func() (string, error) { return "", errors.New("dscl exploded") },
			env:        map[string]string{"SHELL": "/bin/zsh"},
			present:    map[string]bool{"/bin/zsh": true},
			wantShell:  "/bin/zsh",
			wantSource: SourceEnv,
		},
		{
			name:       "neither: candidate order is honoured",
			account:    accountErr,
			present:    map[string]bool{nixos: true, "/bin/bash": true},
			wantShell:  nixos,
			wantSource: SourceDetected,
		},
		{
			name:       "neither: the first candidate that exists",
			account:    accountErr,
			present:    map[string]bool{nixos: false, "/bin/bash": true},
			wantShell:  "/bin/bash",
			wantSource: SourceDetected,
		},
		{
			name:       "a machine with bash removed but zsh present still finds a tier",
			account:    accountErr,
			present:    map[string]bool{"/bin/zsh": true},
			wantShell:  "/bin/zsh",
			wantSource: SourceDetected,
		},
		{
			name:       "an empty SHELL is not a statement",
			account:    accountErr,
			env:        map[string]string{"SHELL": ""},
			present:    map[string]bool{"/bin/bash": true},
			wantShell:  "/bin/bash",
			wantSource: SourceDetected,
		},
		{
			name:       "a stripped-down container has none of it",
			account:    accountErr,
			present:    map[string]bool{},
			wantShell:  "/bin/sh",
			wantSource: SourceFallback,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := New(
				WithAccountReader(tt.account),
				WithLookupEnv(func(k string) string { return tt.env[k] }),
				WithExists(func(p string) bool { return tt.present[p] }),
			).Resolve()
			if got.Path != tt.wantShell {
				t.Errorf("shell = %q, want %q", got.Path, tt.wantShell)
			}
			if got.Source != tt.wantSource {
				t.Errorf("source = %q, want %q", got.Source, tt.wantSource)
			}
		})
	}
}

// TestReadAccountShell_SucceedsOnAnOrdinaryMachine is the paired assertion
// AGENTS.md rule 2 demands: every "returns an error when…" above has a sibling
// that proves the thing works where it has to work. internal/contentkey shipped
// with a full set of failure-path tests and none asserting the key is
// obtainable on a normal machine — where it never was; this package's whole
// value is that the OS account record is READABLE, so a suite that only ever
// injected a fake reader would prove nothing about the platform half.
//
// It fails rather than skips. A machine that cannot name its own login shell is
// a machine where the fix for nocx-wwz0 does not work, and reporting that as a
// pass is how a missing feature survives a release.
func TestReadAccountShell_SucceedsOnAnOrdinaryMachine(t *testing.T) {
	shell, err := readAccountShell()
	if err != nil {
		t.Fatalf("readAccountShell on this machine: %v (the account database must name a login shell; "+
			"without it every local tab falls back to $SHELL, which a Dock-launched app does not have)", err)
	}
	if !filepath.IsAbs(shell) {
		t.Fatalf("account shell %q is not an absolute path", shell)
	}
	if _, err := os.Stat(shell); err != nil {
		t.Fatalf("account shell %q is not on this machine: %v", shell, err)
	}
}

// TestResolve_AnswersOnThisMachine is the same pairing one level up: the
// production resolver, no injection at all, must name a shell that exists.
func TestResolve_AnswersOnThisMachine(t *testing.T) {
	got := New().Resolve()
	if !filepath.IsAbs(got.Path) {
		t.Fatalf("resolved %q, which is not an absolute path", got.Path)
	}
	if _, err := os.Stat(got.Path); err != nil {
		t.Fatalf("resolved %q, which is not on this machine: %v", got.Path, err)
	}
	if got.Source == SourceFallback {
		t.Errorf("resolved /bin/sh by exhaustion on a machine that has an account "+
			"database and a $SHELL (%q) — the chain answered nothing", os.Getenv("SHELL"))
	}
}

// TestCurrentUsername_NamesThisAccount pins the input the account lookup is
// built on: without a username there is no record to read, and the failure is
// silent (errNoAccountShell) rather than loud.
func TestCurrentUsername_NamesThisAccount(t *testing.T) {
	if name := currentUsername(); strings.TrimSpace(name) == "" {
		t.Fatal("currentUsername found no account name; the account lookup cannot run at all")
	}
}
