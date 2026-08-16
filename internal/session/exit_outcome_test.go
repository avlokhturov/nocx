package session

// ExitOutcome maps the channel's captured wait result to the wire cause
// (nocx-ictcq). These tests own the mapping: only an exit the process itself
// reported is authoritative, a loss never carries a fabricated status, and a
// channel that never reported is a loss.

import (
	"context"
	"io"
	"net"
	"os/exec"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

// waitErrChannel is a session.Channel whose wait outcome the test controls,
// shaped like the production channels' optional WaitErr seam.
type waitErrChannel struct {
	done    chan struct{}
	waitErr error
	waitSet bool
}

func (c *waitErrChannel) Read([]byte) (int, error)    { return 0, io.EOF }
func (c *waitErrChannel) Write(b []byte) (int, error) { return len(b), nil }
func (c *waitErrChannel) Close() error                { return nil }
func (c *waitErrChannel) Resize(context.Context, uint16, uint16, uint16, uint16) error {
	return nil
}
func (c *waitErrChannel) Done() <-chan struct{} { return c.done }
func (c *waitErrChannel) WaitErr() (error, bool) {
	return c.waitErr, c.waitSet
}

// sessionWithChannel builds a realSession over the given channel — the same
// construction Reg.Open uses for a local PTY.
func sessionWithChannel(ch Channel) *realSession {
	return &realSession{id: NewID(), ch: ch}
}

// realNonzeroExit runs a real shell that exits 42 and returns the
// *exec.ExitError cmd.Wait produces — the authentic shape the local pty
// watcher records.
func realNonzeroExit(t *testing.T) error {
	t.Helper()
	err := exec.Command("sh", "-c", "exit 42").Run() //nolint:gosec // test-only
	if err == nil {
		t.Fatal("sh -c 'exit 42' unexpectedly succeeded")
	}
	return err
}

// A shell that exited cleanly — Wait returned nil — is an authoritative exit
// with status 0: an exit, not a loss.
func TestExitOutcome_CleanExitIsExited(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{}), waitErr: nil, waitSet: true})
	cause, status := s.ExitOutcome()
	if cause != ExitExited {
		t.Errorf("cause = %q, want %q", cause, ExitExited)
	}
	if status != 0 {
		t.Errorf("status = %d, want 0", status)
	}
}

// A shell that exited with a nonzero status is still an authoritative exit,
// and the status is the shell's own report — mapped through *exec.ExitError,
// never guessed.
func TestExitOutcome_NonzeroExitCarriesItsStatus(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{}), waitErr: realNonzeroExit(t), waitSet: true})
	cause, status := s.ExitOutcome()
	if cause != ExitExited {
		t.Errorf("cause = %q, want %q", cause, ExitExited)
	}
	if status != 42 {
		t.Errorf("status = %d, want 42", status)
	}
}

// A wrapped *exec.ExitError stays authoritative: errors.As, not a direct
// type assertion, is what decides.
func TestExitOutcome_WrappedExitErrorStaysAuthoritative(t *testing.T) {
	wrapped := &wrapErr{err: realNonzeroExit(t)}
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{}), waitErr: wrapped, waitSet: true})
	cause, status := s.ExitOutcome()
	if cause != ExitExited {
		t.Errorf("cause = %q, want %q", cause, ExitExited)
	}
	if status != 42 {
		t.Errorf("status = %d, want 42", status)
	}
}

// A channel loss is a loss: no status may be fabricated. The error is the
// REAL type gossh returns when the remote side closed the channel without an
// exit status — what a dropped connection leaves in session.Wait — not a
// hand-written string.
func TestExitOutcome_ChannelLossIsInterrupted(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{
		done: make(chan struct{}), waitErr: &gossh.ExitMissingError{}, waitSet: true,
	})
	cause, status := s.ExitOutcome()
	if cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
	if status != 0 {
		t.Errorf("status = %d, want 0 for a loss", status)
	}
}

// End of stream — the channel produced EOF without an exit — is the same
// wire class: not the shell's own report, so a loss.
func TestExitOutcome_EndOfStreamIsInterrupted(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{
		done: make(chan struct{}), waitErr: io.EOF, waitSet: true,
	})
	if cause, _ := s.ExitOutcome(); cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
}

// A session whose end is not the shell's own report is a loss. The deadline
// error stands in for a timeout-bound teardown; this is CLASSIFICATION, not
// a path drive — the handshake-expiry seam is an integration event.
func TestExitOutcome_NonExitTeardownIsInterrupted(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{}), waitErr: context.DeadlineExceeded, waitSet: true})
	if cause, _ := s.ExitOutcome(); cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
}

// An unreachable host leaves a real *net.OpError in the channel's Wait —
// the same class of error a dial or a keepalive death produces. Still a
// loss: the backend cannot assert an exit, so it reports one.
func TestExitOutcome_UnreachableHostIsInterrupted(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	_, dialErr := net.DialTimeout("tcp", addr, time.Second)
	if dialErr == nil {
		t.Fatal("dial to a released port unexpectedly succeeded")
	}
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{}), waitErr: dialErr, waitSet: true})
	if cause, _ := s.ExitOutcome(); cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
}

// A channel whose watcher never recorded — the explicit-close race — must
// read as a loss, never as a fabricated clean exit.
func TestExitOutcome_UnrecordedOutcomeIsInterrupted(t *testing.T) {
	s := sessionWithChannel(&waitErrChannel{done: make(chan struct{})})
	cause, status := s.ExitOutcome()
	if cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
	if status != 0 {
		t.Errorf("status = %d, want 0 for an unrecorded teardown", status)
	}
}

// A channel that does not expose WaitErr at all (the pty stub, a future
// transport) reports a loss: absence of evidence is not an exit.
func TestExitOutcome_NoWaitErrSeamIsInterrupted(t *testing.T) {
	s := sessionWithChannel(&noWaitErrChannel{done: make(chan struct{})})
	if cause, _ := s.ExitOutcome(); cause != ExitInterrupted {
		t.Errorf("cause = %q, want %q", cause, ExitInterrupted)
	}
}

// ── fakes ─────────────────────────────────────────────────────────────────

type wrapErr struct{ err error }

func (w *wrapErr) Error() string { return "wrapped: " + w.err.Error() }
func (w *wrapErr) Unwrap() error { return w.err }

// noWaitErrChannel is a channel without the optional WaitErr seam.
type noWaitErrChannel struct{ done chan struct{} }

func (c *noWaitErrChannel) Read([]byte) (int, error)    { return 0, io.EOF }
func (c *noWaitErrChannel) Write(b []byte) (int, error) { return len(b), nil }
func (c *noWaitErrChannel) Close() error                { return nil }
func (c *noWaitErrChannel) Resize(context.Context, uint16, uint16, uint16, uint16) error {
	return nil
}
func (c *noWaitErrChannel) Done() <-chan struct{} { return c.done }
