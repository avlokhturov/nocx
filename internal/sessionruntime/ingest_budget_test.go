package sessionruntime

// The ingest hot path's speed budget (nocx-zg3k3.5.8): taking a program's
// output in and streaming its departed rows out has a BUDGET, held by a
// test, and a benchmark that measures the path.
//
// The path measured here is the production one, over the real emulator
// (libghostty-vt behind its port) and the real runtime, with no PTY: the
// carrier's bytes arrive through [Session.Ingest] in [MaxIngestBytes]
// chunks, the emulator departs rows off the live rectangle, the drain hands
// each batch to this session's [RowStream], and the stream does the pump's
// encoding — [EncodeRows] per [pumpRowsPerFrame]-row split, then the
// [proto.OutputRowsDoc] marshal, exactly as
// internal/helper/session/rows.go's deliverRowEmission does it before a
// sink takes the frame. The pump's queue, its goroutine and the socket are
// not reachable without a helper session; everything up to the encoded
// frame is, and that is the work whose shape a regression would change.
//
// The feed is fixed: about four MiB of numbered, styled, full-width lines
// at 120x40 — the same shape the real chain test floods with
// (internal/transport/ws_block_rows_bounds_test.go's styledFloodCommand),
// one column short of wrap so every line stays one row. No fence rides the
// feed: the budget is the cost of TAKING OUTPUT IN AND STREAMING ITS ROWS,
// not the once-per-command rendezvous of sealing one.
//
// What gates and what only reports is the owner's decision of 2026-09-29
// (run preflight, point 5, on nocx-zg3k3.5): the budget GATES on
// allocations and bytes allocated per MiB fed — numbers that do not depend
// on the machine — and THROUGHPUT IS MEASURED AND REPORTED, NEVER GATED
// (AGENTS.md: a test may not depend on timing; CI machines differ from
// this one). [TestIngestToRowStreamStaysWithinItsBudget] holds the gate;
// [BenchmarkIngestToDepartedRows] reports ns/op, MiB/s, allocs/MiB and
// B/MiB for the next baseline re-measurement.

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/emulator"
	"github.com/shady2k/nocx/internal/emulator/ghostty"
	"github.com/shady2k/nocx/internal/helper/proto"
)

// budgetFeedBytes is how much output one feed carries: a few MiB, large
// enough that per-call constants amortize away and small enough that the
// whole package suite stays quick with the budget test in it.
const budgetFeedBytes = 4 << 20

// pumpRowsPerFrame is the helper's own split bound, spelled here because
// internal/helper/session declares it unexported (rowsPerFrame = 32): the
// pump splits every batch at this row count before one rows frame is
// encoded, and the budget's stream splits the same way, or it would measure
// a shape production never builds.
const pumpRowsPerFrame = 32

// budgetGeometry is 120x40, the geometry this bead names.
func budgetGeometry() Geometry {
	return harnessGeometry(120, 40)
}

// budgetFeed builds the fixed feed once per process: numbered, styled,
// full-width lines at 120 columns (119 to stay one short of wrap), a
// truecolour foreground over the whole line the way a program's colourised
// output arrives. Built outside the timed regions; a lazily-built package
// value, so the rest of the suite pays nothing for it.
var budgetFeed = sync.OnceValue(func() []byte {
	var b strings.Builder
	for i := 0; b.Len() < budgetFeedBytes; i++ {
		// rNNNNNN + padding to column 119, all under one SGR colour; the
		// padding spaces carry the style, so nothing trims them and every
		// row is genuinely full-width on the wire.
		fmt.Fprintf(&b, "\x1b[38;2;90;64;200mr%06d%-111s\x1b[0m\r\n", i, "")
	}
	return []byte(b.String())
})

// budgetStream is the [RowStream] the benchmark and the budget test bind:
// the helper row bridge's ENCODING half, minus the socket. OutputRows
// splits each batch at pumpRowsPerFrame and encodes each frame exactly as
// internal/helper/session/rows.go's deliverRowEmission does — EncodeRows,
// then one json.Marshal of the rows document — counting the payload bytes
// a sink would take and the frames it would send. The first encode error
// is kept, never swallowed: a feed that could not be encoded measured
// nothing and must fail its caller.
type budgetStream struct {
	payloadBytes int64
	frames       int
	err          error
}

func (bs *budgetStream) OutputRows(from uint64, rows []emulator.Row, lost uint64) {
	doc := proto.OutputRowsDoc{FromRow: from, LostRows: lost}
	for start := 0; start <= len(rows); start += pumpRowsPerFrame {
		stop := start + pumpRowsPerFrame
		if stop > len(rows) {
			stop = len(rows)
		}
		raw, err := EncodeRows(rows[start:stop])
		if err != nil {
			bs.err = fmt.Errorf("sessionruntime: encode rows: %w", err)
			return
		}
		doc.Rows = raw
		payload, err := json.Marshal(doc)
		if err != nil {
			bs.err = fmt.Errorf("sessionruntime: marshal rows document: %w", err)
			return
		}
		bs.payloadBytes += int64(len(payload)) // #nosec G115 -- len is never negative
		bs.frames++
		if stop == len(rows) {
			return
		}
		doc.FromRow += uint64(stop - start) // #nosec G115 -- slice arithmetic, never negative
		// The gap LostRows states belongs to the first split frame alone,
		// exactly as the pump's own split does it.
		doc.LostRows = 0
	}
}

func (bs *budgetStream) IntervalEnd(nonce FenceNonce, endRow uint64, closing []emulator.Row, settledWithoutFence bool) {
	// encodedRowsOrNothing's shape: nil closing marshals as null, the
	// contract's answer for a screen that could not be read.
	var closingRaw json.RawMessage
	if closing != nil {
		raw, err := EncodeRows(closing)
		if err != nil {
			bs.err = fmt.Errorf("sessionruntime: encode closing rows: %w", err)
			return
		}
		closingRaw = raw
	}
	payload, err := json.Marshal(proto.IntervalEndDoc{
		Nonce:   hex.EncodeToString(nonce[:]),
		EndRow:  endRow,
		Closing: closingRaw,
		NoFence: settledWithoutFence,
	})
	if err != nil {
		bs.err = fmt.Errorf("sessionruntime: marshal interval end: %w", err)
		return
	}
	bs.payloadBytes += int64(len(payload)) // #nosec G115 -- len is never negative
	bs.frames++
}

func (bs *budgetStream) ClearBoundary() {
	payload, err := json.Marshal(proto.ClearBoundaryDoc{Kind: "clear"})
	if err != nil {
		bs.err = fmt.Errorf("sessionruntime: marshal clear boundary: %w", err)
		return
	}
	bs.payloadBytes += int64(len(payload)) // #nosec G115 -- len is never negative
	bs.frames++
}

// newBudgetSession builds the real chain over a fresh emulator: the real
// ghostty port at 120x40, the real runtime over it, and a budgetStream
// bound as the row stream. The returned stop closes the emulator; the
// harness terminal and the direct reply sink are this package's own test
// instruments, and the feed asks the program nothing, so the reply sink is
// never written.
func newBudgetSession() (*Session, *budgetStream, func(), error) {
	g := budgetGeometry()
	term := newHarnessTerminal(g)
	screen, err := ghostty.New(g)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sessionruntime: build the emulator: %w", err)
	}
	s, err := New(Config{
		Incarnation:  Incarnation{Session: "ingest-budget", Generation: 1},
		Geometry:     g,
		Terminal:     term,
		Emulator:     screen,
		Completeness: CompletenessComplete,
		Replies:      directReplySink{term: term},
	})
	if err != nil {
		screen.Close()
		return nil, nil, nil, fmt.Errorf("sessionruntime: build the runtime: %w", err)
	}
	stream := &budgetStream{}
	s.SetRowStream(stream)
	return s, stream, screen.Close, nil
}

// feedBudgetStream feeds the whole fixed feed through the session the way
// the carrier hands bytes: chunks of at most MaxIngestBytes.
func feedBudgetStream(s *Session) error {
	feed := budgetFeed()
	for len(feed) > 0 {
		n := min(len(feed), MaxIngestBytes)
		if err := s.Ingest(feed[:n]); err != nil {
			return fmt.Errorf("sessionruntime: ingest a %d-byte chunk: %w", n, err)
		}
		feed = feed[n:]
	}
	return nil
}

// BenchmarkIngestToDepartedRows measures the whole path — ingest through
// the real emulator, the departure drain, the row stream, the pump's
// encoding — per four-MiB feed, and reports it per MiB of output fed:
// ns/op (the framework's own), MiB/s, allocs/MiB and B/MiB.
//
// Throughput here is a REPORT, never a gate: this machine is not CI, and
// AGENTS.md forbids a test that depends on timing. The gate lives in
// TestIngestToRowStreamStaysWithinItsBudget, over the machine-independent
// numbers.
//
// Re-measuring a baseline (then re-deriving the budget constants below):
//
//	go test -tags gtk3 -run '^$' -bench BenchmarkIngestToDepartedRows \
//		-benchtime 10x ./internal/sessionruntime
func BenchmarkIngestToDepartedRows(b *testing.B) {
	feed := budgetFeed()
	mibPerOp := float64(len(feed)) / (1 << 20)
	var mallocs, bytesAlloc uint64
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		s, stream, stop, err := newBudgetSession()
		if err != nil {
			b.Fatal(err)
		}
		// The setup and the counters' before-reading sit outside the
		// timed region; only the feed itself is measured. MemStats counts
		// every goroutine, and the runtime spawns none of its own, so the
		// delta is the feed's.
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		b.StartTimer()
		feedErr := feedBudgetStream(s)
		b.StopTimer()
		runtime.ReadMemStats(&after)
		stop()
		if feedErr != nil {
			b.Fatal(feedErr)
		}
		if stream.err != nil {
			b.Fatal(stream.err)
		}
		mallocs += after.Mallocs - before.Mallocs
		bytesAlloc += after.TotalAlloc - before.TotalAlloc
	}
	b.ReportMetric(float64(mallocs)/float64(b.N)/mibPerOp, "allocs/MiB")
	b.ReportMetric(float64(bytesAlloc)/float64(b.N)/mibPerOp, "B/MiB")
	if elapsed := b.Elapsed(); elapsed > 0 {
		b.ReportMetric(mibPerOp*float64(b.N)/elapsed.Seconds(), "MiB/s")
	}
}

// The budget: the measured baseline on this tree plus a stated margin,
// held by TestIngestToRowStreamStaysWithinItsBudget. Both numbers came off
// THIS tree with BenchmarkIngestToDepartedRows on 2026-09-29, on the
// x86-64 Linux box this worktree runs on (AMD Ryzen 5 8600G), with:
//
//	go test -tags gtk3 -run '^$' -bench BenchmarkIngestToDepartedRows \
//		-benchtime 10x ./internal/sessionruntime
//
// The margin is 25%, the brief's stated figure. A change that crosses
// either number has put a new allocation on the ingest-to-departed-rows
// path — the regression the budget exists to catch — and the fix is to
// remove it, not to raise the budget: raising one re-measures the baseline
// with the benchmark, says in a bead why the new shape is right, and dates
// the new numbers the same way these are dated.
const (
	// baseline 2026-09-29: 8,422,197 allocs/MiB and 225,399,763 B/MiB, so
	// each gate is that number plus 25%, rounded up.
	budgetAllocsPerMiB = 10_550_000 // baseline 8,422,197 allocs/MiB, +25%
	budgetBytesPerMiB  = 282_000_000
)

// TestIngestToRowStreamStaysWithinItsBudget runs the same feed the
// benchmark does, once, and FAILS when allocations or bytes allocated per
// MiB fed exceed the budget above. The numbers are allocation counts, not
// timings — they do not depend on this machine's speed, so the check is
// legitimate everywhere the suite runs (the owner's decision of 2026-09-29,
// run preflight point 5). Throughput is deliberately NOT asserted.
func TestIngestToRowStreamStaysWithinItsBudget(t *testing.T) {
	// One warm-up feed on its own session, so the measured feed pays only
	// the path's own costs and not the process's one-time charges (the
	// emulator library's init, the JSON encoder's type caches).
	warm, warmStream, stopWarm, err := newBudgetSession()
	if err != nil {
		t.Fatal(err)
	}
	if feedErr := feedBudgetStream(warm); feedErr != nil {
		stopWarm()
		t.Fatal(feedErr)
	}
	stopWarm()
	if warmStream.err != nil {
		t.Fatal(warmStream.err)
	}

	s, stream, stop, err := newBudgetSession()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	err = feedBudgetStream(s)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	if stream.err != nil {
		t.Fatal(stream.err)
	}

	mib := float64(len(budgetFeed())) / (1 << 20)
	allocsPerMiB := float64(after.Mallocs-before.Mallocs) / mib
	bytesPerMiB := float64(after.TotalAlloc-before.TotalAlloc) / mib
	streamed := stream.payloadBytes
	t.Logf("fed %.2f MiB: %.0f allocs/MiB, %.0f B/MiB, %d encoded frames, %.1f MiB of payload",
		mib, allocsPerMiB, bytesPerMiB, stream.frames, float64(streamed)/(1<<20))

	if allocsPerMiB > budgetAllocsPerMiB {
		t.Fatalf("the ingest-to-departed-rows path spent %.0f allocs/MiB, over the budget of %d (+25%% over the %s baseline): a new allocation has landed on the path",
			allocsPerMiB, budgetAllocsPerMiB, "2026-09-29")
	}
	if bytesPerMiB > budgetBytesPerMiB {
		t.Fatalf("the ingest-to-departed-rows path allocated %.0f B/MiB, over the budget of %d (+25%% over the %s baseline): a new copy has landed on the path",
			bytesPerMiB, budgetBytesPerMiB, "2026-09-29")
	}
	if streamed == 0 {
		t.Fatal("the feed produced no encoded frames: the row stream measured nothing")
	}
}
