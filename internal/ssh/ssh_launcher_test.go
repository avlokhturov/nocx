package ssh

import (
	"context"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

// ---------------------------------------------------------------------------
// Fake launcher — test double for the pinned RemoteLauncher contract
// (nocx-xs1d). Records every call and returns a scripted result.
// ---------------------------------------------------------------------------

type fakeLauncher struct {
	mu       sync.Mutex
	calls    int
	gotShell ShellKind
	gotOpts  LaunchOptions
	cmd      string
	reason   RefusalReason
	ok       bool
}

func (f *fakeLauncher) StartCommand(shell ShellKind, opts LaunchOptions) (cmd string, reason RefusalReason, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.gotShell = shell
	f.gotOpts = opts
	return f.cmd, f.reason, f.ok
}

func (f *fakeLauncher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeLauncher) lastCall() (ShellKind, LaunchOptions) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gotShell, f.gotOpts
}

// fakeInstaller is the legacy RemoteInstaller double. It fails the test if
// consulted — the whole point of the launcher task is that the default path
// never touches it.
type fakeInstaller struct {
	t *testing.T
}

func (f *fakeInstaller) GetRemoteHome(_ *gossh.Client) (string, error) {
	f.t.Fatal("GetRemoteHome called: installer must not run on the launcher path")
	return "", nil
}

func (f *fakeInstaller) EnsureInstalledRemote(_ context.Context, _ *gossh.Client, _ string) error {
	f.t.Fatal("EnsureInstalledRemote called: installer must not run on the launcher path")
	return nil
}

func (f *fakeInstaller) RemoteStartCommand() string {
	f.t.Fatal("RemoteStartCommand called: installer must not run on the launcher path")
	return ""
}

// testSSHServer accessors for start-command observations.
func (s *testSSHServer) lastExecCommand() string {
	select {
	case cmd := <-s.execCommands:
		return cmd
	default:
		return ""
	}
}

func (s *testSSHServer) execCommandCount() int {
	return len(s.execCommands)
}

func (s *testSSHServer) shellRequestCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shellRequests
}

// ---------------------------------------------------------------------------
// openShell start-command matrix
// ---------------------------------------------------------------------------

// launcherConnect opens a real connection to the test server, returning the
// channel. The client and channel are cleaned up with the test.
func launcherConnect(t *testing.T, srv *testSSHServer, rcOpts []RealClientOption, opts ...ConnectOption) Channel {
	t.Helper()
	khPath := writeKnownHosts(t, srv, srv.addr)
	rcOpts = append([]RealClientOption{WithKnownHostsFile(khPath)}, rcOpts...)
	client, err := NewReal(log.NewSlogAdapter(nil), rcOpts...)
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	base := []ConnectOption{
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
		WithPTYSize(80, 24, 0, 0),
	}
	opts = append(base, opts...)
	ch, err := client.Connect(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(func() { _ = ch.Close() })
	return ch
}

// assertUsable proves the session is an ordinary terminal after the start:
// the far end accepted the start request and echoes writes back.
func assertUsable(t *testing.T, srv *testSSHServer, ch Channel) {
	t.Helper()
	<-srv.shellReady
	if _, err := ch.Write([]byte("hello")); err != nil {
		t.Fatalf("Write after start: %v", err)
	}
	buf := make([]byte, 32)
	n, err := ch.Read(buf)
	if err != nil {
		t.Fatalf("Read after start: %v", err)
	}
	if got := string(buf[:n]); got != "echo:hello" {
		t.Fatalf("session not usable: expected echo:hello, got %q", got)
	}
}

func TestConnect_LauncherAccepted_StartUsesItsCommand(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	wantCmd := "exec bash --rcfile <(printf %b 'x') -i"
	launcher := &fakeLauncher{cmd: wantCmd, reason: ReasonNone, ok: true}

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
		WithRemoteLauncher(launcher),
		WithSessionID("sess-abc123"),
		WithEnhanced(),
	)

	assertUsable(t, srv, ch)

	if got := srv.lastExecCommand(); got != wantCmd {
		t.Errorf("session.Start received %q, want the launcher's command %q", got, wantCmd)
	}
	if srv.shellRequestCount() != 0 {
		t.Errorf("plain shell started alongside the launcher command (%d shell requests)", srv.shellRequestCount())
	}
	if n := launcher.callCount(); n != 1 {
		t.Fatalf("launcher called %d times, want 1", n)
	}
	shell, opts := launcher.lastCall()
	if shell != ShellAuto {
		t.Errorf("launcher received shell %q, want %q (no pin → the far host detects itself)", shell, ShellAuto)
	}
	if opts.SessionID != "sess-abc123" {
		t.Errorf("launcher received SessionID %q, want sess-abc123", opts.SessionID)
	}
	if !opts.Enhanced {
		t.Error("launcher received Enhanced=false, want true (marker-only was requested)")
	}
	if got := ch.ShellIntegrationReason(); got != ReasonNone {
		t.Errorf("ShellIntegrationReason = %q, want %q", got, ReasonNone)
	}
}

// TestConnect_ProfileShellPin_BeatsDetection: a profile that pins the far
// shell must win over detection — the launcher receives the pinned kind,
// not ShellAuto, and the user's knowledge of the host is never overridden
// by what the dispatcher would conclude at the far end (nocx-6rj0).
func TestConnect_ProfileShellPin_BeatsDetection(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	wantCmd := "exec zsh -l"
	launcher := &fakeLauncher{cmd: wantCmd, reason: ReasonNone, ok: true}

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
		WithRemoteLauncher(launcher),
		WithShell(ShellZsh),
		WithSessionID("sess-pin"),
		WithEnhanced(),
	)

	assertUsable(t, srv, ch)

	shell, opts := launcher.lastCall()
	if shell != ShellZsh {
		t.Errorf("launcher received shell %q, want the pinned %q", shell, ShellZsh)
	}
	if opts.SessionID != "sess-pin" {
		t.Errorf("launcher received SessionID %q, want sess-pin", opts.SessionID)
	}
	if got := ch.ShellIntegrationReason(); got != ReasonNone {
		t.Errorf("ShellIntegrationReason = %q, want %q", got, ReasonNone)
	}
}

// TestConnect_UnknownPin_GoesToMinimalTier: a profile that pins ShellUnknown
// ("this host is neither bash nor zsh") must reach the minimal tier
// directly — the pin is a decision, not a request to detect.
func TestConnect_UnknownPin_GoesToMinimalTier(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	launcher := &fakeLauncher{cmd: "exec /bin/sh -l", reason: ReasonNone, ok: true}

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
		WithRemoteLauncher(launcher),
		WithShell(ShellUnknown),
	)

	assertUsable(t, srv, ch)

	shell, _ := launcher.lastCall()
	if shell != ShellUnknown {
		t.Errorf("launcher received shell %q, want the pinned %q", shell, ShellUnknown)
	}
}

func TestConnect_RemoteCommand_LauncherNeverCalled(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	launcher := &fakeLauncher{cmd: "must not run", reason: ReasonNone, ok: true}
	stub := NewStubConfigResolver()
	stub.AddEntry(hostPortOnly(srv.addr), HostConfig{User: "test", RemoteCommand: "tmux attach -t work"})

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(stub)},
		WithRemoteLauncher(launcher),
		WithSessionID("sess-xyz"),
	)

	assertUsable(t, srv, ch)

	if n := launcher.callCount(); n != 0 {
		t.Fatalf("launcher called %d times with a RemoteCommand configured, want 0", n)
	}
	if got := srv.lastExecCommand(); got != "tmux attach -t work" {
		t.Errorf("session.Start received %q, want the configured RemoteCommand", got)
	}
	if got := ch.ShellIntegrationReason(); got != ReasonRemoteCommand {
		t.Errorf("ShellIntegrationReason = %q, want %q", got, ReasonRemoteCommand)
	}
}

func TestConnect_LauncherDeclines_PlainShellReasonPropagated(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	launcher := &fakeLauncher{reason: ReasonUnsupportedShell, ok: false}

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
		WithRemoteLauncher(launcher),
	)

	assertUsable(t, srv, ch)

	if n := launcher.callCount(); n != 1 {
		t.Fatalf("launcher called %d times, want 1", n)
	}
	if got := srv.execCommandCount(); got != 0 {
		t.Errorf("launcher declined but %d exec(s) were sent; want a plain shell", got)
	}
	if got := srv.shellRequestCount(); got != 1 {
		t.Errorf("shell requests = %d, want 1 (plain shell fallback)", got)
	}
	if got := ch.ShellIntegrationReason(); got != ReasonUnsupportedShell {
		t.Errorf("ShellIntegrationReason = %q, want %q", got, ReasonUnsupportedShell)
	}
}

func TestConnect_LauncherDegenerate_FallsBackToPlainShell(t *testing.T) {
	// The pinned StartCommand has no error return: a launcher that refuses
	// without a reason, or "accepts" with no command, is a contract violation
	// and must not produce a dead or empty exec. Both shapes fall back to a
	// plain shell with the reason normalized.
	cases := []struct {
		name   string
		cmd    string
		reason RefusalReason
		ok     bool
	}{
		{"refuses with empty reason", "", "", false},
		{"accepts with empty command", "", ReasonNone, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := startTestSSHServer(t)
			defer srv.close()

			launcher := &fakeLauncher{cmd: tc.cmd, reason: tc.reason, ok: tc.ok}
			ch := launcherConnect(
				t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
				WithRemoteLauncher(launcher),
			)

			assertUsable(t, srv, ch)

			if got := srv.execCommandCount(); got != 0 {
				t.Errorf("degenerate launcher result produced %d exec(s); want plain shell", got)
			}
			if got := srv.shellRequestCount(); got != 1 {
				t.Errorf("shell requests = %d, want 1", got)
			}
			if got := ch.ShellIntegrationReason(); got != ReasonUnsupportedShell {
				t.Errorf("ShellIntegrationReason = %q, want normalized %q", got, ReasonUnsupportedShell)
			}
		})
	}
}

func TestConnect_LauncherWired_InstallerNeverConsulted(t *testing.T) {
	// The legacy installer is an explicit opt-in; when the launcher is wired
	// (the new default), openShell must not silently SFTP-install anything.
	srv := startTestSSHServer(t)
	defer srv.close()

	launcher := &fakeLauncher{cmd: "exec bash -i", reason: ReasonNone, ok: true}
	installer := &fakeInstaller{t: t}

	ch := launcherConnect(
		t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())},
		WithRemoteLauncher(launcher),
		WithRemoteInstaller(installer),
	)

	assertUsable(t, srv, ch)
	_ = ch
}

func TestConnect_NoLauncherNoRemoteCommand_PlainShellNoReason(t *testing.T) {
	srv := startTestSSHServer(t)
	defer srv.close()

	ch := launcherConnect(t, srv, []RealClientOption{WithConfigResolver(NewStubConfigResolver())})

	assertUsable(t, srv, ch)

	if got := srv.execCommandCount(); got != 0 {
		t.Errorf("plain-shell default sent %d exec(s)", got)
	}
	if got := ch.ShellIntegrationReason(); got != ReasonNone {
		t.Errorf("ShellIntegrationReason = %q, want %q (no integration attempted)", got, ReasonNone)
	}
}
