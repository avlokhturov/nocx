package shellintegration

import (
	"strings"
	"testing"
	"time"
)

// Ctrl-C at a prompt, watched from BOTH sides at once: the pty (what the
// renderer sees) and the lifecycle channel (what the kernel sees). It needs
// both, because the defect below was a command the shell announced on the
// channel and marked on the stream, for a command the user never ran — and
// either side alone reads as noise rather than as a phantom.
//
// Built on channel_exec_test.go's fakeKernel/channelShell rather than on a
// second harness of its own: that one already boots the real hooks against a
// real kernel on a real pty, which is the whole of what this needs.

// TestBashInterruptAnnouncesNoPhantomCommand guards nocx-678o.
//
// extdebug makes the DEBUG trap fire inside functions, so it fires for every
// line of __nocx_prompt_command — and the wrapper suppresses that with two
// guards: a command text starting `__nocx_`, and __nocx_in_prompt_command.
// The status capture at the top of that function used to satisfy neither
// (`local __nocx_exit=$?` begins with `local`, and the flag went up four
// lines later), leaving exactly one unguarded command per prompt cycle.
//
// That is invisible after a real command, because the C-marker latch is
// already disarmed by then. After an INTERRUPT it is not: nothing ran, and
// __nocx_precmd armed the latch at the previous prompt. So Ctrl-C announced
// nocx's own line as the user's command — an OSC 133 C on the stream and a
// start/complete pair on the channel, naming `local __nocx_exit=$?` and
// carrying SIGINT's status (130 on bash 5, 1 on bash 3.2).
//
// What is asserted is the contract on both sides at once, as an interval
// with both ends: an interrupt produces a new prompt and NOTHING claiming a
// command ran, AND a real command afterwards is still reported in full —
// without which, suppressing the C marker altogether would pass.
func TestBashInterruptAnnouncesNoPhantomCommand(t *testing.T) {
	s := startChannelShell(t, "bash", "nocx.bash", bashScript)
	defer s.close()
	s.waitForHandshake()

	// The handshake is not readline. prompt_ready is sent from inside
	// __nocx_prompt_command, which runs BEFORE bash displays the prompt, and
	// the B marker rides PS1 — so B is the first byte that means "readline
	// owns the terminal now". Typing on the handshake alone raced it: the
	// line was echoed by the tty driver, the interrupt landed before readline
	// existed, and the test then failed for its own race while reading
	// exactly like the product defect it was written for.
	waitForOutput(t, s, "\x1b]133;B", 15*time.Second)

	promptsBefore := strings.Count(s.output(), "\x1b]133;A")
	cBefore := strings.Count(s.output(), "\x1b]133;C")
	startsBefore := s.kernel.count("start")
	completesBefore := s.kernel.count("complete")
	promptReadyBefore := s.kernel.count("prompt_ready")

	// A partial line typed at the prompt, then the interrupt — a user
	// abandoning what they were typing, which is the shape the enhanced
	// input path sends \x03 for (terminal-content.ts's `cancel`).
	if _, err := s.ptmx.Write([]byte("echo abandoned")); err != nil {
		t.Fatalf("write partial line: %v", err)
	}
	// The line has to reach readline before the interrupt does, or the two
	// race and the test sometimes interrupts an empty prompt instead — a
	// weaker case than the one under test.
	waitForOutput(t, s, "echo abandoned", 10*time.Second)
	if _, err := s.ptmx.Write([]byte("\x03")); err != nil {
		t.Fatalf("write interrupt: %v", err)
	}

	// The interrupt must produce a fresh prompt: the shell is alive and back
	// at readline. Anchoring on that (rather than on a sleep) is also what
	// makes the assertions below non-vacuous — they run only once the
	// interrupt's whole prompt cycle has been observed on both sides.
	waitForCount(t, func() int { return strings.Count(s.output(), "\x1b]133;A") },
		promptsBefore+1, "OSC 133 A after the interrupt", s, 15*time.Second)
	waitForCount(t, func() int { return s.kernel.count("prompt_ready") },
		promptReadyBefore+1, "prompt_ready after the interrupt", s, 15*time.Second)

	if got := strings.Count(s.output(), "\x1b]133;C") - cBefore; got != 0 {
		t.Errorf("the interrupt emitted %d OSC 133 C marker(s) — a command start for a command the user never ran\noutput: %q",
			got, s.output())
	}
	if got := s.kernel.count("start") - startsBefore; got != 0 {
		t.Errorf("the interrupt announced %d start frame(s) to the kernel: %v", got, s.kernel.events())
	}
	if got := s.kernel.count("complete") - completesBefore; got != 0 {
		t.Errorf("the interrupt announced %d completion(s) for a command that never started: %v", got, s.kernel.events())
	}

	// The closing end of the interval: the guard must not have silenced a
	// REAL command. `run` waits for the completion and the prompt after it,
	// so reaching this line at all is most of the assertion.
	s.run("echo AFTERMARK")
	if got := s.kernel.count("start") - startsBefore; got != 1 {
		t.Errorf("the command after the interrupt must be announced exactly once; got %d start frame(s): %v",
			got, s.kernel.events())
	}
	if !strings.Contains(s.output(), "AFTERMARK") {
		t.Errorf("the command after the interrupt never ran; output: %q", s.output())
	}
}

// waitForOutput blocks until substr appears on the pty.
func waitForOutput(t *testing.T, s *channelShell, substr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(s.output(), substr) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q on the pty; output: %q", substr, s.output())
}

// waitForCount blocks until get() reaches want, then reports what it was
// waiting for rather than a bare timeout.
func waitForCount(t *testing.T, get func() int, want int, what string, s *channelShell, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if get() >= want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s (want %d, have %d); accepted=%v output=%q",
		what, want, get(), s.kernel.events(), s.output())
}
