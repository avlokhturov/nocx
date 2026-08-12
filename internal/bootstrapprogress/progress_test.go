package bootstrapprogress

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

// The reader's whole contract is that it turns two words into two stage
// reports and does nothing else with anything else. Its threat model is not
// hypothetical: the descriptor is inherited, so every descendant of the user's
// shell can write to it, and nothing here can tell them apart from the shell.
// What these tests pin is the size of that consequence — a wrong or missing
// diagnosis, never a state the shell did not reach.

type recorder struct {
	mu   sync.Mutex
	seen []Stage
}

func (r *recorder) note(s Stage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen = append(r.seen, s)
}

func (r *recorder) all() []Stage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Stage(nil), r.seen...)
}

// waitFor blocks until n stages have been reported, so the assertions wait on
// a state change rather than on a duration.
func (r *recorder) waitFor(t *testing.T, n int) []Stage {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got := r.all(); len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("only %v stages arrived, want %d", r.all(), n)
	return nil
}

func newTestReader(t *testing.T) (*recorder, *os.File) {
	t.Helper()
	rec := &recorder{}
	rd, w, err := New(log.NewSlogAdapter(nil), rec.note)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		_ = w.Close()
		_ = rd.Close()
	})
	return rec, w
}

// The ordinary machine: the two facts in order produce the two stages in
// order. Paired with every refusal below, because a reader that reported
// nothing would satisfy all of them.
func TestReader_ReportsBothFactsInOrder(t *testing.T) {
	rec, w := newTestReader(t)
	if _, err := w.WriteString("startup-entered\nuser-rc-returned\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := rec.waitFor(t, 2)
	if len(got) != 2 || got[0] != StageStartupEntered || got[1] != StageUserRCReturned {
		t.Errorf("stages = %v, want [startup-entered user-rc-returned]", got)
	}
}

// A descendant that inherited the descriptor cannot manufacture a stage the
// shell never reached: the second fact without the first is out of order, and
// out of order changes nothing. This is the entire validation there is, and
// the entire validation there can be — the writer is not identifiable — so it
// is worth stating what it buys and what it does not.
func TestReader_RefusesAFactOutOfOrder(t *testing.T) {
	rec, w := newTestReader(t)
	if _, err := w.WriteString("user-rc-returned\nstartup-entered\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := rec.waitFor(t, 1)
	if len(got) != 1 || got[0] != StageStartupEntered {
		t.Errorf("stages = %v, want the out-of-order fact ignored and only startup-entered reported", got)
	}
}

// A repeat is not a second advance, so a descendant replaying what it saw
// cannot even produce a duplicate report.
func TestReader_IgnoresRepeats(t *testing.T) {
	rec, w := newTestReader(t)
	if _, err := w.WriteString("startup-entered\nstartup-entered\nstartup-entered\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := rec.waitFor(t, 1)
	if len(got) != 1 {
		t.Errorf("stages = %v, want one report for three copies of one fact", got)
	}
}

// Garbage is data, never a stage. A descendant that writes a log line, a
// progress bar or a megabyte of noise into the descriptor costs the diagnosis
// nothing.
func TestReader_IgnoresEverythingOutsideTheVocabulary(t *testing.T) {
	rec, w := newTestReader(t)
	if _, err := w.WriteString("hello\n{\"evt\":\"prompt_ready\"}\nSTARTUP-ENTERED\n\n" +
		strings.Repeat("x", 200) + "\nstartup-entered\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := rec.waitFor(t, 1)
	if len(got) != 1 || got[0] != StageStartupEntered {
		t.Errorf("stages = %v, want only the one real fact", got)
	}
}

// The budget is a bound on what a descendant can make this reader hold, and
// the drain after it is what keeps a shell from blocking on a full pipe. The
// assertion is the shape of the failure, not the number: past the budget the
// reader interprets nothing, and a writer that keeps writing still succeeds.
func TestReader_BoundsWhatItWillEverInterpret(t *testing.T) {
	rec, w := newTestReader(t)
	flood := strings.Repeat("noise\n", maxFactBytes) // far past the budget
	done := make(chan error, 1)
	go func() {
		_, err := w.WriteString(flood + "startup-entered\n")
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a flooded progress pipe blocked or broke its writer: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the writer never completed: a full progress pipe must be drained, not left to block the shell")
	}
	if got := rec.all(); len(got) != 0 {
		t.Errorf("stages = %v, want none: nothing past the budget may be interpreted", got)
	}
}

// Close ends the reader. It is called from the session teardown, so a reader
// that survived it would report a stage for a session that no longer exists.
func TestReader_CloseEndsIt(t *testing.T) {
	rec := &recorder{}
	rd, w, err := New(log.NewSlogAdapter(nil), rec.note)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := rd.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	// A write after the reader is gone must not panic anything; the shell's
	// own copy of the descriptor outliving the reader is ordinary.
	_, _ = w.WriteString("startup-entered\n")
	_ = w.Close()
}
