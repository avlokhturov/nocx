package content

// Killing the process mid-eviction (nocx-rtg0.12).
//
// The invariant under test has both halves in one sentence: no watermark
// without its deletion, and no deletion without its watermark. Across a
// SIGKILL that lands at an arbitrary instant, the accounting must still
// close — every entry the store ever held is either still there or counted in
// the watermark, and never both or neither.
//
// It reuses the cross-process technique already in this package
// (TestContentDBChild / TestTwoProcessesShareDatabase): the test binary
// re-execs itself with a role in the environment and the parent SIGKILLs it.
// SIGKILL is the point — no deferred Close, no rollback the process gets to
// perform, only what SQLite's own crash recovery restores from the WAL.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// crashSeedEntries is how many closed entries the parent plants before the
// evictor starts. It is the total the accounting must add up to.
//
// It is deliberately far larger than any kill delay below can drain. A first
// draft planted 40, and two of the three cases evicted all 40 before the
// signal arrived: the accounting then balanced as 40 + 0, which is exactly
// what an untorn store looks like and proves nothing about a torn one. The
// backlog has to outlive the kill for the test to be able to fail.
const crashSeedEntries = 400

// childEvictor evicts one entry per pass, forever, until it is killed. One
// row per pass keeps the transactions short and numerous, which is what makes
// a kill likely to land inside one rather than between two.
func childEvictor(t *testing.T) {
	db, err := openTestStore(t, os.Getenv("NOCX_CONTENT_PATH"))
	if err != nil {
		os.Exit(3)
	}
	defer func() { _ = db.Close() }()
	ctx := context.Background()
	led := db.Ledger()
	for {
		if _, err := led.EvictEntries(ctx, EvictionRequest{Before: 1 << 40, Max: 1}); err != nil {
			os.Exit(6)
		}
		time.Sleep(time.Millisecond)
	}
}

// seedClosedEntries plants n entries that have all completed, so every one of
// them is a retention candidate.
func seedClosedEntries(t *testing.T, db ContentDB, n int) {
	t.Helper()
	ctx := context.Background()
	led := db.Ledger()
	if err := led.EnsureEnvironment(ctx, Environment{ID: "local", Kind: EnvLocal}); err != nil {
		t.Fatalf("EnsureEnvironment: %v", err)
	}
	if _, err := led.RecordObservation(ctx, Observation{
		EnvironmentID: "local", Criticality: CriticalityRoutine, Payload: "{}",
	}); err != nil {
		t.Fatalf("RecordObservation: %v", err)
	}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("00000000-0000-7000-8000-%012d", i+1)
		if _, err := led.Submit(ctx, SubmitEntry{
			ID: id, Client: "crash-test", EnvironmentID: "local", Cwd: "/repo",
			Kind: EntryShell, Intent: fmt.Sprintf("cmd-%d", i+1), Payload: "{}",
		}); err != nil {
			t.Fatalf("Submit %d: %v", i, err)
		}
		execID, err := led.StartExecution(ctx, StartExecution{EntryID: id})
		if err != nil {
			t.Fatalf("StartExecution %d: %v", i, err)
		}
		zero := 0
		payload := ShellPayloadJSON(&zero)
		if err := led.FinishExecution(ctx, execID, FinishExecution{
			EndedAt:           int64(1000 + i),
			TerminationReason: TermCompleted,
			Status:            EntrySuccess,
			Payload:           &payload,
		}); err != nil {
			t.Fatalf("FinishExecution %d: %v", i, err)
		}
	}
}

// A SIGKILL at an arbitrary instant during eviction leaves the store's
// accounting intact: evicted + surviving is exactly what was planted. A
// deletion that committed without its watermark would make the sum come up
// short; a watermark that committed without its deletion would make it come
// up long.
//
// Three kills at different delays, each on its own database, because a single
// fixed delay tests a single instant in the pass and the interesting instants
// are the ones inside a transaction.
func TestEvictionAccountingSurvivesAKill(t *testing.T) {
	for _, delay := range []time.Duration{30 * time.Millisecond, 60 * time.Millisecond, 120 * time.Millisecond} {
		t.Run(delay.String(), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "content.db")

			seed, err := openTestStore(t, path)
			if err != nil {
				t.Fatalf("Open for seeding: %v", err)
			}
			seedClosedEntries(t, seed, crashSeedEntries)
			if closeErr := seed.Close(); closeErr != nil {
				t.Fatalf("close after seeding: %v", closeErr)
			}

			cmd := newChild(t, "evictor", path)
			time.Sleep(delay)
			if killErr := cmd.Process.Signal(syscall.SIGKILL); killErr != nil {
				t.Fatalf("kill evictor: %v", killErr)
			}
			_, _ = cmd.Process.Wait()

			// Reopen and close the books.
			db, err := openTestStore(t, path)
			if err != nil {
				t.Fatalf("reopen after kill: %v", err)
			}
			defer func() { _ = db.Close() }()

			conn := openKeyedConn(t, path)
			var integrity string
			if intErr := conn.QueryRow("PRAGMA integrity_check").Scan(&integrity); intErr != nil {
				t.Fatalf("integrity_check: %v", intErr)
			}
			if integrity != "ok" {
				t.Fatalf("integrity_check = %q, want ok", integrity)
			}

			var surviving int
			if countErr := conn.QueryRow("SELECT count(*) FROM entries").Scan(&surviving); countErr != nil {
				t.Fatalf("count entries: %v", countErr)
			}
			wm, err := db.Ledger().Watermark(context.Background())
			if err != nil {
				t.Fatalf("Watermark after kill: %v", err)
			}

			// The kill must land with work both done and outstanding,
			// otherwise the accounting below balances trivially: a child that
			// died before its first pass leaves 0 + 40, which proves nothing
			// about a half-finished transaction.
			t.Logf("kill at %s: evicted %d, surviving %d", delay, wm.EvictedCount, surviving)
			if wm.EvictedCount == 0 {
				t.Fatal("the child evicted nothing before the kill — this case cannot see a torn eviction")
			}
			if surviving == 0 {
				t.Fatal("the child finished the whole backlog before the kill — the pass was not interrupted")
			}

			if got := int(wm.EvictedCount) + surviving; got != crashSeedEntries {
				t.Fatalf("evicted %d + surviving %d = %d, want the %d planted — "+
					"a deletion and its watermark did not commit together",
					wm.EvictedCount, surviving, got, crashSeedEntries)
			}
			// And the horizon agrees with the count: something was evicted iff
			// there is a horizon to state.
			if wm.EvictedCount > 0 && wm.Horizon == nil {
				t.Fatalf("EvictedCount = %d with no horizon — the count and the horizon are one write", wm.EvictedCount)
			}
			if wm.EvictedCount == 0 && wm.Horizon != nil {
				t.Fatalf("Horizon = %d with nothing evicted", *wm.Horizon)
			}
		})
	}
}
