package procwatch_test

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/procwatch"
)

// The measured case this package exists for (nocx-cgzc): a shell nocx started
// execs a wrapper out of the user's own startup file, milliseconds after the
// fork, and until now the ONLY way the product learned the shell would never
// answer was that it had not answered for ten seconds.
//
// Nothing here waits on a duration. The child blocks on a read until the test
// says go, and every assertion waits on a state change — an observation
// arriving, or the child exiting.
//
// gateShell is deliberately zsh rather than sh on darwin, and the reason is a
// measurement worth keeping: macOS's /bin/sh REPLACES ITS OWN IMAGE with bash
// a few milliseconds after it starts, so a test gated on it would report a
// takeover that is really the system shell being itself. zsh and bash — the
// only two shells nocx ever starts an integrated session with — hold their
// name for the life of the process, measured over the same window.

// newWatcher builds this platform's watcher and closes it with the test.
func newWatcher(t *testing.T) procwatch.Watcher {
	t.Helper()
	w := procwatch.New(log.NewSlogAdapter(nil))
	t.Cleanup(func() { _ = w.Close() })
	return w
}

// startGate starts the gate shell with a pipe on its stdin and returns the
// command plus the gate that releases it. The child cannot reach the
// interesting line until the test opens the gate, so registration always
// happens first without anybody sleeping to arrange it.
func startGate(t *testing.T, script string) (*exec.Cmd, func()) {
	t.Helper()
	cmd := exec.Command(gateShell, "-c", script)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("StdinPipe: %v", err)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %q: %v", script, err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	return cmd, func() {
		if _, err := io.WriteString(in, "go\n"); err != nil {
			t.Fatalf("open the gate: %v", err)
		}
		_ = in.Close()
	}
}

// The whole point, stated as the user's situation: the process nocx started
// is replaced by another executable, and the backend knows within one
// delivery of the kernel's own notification — not when a ten-second bound
// expires.
func TestReplacedProcessIsObserved(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	// `exec` is explicit so the replacement is the shell's own doing rather
	// than an optimisation we would be relying on.
	cmd, open := startGate(t, "read gate; exec sleep 60")

	seen := make(chan procwatch.Observation, 1)
	stop, err := w.Started(cmd.Process.Pid, gateShell, func(o procwatch.Observation) { seen <- o })
	if err != nil {
		t.Fatalf("Started: %v", err)
	}
	t.Cleanup(stop)

	open()
	obs := <-seen
	if obs.PID != cmd.Process.Pid {
		t.Errorf("pid = %d, want %d", obs.PID, cmd.Process.Pid)
	}
	if obs.Name != "sleep" {
		t.Errorf("name = %q, want the executable now running in place of the shell", obs.Name)
	}
}

// The paired "and on an ordinary machine nothing happens": a process that is
// never replaced is never reported. Asserted after the child has EXITED, so
// there is no window left in which the observation could still arrive — a
// duration would only have proved that nothing happened yet.
func TestUnreplacedProcessIsNeverReported(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	// Every command in the script is a shell builtin, so this shell runs to
	// its exit without ever replacing its image.
	cmd, open := startGate(t, "read gate; exit 0")

	seen := make(chan procwatch.Observation, 1)
	stop, err := w.Started(cmd.Process.Pid, gateShell, func(o procwatch.Observation) { seen <- o })
	if err != nil {
		t.Fatalf("Started: %v", err)
	}
	t.Cleanup(stop)

	open()
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	select {
	case obs := <-seen:
		t.Fatalf("observed %+v; a shell that was never replaced must not be marked", obs)
	default:
	}
}

// The registration race, which is what this bug is actually made of: the
// wrapper takes the shell over in the milliseconds between the fork and the
// watch. The watcher samples the process table as it registers, so an
// already-replaced process is reported at once rather than never.
func TestAlreadyReplacedAtRegistrationIsObserved(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	cmd, _ := startGate(t, "read gate; exit 0")

	seen := make(chan procwatch.Observation, 1)
	// The process is the gate shell; it is registered as something else,
	// which is exactly the state a watch arriving after the exec finds.
	stop, err := w.Started(cmd.Process.Pid, "/usr/local/bin/kiro-cli-term", func(o procwatch.Observation) { seen <- o })
	if err != nil {
		t.Fatalf("Started: %v", err)
	}
	t.Cleanup(stop)

	obs := <-seen
	if obs.Name != commOf(gateShell) {
		t.Errorf("name = %q, want %q — the executable actually running", obs.Name, commOf(gateShell))
	}
}

// The details surface shows this string to a person, and the schema forbids a
// path, an argument or a command line in it: a command line carries the
// user's own text into a surface that is not theirs (nocx-viil.3). Asserted
// against a process replaced by an absolute path with an argument.
func TestObservationCarriesANameAndNothingElse(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	cmd, open := startGate(t, "read gate; exec /bin/sleep 60")

	seen := make(chan procwatch.Observation, 1)
	stop, err := w.Started(cmd.Process.Pid, gateShell, func(o procwatch.Observation) { seen <- o })
	if err != nil {
		t.Fatalf("Started: %v", err)
	}
	t.Cleanup(stop)

	open()
	obs := <-seen
	if obs.Name == "" {
		t.Fatal("name is empty: an observation nobody can name is not worth showing")
	}
	if strings.ContainsAny(obs.Name, "/ \t") {
		t.Errorf("name = %q, want a bare executable name: no path, no arguments, no command line", obs.Name)
	}
}

// One takeover is reported once. The kernel's notification and the sample
// taken while registering can both describe the same exec, and a product that
// told the user twice would emit two status transitions for one event.
func TestOneReplacementIsReportedOnce(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	cmd, open := startGate(t, "read gate; exec sleep 60")

	seen := make(chan procwatch.Observation, 4)
	stop, err := w.Started(cmd.Process.Pid, gateShell, func(o procwatch.Observation) { seen <- o })
	if err != nil {
		t.Fatalf("Started: %v", err)
	}
	t.Cleanup(stop)

	open()
	<-seen
	// The watch is one-shot, so the second exec of the same process cannot
	// produce a second observation. Proven by killing the process — an exit
	// the watcher sees — and finding the channel still empty.
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if len(seen) != 0 {
		t.Errorf("observations = %d, want exactly one for one takeover", 1+len(seen))
	}
}

// A watcher that cannot observe says so, in a typed error the caller can
// recognise — rather than accepting the watch and observing nothing, which is
// the silent degrade AGENTS.md names. This test runs on every platform: the
// one that cannot look still has to say so out loud.
func TestStartedIsHonestAboutWhatThisPlatformCanDo(t *testing.T) {
	w := newWatcher(t)
	stop, err := w.Started(os.Getpid(), os.Args[0], func(procwatch.Observation) {})
	if stop == nil {
		t.Fatal("stop is nil; it must always be safe to call")
	}
	t.Cleanup(stop)
	if observationSupported && err != nil {
		t.Errorf("Started: %v; this platform observes exec and must accept the watch", err)
	}
	if !observationSupported && !errors.Is(err, procwatch.ErrUnsupported) {
		t.Errorf("Started error = %v, want ErrUnsupported on a platform that cannot observe an exec", err)
	}
}

// A watch on a process that no longer exists is refused rather than accepted
// and silently never answered: every external call this package makes has a
// failing path, and this is the kernel's.
func TestWatchOnADeadProcessIsRefused(t *testing.T) {
	requireObservation(t)
	w := newWatcher(t)
	cmd, open := startGate(t, "read gate; exit 0")
	open()
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if _, err := w.Started(cmd.Process.Pid, gateShell, func(procwatch.Observation) {}); err == nil {
		t.Error("Started accepted a watch on a process that has exited; nothing would ever answer it")
	}
}

// Closing is idempotent and takes the goroutine with it — the composition
// root closes on shutdown, and a second close on a torn-down app must not
// panic.
func TestCloseIsIdempotent(t *testing.T) {
	w := procwatch.New(log.NewSlogAdapter(nil))
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := w.Started(os.Getpid(), os.Args[0], func(procwatch.Observation) {}); err == nil {
		t.Error("a closed watcher accepted a watch; nothing is reading the queue any more")
	}
}

// commOf is the test's own copy of "what the kernel calls this executable",
// deliberately not the package's: a test that reuses the implementation's
// normalisation cannot report that the normalisation is wrong.
func commOf(path string) string {
	i := strings.LastIndex(path, "/")
	return path[i+1:]
}

// requireObservation skips the behaviour tests where the platform genuinely
// cannot answer.
func requireObservation(t *testing.T) {
	t.Helper()
	if !observationSupported {
		t.Skip("this platform does not observe process replacement; see procwatch's package comment")
	}
}
