package session

// The resend's snapshot invariant (nocx-zg3k3.5.10): the departed-row count
// the walk measures with and the scrollback rows it reads are ONE read. The
// probe below arms a real departure — a genuine ingest through the runtime,
// which moves the real count and the real history together — at the seam
// the walk's count and its read share. However the walk is shaped, every
// row it resents must carry its true absolute index: a count taken before
// the read labels the newest rows with the oldest indices, and the span's
// head is silently lost and later duplicated. The two-acquisition shape
// this test replaced failed here for exactly that reason (witnessed red:
// "the row delivered at absolute index 0 reads L000010").

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/emulator"
	"github.com/shady2k/nocx/internal/sessionruntime"
)

// resendProbeRuntime wraps the real runtime for the snapshot test: every
// read it does not hook is the runtime's own. beforeSnapshot arms a
// departure at the seam — immediately before the runtime's one-acquisition
// count-and-read — the window the two-read shape held open between its
// count and its screen.
type resendProbeRuntime struct {
	rt *sessionruntime.Session
	// beforeSnapshot, when armed, runs the departure inside the walk. It
	// runs on the walk's own goroutine, so it never touches testing.T.
	beforeSnapshot func()
	hookRan        chan struct{}
	hookErr        error
}

func (p *resendProbeRuntime) ReadDepartedScreen(read func(departed uint64, t emulator.Terminal) error) (sessionruntime.Revision, sessionruntime.Completeness, error) {
	if p.beforeSnapshot != nil {
		p.beforeSnapshot()
		close(p.hookRan)
	}
	return p.rt.ReadDepartedScreen(read)
}

func TestTheResendLabelsEveryRowItsTrueIndexWhenRowsDepartInTheWalk(t *testing.T) {
	hs, rt, sink := rowsBridgeSession(t, 80, 24)

	// The command prints a hundred and forty numbered lines: the first
	// forty depart sixteen rows, and the coordinator stores and confirms
	// the head — the mark sits at 16.
	rowsFeed(t, rt, 0, 40)
	sink.waitFor(1, 0, 0)
	if err := hs.confirmRows(sink, "coord-1", 16); err != nil {
		t.Fatalf("confirm the stored rows: %v", err)
	}

	// It goes away, and the command keeps printing: the rows past the mark
	// depart for nobody, and the pump arms the resend.
	hs.mu.Lock()
	delete(hs.subs, "coord-1")
	hs.mu.Unlock()
	rowsFeed(t, rt, 40, 100)

	// It comes back. The resend's one snapshot read now goes through the
	// probe, and ten rows depart at the seam it owns.
	probe := &resendProbeRuntime{rt: rt, hookRan: make(chan struct{})}
	probe.beforeSnapshot = func() {
		var sb strings.Builder
		for i := 117; i < 127; i++ {
			fmt.Fprintf(&sb, "L%06d\r\n", i)
		}
		probe.hookErr = rt.Ingest([]byte(sb.String()))
	}
	sink2 := newRowsSink()
	hs.mu.Lock()
	hs.subs["coord-2"] = &subscriber{id: "coord-2", raw: mintRaw(t), sink: sink2}
	hs.mu.Unlock()
	hs.resendRT = probe
	hs.wakeRows()

	sink2.waitFor(5, 0, 0)

	select {
	case <-probe.hookRan:
	default:
		t.Fatal("the walk never reached the snapshot seam: the probe's departure never armed")
	}
	if probe.hookErr != nil {
		t.Fatalf("the departure at the seam: %v", probe.hookErr)
	}

	// Every delivered row — resent or pumped — must carry its own text at
	// its own absolute index, and everything the walk owed must arrive:
	// the walk's lower bound is the running interval's own start (0), so
	// the span is [0, 127) — the 117 rows the count held plus the ten
	// that departed at the seam.
	type rowsDoc struct {
		FromRow uint64 `json:"fromRow"`
		Rows    []struct {
			Text string `json:"text"`
		} `json:"rows"`
	}
	seen := map[uint64]string{}
	for _, f := range sink2.rowFrames() {
		var doc rowsDoc
		if err := json.Unmarshal(f.Payload, &doc); err != nil {
			t.Fatalf("decode a rows frame: %v", err)
		}
		for i, r := range doc.Rows {
			label := doc.FromRow + uint64(i) //nolint:gosec // a row count, not a byte count
			if r.Text != fmt.Sprintf("L%06d", label) {
				t.Fatalf("the row delivered at absolute index %d reads %q — the walk's count and its read disagreed",
					label, r.Text)
			}
			seen[label] = r.Text
		}
	}
	for i := uint64(0); i < 127; i++ { //nolint:gosec // a row count, not a byte count
		if _, ok := seen[i]; !ok {
			t.Fatalf("absolute row %d never arrived: %d rows of the span are missing", i, 127-len(seen))
		}
	}
}
