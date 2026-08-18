package content_test

// The failure paths of eviction (nocx-rtg0.12), one test per external call it
// makes — AGENTS.md testing rule 3: "for every external call your code makes,
// there is a test where that call fails".
//
// Each case forces the failure at a different statement and then asserts the
// SAME invariant from the other side: entries and the watermark move together
// or not at all. That is what makes these more than error-plumbing tests —
// a DELETE that committed while its watermark write failed would leave the
// store silently claiming coverage it lost, which is the exact defect the
// watermark exists to prevent.
//
// The faults are injected with SQLite triggers on a second connection to the
// same encrypted file (rawLedger). A trigger that RAISEs is a real statement
// failure at a real call site, deterministic and with no timing in it.

import (
	"context"
	"encoding/hex"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// storeState is what every case below compares before and after: how many
// entries survive and what the watermark says. The pair moving together is
// the invariant; either moving alone is the defect.
type storeState struct {
	entries int
	count   int64
	horizon *int64
}

func readState(t *testing.T, led content.LedgerRepository) storeState {
	t.Helper()
	page := queryOK(t, led, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 100})
	wm := watermarkOK(t, led)
	return storeState{entries: len(page.Entries), count: wm.EvictedCount, horizon: wm.Horizon}
}

func (s storeState) equal(o storeState) bool {
	if s.entries != o.entries || s.count != o.count {
		return false
	}
	switch {
	case s.horizon == nil && o.horizon == nil:
		return true
	case s.horizon == nil || o.horizon == nil:
		return false
	default:
		return *s.horizon == *o.horizon
	}
}

// The DELETE fails. Nothing may be removed and the watermark may not move:
// no watermark without its deletion.
func TestEvictionRollsBackWhenTheDeleteFails(t *testing.T) {
	_, led, path := newLedgerAt(t)
	seedClosed(t, led, 1000, 2000, 3000)
	before := readState(t, led)

	if err := rawLedger(t, path, hex.EncodeToString(testKey()),
		`CREATE TRIGGER evict_delete_boom BEFORE DELETE ON entries
		 BEGIN SELECT RAISE(ABORT, 'delete refused'); END`,
	); err != nil {
		t.Fatalf("install delete trigger: %v", err)
	}

	if _, err := led.EvictEntries(context.Background(),
		content.EvictionRequest{Before: 9000, Max: 100}); err == nil {
		t.Fatal("EvictEntries succeeded while the DELETE was refused")
	}

	after := readState(t, led)
	if !before.equal(after) {
		t.Fatalf("state moved on a failed DELETE: before %+v, after %+v", before, after)
	}
	if after.count != 0 || after.horizon != nil {
		t.Fatalf("watermark = (%d, %v) after a DELETE that never happened", after.count, after.horizon)
	}
}

// The watermark UPDATE fails. The rows it was about to account for must still
// be there: no deletion without its watermark. This is the direction that
// actually loses data if the two are not one transaction — the rows would be
// gone and nothing would record that they ever existed.
func TestEvictionRollsBackWhenTheWatermarkWriteFails(t *testing.T) {
	_, led, path := newLedgerAt(t)
	seedClosed(t, led, 1000, 2000, 3000)
	before := readState(t, led)
	if before.entries != 3 {
		t.Fatalf("fixture has %d entries, want 3", before.entries)
	}

	if err := rawLedger(t, path, hex.EncodeToString(testKey()),
		`CREATE TRIGGER evict_watermark_boom BEFORE UPDATE ON retention_watermark
		 BEGIN SELECT RAISE(ABORT, 'watermark refused'); END`,
	); err != nil {
		t.Fatalf("install watermark trigger: %v", err)
	}

	if _, err := led.EvictEntries(context.Background(),
		content.EvictionRequest{Before: 9000, Max: 100}); err == nil {
		t.Fatal("EvictEntries succeeded while the watermark write was refused")
	}

	after := readState(t, led)
	if after.entries != 3 {
		t.Fatalf("entries = %d after a failed watermark write — rows were deleted with nothing recording it", after.entries)
	}
	if !before.equal(after) {
		t.Fatalf("state moved on a failed watermark write: before %+v, after %+v", before, after)
	}
}

// The victim SELECT fails. Eviction reads the pin exemption through the
// artifacts table; without it there is no way to tell an exempt row from an
// ordinary one, so the pass must refuse rather than evict everything.
func TestEvictionFailsWhenTheVictimSelectFails(t *testing.T) {
	_, led, path := newLedgerAt(t)
	seedClosed(t, led, 1000, 2000)
	before := readState(t, led)

	if err := rawLedger(t, path, hex.EncodeToString(testKey()),
		`CREATE TRIGGER evict_select_boom BEFORE DELETE ON artifacts
		 BEGIN SELECT RAISE(ABORT, 'unused'); END`,
		`DROP TABLE artifact_chunks`,
		`DROP TABLE artifacts`,
	); err != nil {
		t.Fatalf("drop artifacts: %v", err)
	}

	if _, err := led.EvictEntries(context.Background(),
		content.EvictionRequest{Before: 9000, Max: 100}); err == nil {
		t.Fatal("EvictEntries succeeded while it could not read the pin exemption")
	}

	after := readState(t, led)
	if after.entries != before.entries {
		t.Fatalf("entries = %d after a failed victim select, want the %d it started with", after.entries, before.entries)
	}
	if after.count != 0 {
		t.Fatalf("EvictedCount = %d after a pass that never selected a victim", after.count)
	}
}

// The transaction cannot even begin: the store is closed. Eviction must
// report it rather than pretend a pass happened.
func TestEvictionFailsOnAClosedStore(t *testing.T) {
	db, led := newLedger(t)
	seedClosed(t, led, 1000, 2000)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := led.EvictEntries(context.Background(),
		content.EvictionRequest{Before: 9000, Max: 100}); err == nil {
		t.Fatal("EvictEntries succeeded on a closed store")
	}
}

// Reading the watermark is its own external call, and it fails the same way.
// A Watermark that swallowed the error would report a never-evicted store —
// count 0, no horizon — which is precisely the false "full coverage" answer.
func TestWatermarkReadFailsOnAClosedStore(t *testing.T) {
	db, led := newLedger(t)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := led.Watermark(context.Background()); err == nil {
		t.Fatal("Watermark succeeded on a closed store")
	}
}

// Coverage reads the watermark inside the query's transaction. When that read
// fails the whole query must fail: answering the page while silently dropping
// the horizon is the soft degrade AGENTS.md forbids — the overlay would say
// "searched everything" over a store that had been evicted.
func TestQueryFailsWhenTheWatermarkCannotBeRead(t *testing.T) {
	_, led, path := newLedgerAt(t)
	seedClosed(t, led, 1000, 2000)

	if err := rawLedger(t, path, hex.EncodeToString(testKey()),
		`DROP TABLE retention_watermark`,
	); err != nil {
		t.Fatalf("drop watermark: %v", err)
	}

	if _, err := led.QueryEntries(context.Background(),
		content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10}); err == nil {
		t.Fatal("QueryEntries answered with a coverage it could not read")
	}
}
