// Package loginshell answers one question for the whole backend: which shell
// is this user's login shell?
//
// It exists because that question had three answers and they disagreed on the
// platform the product ships to. internal/pty read $SHELL and otherwise fell
// through a bash-first candidate list; internal/git/local kept a copy of the
// same derivation, "kept in step by a comment"; and the local enhanced session
// ignored both and started bash unconditionally, so every macOS user — where
// zsh has been the default since Catalina — was greeted by Apple's frozen bash
// 3.2.57 instead of their own shell (nocx-wwz0).
//
// $SHELL is asked SECOND, on purpose. It is the shell's own claim, exported by
// a shell that ran above us — and a GUI app has no shell above it: launched
// from the Dock or from Finder, nocx inherits launchd's environment, where
// SHELL is absent or stale. Every other terminal on the platform asks the
// account database instead, and so does this: Directory Services on macOS
// (`dscl . -read /Users/<name> UserShell`), the passwd database on Linux
// (getent, then /etc/passwd). The platform call lives behind readAccountShell,
// one build-tagged file per OS, exactly like internal/contentkey's machine
// identity.
package loginshell

import (
	"errors"
	"os"
)

// errNoAccountShell reports that this host's account database named no shell
// for this user — no record, no reader, or a record with an empty shell field.
// Every platform's readAccountShell returns it rather than a bespoke error, so
// Resolve can recognise the case without matching on strings.
var errNoAccountShell = errors.New("this host's account record names no login shell")

// Source names where the answer came from. It is carried, not merely logged:
// "the account database says zsh" and "we went looking and this is what the
// machine had" are two different answers that need two different fixes when a
// run drives a shell nobody expected.
type Source string

const (
	// SourceAccount is the OS's own record — the authority.
	SourceAccount Source = "account"
	// SourceEnv is $SHELL: the shell's own claim, used when the account
	// record could not be read.
	SourceEnv Source = "SHELL"
	// SourceDetected is the first candidate path that exists.
	SourceDetected Source = "detected"
	// SourceFallback is /bin/sh: the machine offered nothing else.
	SourceFallback Source = "fallback"
)

// Shell is the resolved answer: an absolute path plus where it came from.
type Shell struct {
	Path   string
	Source Source
}

// Resolver reports the shell a local session must start. An interface with one
// method because the platform half is a subprocess against the account
// database: the composition root injects the production one, and everything
// that needs a specific machine's answer in a test injects its own rather than
// hoping the machine running the suite is configured the right way.
//
// There is deliberately no explicit user setting in front of the chain yet —
// nocx has no such setting to consult, and inventing its storage, its contract
// shape and its Settings control inside a P0 bugfix would decide all three in
// the wrong place. It belongs at the front of Resolve when it exists, as one
// more source, never as a second derivation elsewhere (nocx-c0ek).
type Resolver interface {
	Resolve() Shell
}

// candidates are tried, in order, only when neither the account record nor
// $SHELL named a shell that exists. bash stays first: it is the tier with the
// widest integration coverage, and a machine that answers neither of the two
// authoritative questions is a stripped-down image where the choice is between
// "some shell" and "no shell". /bin/sh is the last resort — on a container with
// nothing else installed it is the only thing there is.
var candidates = []string{
	"/run/current-system/sw/bin/bash", // NixOS
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/bin/zsh",
	"/usr/bin/zsh",
}

// resolver is the production Resolver with its three lookups injected, so the
// decision can be tested without a machine that happens to be configured the
// right way.
type resolver struct {
	account   func() (string, error)
	lookupEnv func(string) string
	exists    func(string) bool
}

// Option configures a Resolver. Zero options select the production lookups,
// which is what the product uses; the three that replace a lookup live in
// options_test.go, because every caller of them is a test and a function
// unreachable from main() is dead code this repository refuses to baseline.
type Option func(*resolver)

// New builds a Resolver. The composition root builds exactly one and injects
// it; New with no options is the production resolver and is what the packages
// that resolve their own default (internal/pty's empty-Command path) use.
func New(opts ...Option) Resolver {
	r := &resolver{
		account:   readAccountShell,
		lookupEnv: os.Getenv,
		exists: func(p string) bool {
			_, err := os.Stat(p)
			return err == nil
		},
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Resolve returns the shell a local session must start.
//
// The account record first, $SHELL second, a candidate list third, /bin/sh
// last. Every step is checked against the filesystem before it is believed,
// including the account record: a passwd entry naming a shell that has since
// been uninstalled is not rare (a removed fish, a homebrew zsh on a machine
// that was migrated), and honouring it would hand the user a tab that dies on
// exec rather than one that works. The check is what makes each step a
// fallback chain rather than four independent guesses.
func (r *resolver) Resolve() Shell {
	if path, err := r.account(); err == nil && path != "" && r.exists(path) {
		return Shell{Path: path, Source: SourceAccount}
	}
	if path := r.lookupEnv("SHELL"); path != "" && r.exists(path) {
		return Shell{Path: path, Source: SourceEnv}
	}
	for _, candidate := range candidates {
		if r.exists(candidate) {
			return Shell{Path: candidate, Source: SourceDetected}
		}
	}
	return Shell{Path: "/bin/sh", Source: SourceFallback}
}
