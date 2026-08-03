package session

import (
	"context"
	"io"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/ssh"
)

// capturingSSHFactory records the ConnectOptions it receives and returns a
// scripted channel (or error).
type capturingSSHFactory struct {
	opts []ssh.ConnectOption
	ch   ssh.Channel
	err  error
}

// fakeLauncher satisfies ssh.RemoteLauncher; the session layer only needs to
// carry it through to Connect, never to call it.
type fakeLauncher struct{}

func (f *fakeLauncher) StartCommand(_ ssh.ShellKind, _ ssh.LaunchOptions) (string, ssh.RefusalReason, bool) {
	return "", ssh.ReasonNone, false
}

func (f *capturingSSHFactory) Connect(_ context.Context, _ string, opts ...ssh.ConnectOption) (ssh.Channel, error) {
	f.opts = append(f.opts, opts...)
	if f.err != nil {
		return nil, f.err
	}
	return f.ch, nil
}

// reasonChannel is an ssh.Channel whose ShellIntegrationReason is scripted.
type reasonChannel struct {
	reason ssh.RefusalReason
}

func (c *reasonChannel) Read(p []byte) (int, error) { return 0, io.EOF }
func (c *reasonChannel) Write(p []byte) (int, error) {
	return len(p), nil
}
func (c *reasonChannel) Close() error { return nil }
func (c *reasonChannel) Done() <-chan struct{} {
	return make(chan struct{})
}
func (c *reasonChannel) Resize(_ context.Context, _, _, _, _ uint16) error { return nil }
func (c *reasonChannel) ShellIntegrationReason() ssh.RefusalReason {
	return c.reason
}

func launcherReg() *Reg {
	return New(log.NewSlogAdapter(nil), &stubPTYFactory{stub: pty.NewStub(log.NewSlogAdapter(nil))})
}

func TestRemoteSession_SurfacesShellIntegrationReason(t *testing.T) {
	factory := &capturingSSHFactory{ch: &reasonChannel{reason: ssh.ReasonRemoteCommand}}
	reg := launcherReg().WithSSHFactory(factory)

	sess, err := reg.Open(context.Background(), Config{
		Kind:   KindRemote,
		Host:   "example.com",
		Remote: &ssh.ConnectConfig{},
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if got := sess.ShellIntegrationReason(); got != ssh.ReasonRemoteCommand {
		t.Errorf("ShellIntegrationReason = %q, want %q", got, ssh.ReasonRemoteCommand)
	}
}

func TestRemoteSession_SessionIDMatchesAndLauncherWired(t *testing.T) {
	launcher := &fakeLauncher{}
	factory := &capturingSSHFactory{ch: &reasonChannel{reason: ssh.ReasonNone}}
	reg := launcherReg().WithSSHFactory(factory)

	sess, err := reg.Open(context.Background(), Config{
		Kind:     KindRemote,
		Host:     "example.com",
		Enhanced: true,
		Remote:   &ssh.ConnectConfig{RemoteLauncher: launcher},
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	// The ID the session was registered under is the ID the launcher options
	// carried — the same pre-connect ID, not an empty string.
	cfg := &ssh.ConnectConfig{}
	for _, o := range factory.opts {
		o(cfg)
	}
	if cfg.SessionID != string(sess.ID()) {
		t.Errorf("ConnectConfig.SessionID = %q, want the session ID %q", cfg.SessionID, sess.ID())
	}
	if cfg.SessionID == "" {
		t.Error("ConnectConfig.SessionID is empty: the launcher would embed no NOCX_SESSION_ID")
	}
	if !cfg.Enhanced {
		t.Error("ConnectConfig.Enhanced = false, want true (Config.Enhanced requested marker-only mode)")
	}
	if cfg.RemoteLauncher == nil {
		t.Error("ConnectConfig.RemoteLauncher is nil: the wired launcher did not reach Connect")
	}
}

func TestRemoteSession_ConnectError_NoSessionRegistered(t *testing.T) {
	factory := &capturingSSHFactory{err: io.ErrClosedPipe}
	reg := launcherReg().WithSSHFactory(factory)

	_, err := reg.Open(context.Background(), Config{
		Kind:   KindRemote,
		Host:   "example.com",
		Remote: &ssh.ConnectConfig{},
	})
	if err == nil {
		t.Fatal("Open with failing SSH factory: expected error, got nil")
	}
	if got := len(reg.List()); got != 0 {
		t.Errorf("failed connect registered %d session(s), want 0", got)
	}
}

func TestLocalSession_ShellIntegrationReasonIsNone(t *testing.T) {
	reg := launcherReg()

	sess, err := reg.Open(context.Background(), Config{
		Kind: KindLocal,
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if got := sess.ShellIntegrationReason(); got != ssh.ReasonNone {
		t.Errorf("local session ShellIntegrationReason = %q, want %q", got, ssh.ReasonNone)
	}
}
