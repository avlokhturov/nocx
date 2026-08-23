package content_test

// The durable retention watermark and the eviction of entries (nocx-rtg0.12),
// design §5.4.
//
// The constraint these tests exist to hold is one sentence from the design:
// coverage CANNOT be computed from the rows that remain. Once eviction has
// deleted the rows there is nothing left to count, so every assertion about
// Coverage below is written to fail against a `SELECT MIN(ended_at) FROM
// entries` implementation — either by naming a horizon older than every
// surviving row, or by naming one at all when no row survives.
//
// The second rule here is that the watermark and the deletion are one
// transaction. That is asserted from both directions: a failing DELETE must
// leave the watermark where it was, and a failing watermark write must leave
// every row in place. Neither half is allowed to exist without the other.

import (
	"context"
	"fmt"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// ── fixtures ─────────────────────────────────────────────────────────────

// openLedgerAt reopens an existing store file — what proves the watermark is
// on disk rather than in the process that wrote it.
func openLedgerAt(t *testing.T, path string) content.LedgerRepository {
	t.Helper()
	db, err := content.Open(context.Background(), content.Config{
		Path: path, Key: testKey(), Budget: testBudget,
	})
	if err != nil {
		t.Fatalf("reopen %s: %v", path, err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db.Ledger()
}

// closeEntryAt walks an entry to closed with an EXACT ended_at. closeEntry
// stamps time.Now(), which cannot express "this ended long ago" — and a
// retention test that cannot place a row in the past can only assert that
// eviction removed nothing.
func closeEntryAt(t *testing.T, led content.LedgerRepository, id string, endedAt int64) {
	t.Helper()
	ctx := context.Background()
	execID, err := led.StartExecution(ctx, content.StartExecution{EntryID: id})
	if err != nil {
		t.Fatalf("StartExecution(%q): %v", id, err)
	}
	zero := 0
	payload := content.ShellPayloadJSON(&zero)
	if err := led.FinishExecution(ctx, execID, content.FinishExecution{
		EndedAt:           endedAt,
		TerminationReason: content.TermCompleted,
		Status:            content.EntrySuccess,
		Payload:           &payload,
	}); err != nil {
		t.Fatalf("FinishExecution(%q): %v", id, err)
	}
}

// seedClosed records one closed entry per instant, in the order given, so
// ingest_seq runs 1..n while ended_at is whatever the caller says. The two
// orders are deliberately separable: eviction claims to walk ingest_seq, and
// a fixture where the two agree cannot tell that claim from wall-clock order.
func seedClosed(t *testing.T, led content.LedgerRepository, ends ...int64) []string {
	t.Helper()
	envReady(t, led, "local")
	ids := make([]string, 0, len(ends))
	for i, end := range ends {
		id := entryID(i + 1)
		submitAt(t, led, id, "local", "/repo", content.EntryShell, fmt.Sprintf("cmd-%d", i+1))
		closeEntryAt(t, led, id, end)
		ids = append(ids, id)
	}
	return ids
}

func evictOK(t *testing.T, led content.LedgerRepository, req content.EvictionRequest) content.EvictionResult {
	t.Helper()
	res, err := led.EvictEntries(context.Background(), req)
	if err != nil {
		t.Fatalf("EvictEntries(%+v): %v", req, err)
	}
	return res
}

func watermarkOK(t *testing.T, led content.LedgerRepository) content.RetentionWatermark {
	t.Helper()
	wm, err := led.Watermark(context.Background())
	if err != nil {
		t.Fatalf("Watermark: %v", err)
	}
	return wm
}

func coverageOK(t *testing.T, led content.LedgerRepository) *int64 {
	t.Helper()
	return queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 50}).Coverage
}

// ── the criterion: coverage is not derivable from what remains ───────────

// A horizon OLDER than every surviving row. The survivors end at 40000 and
// 50000, so MIN(ended_at) over the store is 40000; the watermark says 3000,
// the newest instant eviction actually removed. No query over the remaining
// rows can produce 3000 — the row that carried it is gone.
func TestCoverageAfterEvictionNamesAHorizonNoSurvivingRowHolds(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 1000, 2000, 3000, 40000, 50000)

	res := evictOK(t, led, content.EvictionRequest{Before: 3500, Max: 100})
	if res.Evicted != 3 {
		t.Fatalf("evicted %d entries, want the three that ended before 3500", res.Evicted)
	}

	cov := coverageOK(t, led)
	if cov == nil {
		t.Fatal("Coverage is nil after an eviction that removed three rows")
	}
	if *cov != 3000 {
		t.Fatalf("Coverage = %d, want the watermark horizon 3000", *cov)
	}
	// The load-bearing assertion: 3000 is strictly older than the oldest
	// surviving row, so MIN(ended_at) over the survivors (40000) cannot be
	// the source of it.
	if *cov >= 40000 {
		t.Fatalf("Coverage = %d — that is the surviving rows' MIN(ended_at), not the watermark", *cov)
	}
}

// The strongest form: evict every row. MIN(ended_at) over an empty table is
// NULL, so the pre-watermark implementation reports "no horizon at all" for a
// store that has evicted its entire history — full coverage over nothing. The
// watermark still names the horizon and a count larger than the table holds.
func TestCoverageSurvivesAStoreEvictedEmpty(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 1000, 2000, 3000)

	res := evictOK(t, led, content.EvictionRequest{Before: 9000, Max: 100})
	if res.Evicted != 3 {
		t.Fatalf("evicted %d, want all 3", res.Evicted)
	}

	page := queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10})
	if len(page.Entries) != 0 {
		t.Fatalf("page = %v, want an emptied store", pageIDs(page))
	}
	if page.HasRows {
		t.Fatal("HasRows is true for a store eviction emptied")
	}
	if page.Coverage == nil {
		t.Fatal("Coverage is nil for an emptied store — the horizon it was evicted to is exactly what the user needs")
	}
	if *page.Coverage != 3000 {
		t.Fatalf("Coverage = %d, want the horizon 3000", *page.Coverage)
	}

	wm := watermarkOK(t, led)
	if wm.EvictedCount != 3 {
		t.Fatalf("EvictedCount = %d, want 3 — a count larger than the table now holds", wm.EvictedCount)
	}
}

// Never evicted means the honest answer is still the surviving-rows one: the
// store holds everything it ever had, so the oldest row IS the horizon.
func TestCoverageIsTheSurvivingRowsAnswerUntilSomethingIsEvicted(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 7000, 8000, 9000)

	wm := watermarkOK(t, led)
	if wm.EvictedCount != 0 {
		t.Fatalf("EvictedCount = %d on a store that never evicted", wm.EvictedCount)
	}
	if wm.Horizon != nil {
		t.Fatalf("Horizon = %d before any eviction — there is no horizon to state", *wm.Horizon)
	}

	cov := coverageOK(t, led)
	if cov == nil || *cov != 7000 {
		t.Fatalf("Coverage = %v, want the oldest retained row 7000", cov)
	}
}

// An eviction that removes nothing must not invent a horizon: a pass that
// found no candidate leaves the store exactly as complete as it was.
func TestAnEvictionThatRemovesNothingLeavesNoWatermark(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 7000, 8000)

	res := evictOK(t, led, content.EvictionRequest{Before: 100, Max: 100})
	if res.Evicted != 0 {
		t.Fatalf("evicted %d from a store whose rows are all newer than the cutoff", res.Evicted)
	}
	wm := watermarkOK(t, led)
	if wm.EvictedCount != 0 || wm.Horizon != nil {
		t.Fatalf("watermark = %+v after a pass that removed nothing", wm)
	}
	if cov := coverageOK(t, led); cov == nil || *cov != 7000 {
		t.Fatalf("Coverage = %v, want the surviving-rows answer 7000", cov)
	}
}

// ── both ends of the interval ────────────────────────────────────────────

// The watermark's horizon becomes true when its eviction COMMITS and stops
// being true when the next eviction commits a newer one. Both ends are named
// here: it does not exist before the first pass; it holds across unrelated
// writes and across a reopen (durable, not cached); and it is replaced —
// forward only — by the second pass, never reverting.
func TestWatermarkHoldsFromItsCommitUntilTheNextEviction(t *testing.T) {
	db, led, path := newLedgerAt(t)
	seedClosed(t, led, 1000, 2000, 3000, 4000, 5000)

	// ── before: the interval has not opened ──
	if wm := watermarkOK(t, led); wm.Horizon != nil {
		t.Fatalf("Horizon = %d before the first eviction", *wm.Horizon)
	}

	// ── opens: the first pass commits horizon 2000 ──
	evictOK(t, led, content.EvictionRequest{Before: 2500, Max: 100})
	first := watermarkOK(t, led)
	if first.Horizon == nil || *first.Horizon != 2000 {
		t.Fatalf("Horizon = %v after the first pass, want 2000", first.Horizon)
	}

	// ── stays true across an unrelated write ──
	submitAt(t, led, entryID(90), "local", "/repo", content.EntryShell, "later work")
	if wm := watermarkOK(t, led); wm.Horizon == nil || *wm.Horizon != 2000 {
		t.Fatalf("Horizon = %v after an unrelated submit, want it untouched at 2000", wm.Horizon)
	}

	// ── and across a reopen: it is on disk, not in memory ──
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	reopened := openLedgerAt(t, path)
	if wm := watermarkOK(t, reopened); wm.Horizon == nil || *wm.Horizon != 2000 {
		t.Fatalf("Horizon = %v after reopen, want the durable 2000", wm.Horizon)
	}
	if wm := watermarkOK(t, reopened); wm.EvictedCount != 2 {
		t.Fatalf("EvictedCount = %d after reopen, want 2", wm.EvictedCount)
	}

	// ── closes: the second pass replaces it, forward ──
	evictOK(t, reopened, content.EvictionRequest{Before: 4500, Max: 100})
	second := watermarkOK(t, reopened)
	if second.Horizon == nil || *second.Horizon != 4000 {
		t.Fatalf("Horizon = %v after the second pass, want 4000", second.Horizon)
	}
	if second.EvictedCount != 4 {
		t.Fatalf("EvictedCount = %d, want the running total 4", second.EvictedCount)
	}
}

// The horizon never moves backwards. A pass whose newest victim is OLDER than
// the standing horizon has learned nothing about coverage — the store was
// already incomplete that far back — and a horizon that reverted would tell
// the user the store recovered history it did not.
func TestHorizonOnlyEverAdvances(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 5000, 6000, 7000)

	evictOK(t, led, content.EvictionRequest{Before: 6500, Max: 100})
	if wm := watermarkOK(t, led); wm.Horizon == nil || *wm.Horizon != 6000 {
		t.Fatalf("Horizon = %v, want 6000", wm.Horizon)
	}

	// A backdated row arrives after the horizon was set — a command that
	// closes reporting an end long past. Evicting it removes an instant
	// OLDER than the standing horizon, which teaches the store nothing new
	// about its coverage: it was already incomplete that far back.
	late := entryID(4)
	submitAt(t, led, late, "local", "/repo", content.EntryShell, "backdated")
	closeEntryAt(t, led, late, 1000)

	res := evictOK(t, led, content.EvictionRequest{Before: 1500, Max: 100})
	if res.Evicted != 1 {
		t.Fatalf("evicted %d, want the one row ending at 1000", res.Evicted)
	}
	wm := watermarkOK(t, led)
	if wm.Horizon == nil || *wm.Horizon != 6000 {
		t.Fatalf("Horizon = %v after evicting an older instant, want it held at 6000", wm.Horizon)
	}
	if wm.EvictedCount != 3 {
		t.Fatalf("EvictedCount = %d, want 3", wm.EvictedCount)
	}
}

// ── the order eviction walks ─────────────────────────────────────────────

// Oldest-first by ingest_seq, never by wall clock. The fixture inverts the
// two: ingest_seq 1 ends LAST (9000) and ingest_seq 3 ends first (1000). A
// pass capped at one row must take ingest_seq 1 — the ledger's total order —
// and an implementation ordering by ended_at would take the 1000 row instead.
func TestEvictionWalksIngestSeqNotWallClock(t *testing.T) {
	_, led := newLedger(t)
	ids := seedClosed(t, led, 9000, 5000, 1000)

	res := evictOK(t, led, content.EvictionRequest{Before: 9500, Max: 1})
	if res.Evicted != 1 {
		t.Fatalf("evicted %d under a cap of 1", res.Evicted)
	}

	page := queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10})
	// Newest first by ingest_seq: what remains is 3 then 2.
	wantOnly(t, page, ids[2], ids[1])

	// And the horizon is the instant that row carried — 9000 — which is
	// NEWER than both survivors. Honest: the store cannot speak completely
	// for anything up to 9000, because it removed a row that ended there.
	if wm := watermarkOK(t, led); wm.Horizon == nil || *wm.Horizon != 9000 {
		t.Fatalf("Horizon = %v, want the evicted row's 9000", wm.Horizon)
	}
}

// The cap bounds one pass. Eviction runs inside the writer turn, so an
// unbounded DELETE over a large backlog would stall every other mutation
// behind it.
func TestEvictionRespectsItsCap(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 1000, 2000, 3000, 4000, 5000)

	res := evictOK(t, led, content.EvictionRequest{Before: 9000, Max: 2})
	if res.Evicted != 2 {
		t.Fatalf("evicted %d under a cap of 2", res.Evicted)
	}
	// Capped short of the cutoff, the horizon is what was ACTUALLY removed
	// (2000), never the cutoff (9000) — the store is complete after 2000 and
	// claiming 9000 would assert coverage it does not have.
	if wm := watermarkOK(t, led); wm.Horizon == nil || *wm.Horizon != 2000 {
		t.Fatalf("Horizon = %v after a capped pass, want the last row actually removed, 2000", wm.Horizon)
	}
}

// An open entry is not a retention candidate whatever its age: it has no
// ended_at, so it has not finished, and evicting a running command would
// delete the row its own completion is about to write.
func TestEvictionLeavesOpenEntriesAlone(t *testing.T) {
	_, led := newLedger(t)
	envReady(t, led, "local")
	submitAt(t, led, entryID(1), "local", "/repo", content.EntryShell, "make watch")

	res := evictOK(t, led, content.EvictionRequest{Before: 1 << 40, Max: 100})
	if res.Evicted != 0 {
		t.Fatalf("evicted %d — an entry that never ended is not old, it is unfinished", res.Evicted)
	}
}

// ── pinned artifacts are exempt ──────────────────────────────────────────

// A pin exempts an entry from BACKGROUND eviction (schema question 4): a
// capsule whose content can be evicted underneath it is a broken promise.
// The pinned row stays, its unpinned neighbour goes, and the horizon reflects
// only what actually went.
func TestEvictionExemptsEntriesHoldingAPinnedArtifact(t *testing.T) {
	_, led := newLedger(t)
	ctx := context.Background()
	envReady(t, led, "local")

	// The PINNED entry is the older one — the row eviction would take first —
	// so the exemption is what changes the outcome rather than the order.
	pinned := entryID(1)
	submitAt(t, led, pinned, "local", "/repo", content.EntryShell, "capsule")
	execID, err := led.StartExecution(ctx, content.StartExecution{EntryID: pinned})
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	if _, err := led.AppendArtifact(ctx, content.AppendArtifact{
		ID: "00000000-0000-7000-8000-00000000a001", EntryID: pinned, ExecutionID: &execID,
		MediaType: content.MediaText, Pinned: true,
	}); err != nil {
		t.Fatalf("AppendArtifact: %v", err)
	}
	zero := 0
	payload := content.ShellPayloadJSON(&zero)
	if err := led.FinishExecution(ctx, execID, content.FinishExecution{
		EndedAt: 1000, TerminationReason: content.TermCompleted,
		Status: content.EntrySuccess, Payload: &payload,
	}); err != nil {
		t.Fatalf("FinishExecution: %v", err)
	}

	loose := entryID(2)
	submitAt(t, led, loose, "local", "/repo", content.EntryShell, "ordinary")
	closeEntryAt(t, led, loose, 2000)

	res := evictOK(t, led, content.EvictionRequest{Before: 9000, Max: 100})
	if res.Evicted != 1 {
		t.Fatalf("evicted %d, want only the unpinned entry", res.Evicted)
	}
	wantOnly(t, queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10}), pinned)

	// Only the unpinned row's instant is in the horizon.
	if wm := watermarkOK(t, led); wm.Horizon == nil || *wm.Horizon != 2000 {
		t.Fatalf("Horizon = %v, want the evicted row's 2000", wm.Horizon)
	}
}

// ── the wiring: retention actually runs in the product ───────────────────

// The happy path end to end, through the seam a user reaches: with an age
// limit set in Settings, recording a new command is what retires the ones
// retention no longer covers, and the store afterwards states the coverage it
// actually has.
//
// This is the test that would have caught the failure this epic already had
// once (nocx-rtg0, ContentDB.Add): a store whose write path is complete and
// correct and which nothing ever calls. Every other test here drives
// EvictEntries directly and would pass just as well with the production call
// site deleted.
func TestSubmittingACommandRunsRetention(t *testing.T) {
	policy := content.NewPolicy()
	dir := t.TempDir()
	db, err := content.Open(context.Background(), content.Config{
		Path: dir + "/content.db", Key: testKey(), Budget: testBudget, Policy: policy,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	led := db.Ledger()

	// Two commands that finished at the epoch — far outside any age limit.
	seedClosed(t, led, 1000, 2000)
	if wm := watermarkOK(t, led); wm.EvictedCount != 0 {
		t.Fatalf("EvictedCount = %d before retention was switched on", wm.EvictedCount)
	}

	// The user sets an age limit, then runs a command. The command is what
	// gives the store the moment to retire the old rows.
	policy.SetRetentionDays(1)
	submitAt(t, led, entryID(50), "local", "/repo", content.EntryShell, "new work")

	wantOnly(t, queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10}), entryID(50))
	wm := watermarkOK(t, led)
	if wm.EvictedCount != 2 {
		t.Fatalf("EvictedCount = %d after a submit under a 1-day limit, want the 2 ancient rows", wm.EvictedCount)
	}
	if wm.Horizon == nil || *wm.Horizon != 2000 {
		t.Fatalf("Horizon = %v, want 2000", wm.Horizon)
	}

	// And the store says so. The only surviving entry never ended, so
	// MIN(ended_at) is NULL: without the watermark this store would report
	// no horizon at all, having just discarded two days of history.
	cov := coverageOK(t, led)
	if cov == nil {
		t.Fatal("Coverage is nil after retention evicted two entries")
	}
	if *cov != 2000 {
		t.Fatalf("Coverage = %d, want the horizon 2000", *cov)
	}
}

// The mirror of it: with no age limit — the default — a submit evicts
// nothing, however old the store's rows are. Retention that ran when the user
// had not asked for it would be data loss, not housekeeping.
func TestSubmittingACommandEvictsNothingWithoutAnAgeLimit(t *testing.T) {
	_, led := newLedger(t)
	seedClosed(t, led, 1000, 2000)

	submitAt(t, led, entryID(50), "local", "/repo", content.EntryShell, "new work")

	if wm := watermarkOK(t, led); wm.EvictedCount != 0 {
		t.Fatalf("EvictedCount = %d with no retention limit set", wm.EvictedCount)
	}
	if cov := coverageOK(t, led); cov == nil || *cov != 1000 {
		t.Fatalf("Coverage = %v, want the untouched oldest row 1000", cov)
	}
}

// ── the request is refused rather than answered wrongly ──────────────────

func TestEvictionRefusesAnUnusableRequest(t *testing.T) {
	_, led := newLedger(t)
	ctx := context.Background()
	for _, c := range []struct {
		name string
		req  content.EvictionRequest
	}{
		{"a cap of zero", content.EvictionRequest{Before: 1000, Max: 0}},
		{"a negative cap", content.EvictionRequest{Before: 1000, Max: -1}},
		{"a negative cutoff", content.EvictionRequest{Before: -1, Max: 10}},
	} {
		if _, err := led.EvictEntries(ctx, c.req); err == nil {
			t.Fatalf("EvictEntries with %s was accepted", c.name)
		}
	}
}
