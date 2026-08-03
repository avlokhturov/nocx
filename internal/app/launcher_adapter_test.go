package app

import (
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/shellintegration"
	"github.com/shady2k/nocx/internal/ssh"
)

// fakeSI Launcher is a scripted shellintegration.RemoteLauncher for adapter
// tests: it returns a canned (cmd, reason, ok) triple and records the call.
type fakeSILauncher struct {
	cmd    string
	reason shellintegration.RefusalReason
	ok     bool

	gotShell shellintegration.ShellKind
	gotOpts  shellintegration.LaunchOptions
}

func (f *fakeSILauncher) StartCommand(shell shellintegration.ShellKind, opts shellintegration.LaunchOptions) (string, shellintegration.RefusalReason, bool) {
	f.gotShell = shell
	f.gotOpts = opts
	return f.cmd, f.reason, f.ok
}

func TestRemoteLauncherAdapter_Accepted_TranslatesAndForwards(t *testing.T) {
	inner := &fakeSILauncher{cmd: "exec bash --rcfile <(printf %b 'x') -i", reason: shellintegration.ReasonNone, ok: true}
	a := &remoteLauncherAdapter{inner: inner}

	cmd, reason, ok := a.StartCommand(ssh.ShellBash, ssh.LaunchOptions{SessionID: "sess-1", Enhanced: true})
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if cmd != inner.cmd {
		t.Errorf("cmd = %q, want %q", cmd, inner.cmd)
	}
	if reason != ssh.ReasonNone {
		t.Errorf("reason = %q, want %q", reason, ssh.ReasonNone)
	}
	// The adapter must translate the type pair, not the values: the inner
	// launcher sees its own ShellKind and LaunchOptions.
	if inner.gotShell != shellintegration.ShellBash {
		t.Errorf("inner got shell %q, want %q", inner.gotShell, shellintegration.ShellBash)
	}
	if inner.gotOpts.SessionID != "sess-1" || !inner.gotOpts.Enhanced {
		t.Errorf("inner got opts %+v, want SessionID=sess-1 Enhanced=true", inner.gotOpts)
	}
}

func TestRemoteLauncherAdapter_Declines_MapEveryReasonExplicitly(t *testing.T) {
	cases := []struct {
		name   string
		inner  shellintegration.RefusalReason
		expect ssh.RefusalReason
	}{
		{"empty reason maps to none", shellintegration.ReasonNone, ssh.ReasonNone},
		{"unsupported shell maps", shellintegration.ReasonUnsupportedShell, ssh.ReasonUnsupportedShell},
		{"no secure temp maps", shellintegration.ReasonNoSecureTemp, ssh.ReasonNoSecureTemp},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &remoteLauncherAdapter{inner: &fakeSILauncher{reason: tc.inner, ok: false}}
			cmd, reason, ok := a.StartCommand(ssh.ShellBash, ssh.LaunchOptions{})
			if ok {
				t.Fatalf("ok = true, want false")
			}
			if cmd != "" {
				t.Errorf("cmd = %q, want empty on decline", cmd)
			}
			if reason != tc.expect {
				t.Errorf("reason = %q, want %q", reason, tc.expect)
			}
		})
	}
}

// A launcher that accepts while claiming a refusal contradicts the pinned
// StartCommand contract (ok=true means the shell was integrated). Silently
// dropping the reason would hide the degrade; fail loudly instead.
func TestRemoteLauncherAdapter_AcceptedWithReason_Panics(t *testing.T) {
	a := &remoteLauncherAdapter{inner: &fakeSILauncher{
		cmd: "exec bash -i", reason: shellintegration.ReasonUnsupportedShell, ok: true,
	}}
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected a panic for ok=true with a non-none reason, got none")
		}
		msg, isString := r.(string)
		if !isString {
			t.Fatalf("panic value %v is not a string", r)
		}
		if !strings.Contains(msg, "accepted with refusal reason") {
			t.Errorf("panic message %q does not name the violation", msg)
		}
	}()
	_, _, _ = a.StartCommand(ssh.ShellBash, ssh.LaunchOptions{})
}

// The unmapped arm is the tripwire for a reason added to one package and
// forgotten in the other: it must panic, never silently become ReasonNone —
// a reason that degrades to "no refusal" is how a soft degrade becomes
// invisible (AGENTS.md).
func TestRemoteLauncherAdapter_UnmappedReason_Panics(t *testing.T) {
	a := &remoteLauncherAdapter{inner: &fakeSILauncher{
		reason: shellintegration.RefusalReason("brand-new-reason"), ok: false,
	}}
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected a panic for an unmapped refusal reason, got none")
		}
		msg, isString := r.(string)
		if !isString {
			t.Fatalf("panic value %v is not a string", r)
		}
		if !strings.Contains(msg, "unmapped refusal reason") {
			t.Errorf("panic message %q does not name the unmapped value", msg)
		}
	}()
	_, _, _ = a.StartCommand(ssh.ShellBash, ssh.LaunchOptions{})
}
