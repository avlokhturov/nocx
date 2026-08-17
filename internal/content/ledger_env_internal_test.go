package content

// The N+1 property of the environment read (nocx-rtg0.25) and of the recall
// query built on it (nocx-rtg0.20), asserted by COUNTING the statements the
// store executes rather than by reading the SQL and believing it. A per-row
// environment lookup would make a page of history cost one query per row —
// and a join bolted on afterwards is a rewrite of that query rather than a
// fix to it.
//
// Internal, because the count is taken from the store's own pool: the pool
// is pinned to ONE connection and a SQLITE_TRACE_STMT callback is installed
// on it, so every statement the read runs is recorded, whichever code path
// ran it.

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
)

// stmtTrace collects the statements the traced connection runs. The mutex is
// not decoration: the trace callback runs on whatever goroutine the driver
// is on, and -race is part of the gate.
type stmtTrace struct {
	mu    sync.Mutex
	stmts []string
}

func (tr *stmtTrace) record(sql string) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.stmts = append(tr.stmts, sql)
}

// take returns what has been recorded and clears it, so one traced store can
// measure several reads.
func (tr *stmtTrace) take() []string {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	out := tr.stmts
	tr.stmts = nil
	return out
}

// traceStatements pins the pool to one connection and installs a statement
// trace on it. Everything the store runs afterwards is counted.
func traceStatements(t *testing.T, s *sqliteContent) *stmtTrace {
	t.Helper()
	ctx := context.Background()
	// One connection in the pool, and it is the one being traced: the reads
	// below cannot run a statement anywhere else.
	s.db.SetMaxOpenConns(1)
	pinned, pinErr := s.db.Conn(ctx)
	if pinErr != nil {
		t.Fatalf("pin a connection: %v", pinErr)
	}
	tr := &stmtTrace{}
	if err := pinned.Raw(func(dc any) error {
		raw, ok := dc.(driver.Conn)
		if !ok {
			return fmt.Errorf("driver connection is %T", dc)
		}
		return raw.Raw().Trace(sqlite3.TRACE_STMT, func(_ sqlite3.TraceEvent, _, arg2 any) error {
			if sql, ok := arg2.(string); ok {
				tr.record(sql)
			}
			return nil
		})
	}); err != nil {
		t.Fatalf("install the statement trace: %v", err)
	}
	// Back to the pool with its trace still installed — the next query takes
	// this same connection, because it is the only one.
	if err := pinned.Close(); err != nil {
		t.Fatalf("release the pinned connection: %v", err)
	}
	return tr
}

// seedDistinctEnvironments records n entries in n DISTINCT environments: one
// shared environment would let a per-row lookup pass on a cache it does not
// have. from is the first entry's index, so a store can be grown between two
// measurements.
func seedDistinctEnvironments(t *testing.T, led LedgerRepository, from, n int) {
	t.Helper()
	ctx := context.Background()
	for i := from; i < from+n; i++ {
		host := fmt.Sprintf("host-%d.example.com", i)
		envID := EnvironmentIDFor(EnvSSH, host)
		if err := led.EnsureEnvironment(ctx, Environment{
			ID: envID, Kind: EnvSSH, Endpoint: &host,
		}); err != nil {
			t.Fatalf("EnsureEnvironment %d: %v", i, err)
		}
		if _, err := led.Submit(ctx, SubmitEntry{
			ID:            fmt.Sprintf("00000000-0000-7000-8000-%012d", i),
			Client:        "c",
			EnvironmentID: envID, Cwd: "/repo", Kind: EntryShell,
			Intent: fmt.Sprintf("command %d", i),
		}); err != nil {
			t.Fatalf("Submit %d: %v", i, err)
		}
	}
}

func TestListEntriesResolvesEveryHostInOneStatement(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "content.db")
	db, openErr := openTestStore(t, path)
	if openErr != nil {
		t.Fatalf("Open: %v", openErr)
	}
	defer func() { _ = db.Close() }()
	led := db.Ledger()

	const n = 5
	seedDistinctEnvironments(t, led, 0, n)

	s, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("store is %T, not the sqlite backing", db)
	}
	tr := traceStatements(t, s)

	rows, listErr := led.ListEntries(ctx, 100)
	if listErr != nil {
		t.Fatalf("ListEntries: %v", listErr)
	}
	if len(rows) != n {
		t.Fatalf("ListEntries = %d rows, want %d", len(rows), n)
	}
	for _, row := range rows {
		if row.Environment == nil || row.Environment.Host() == "" {
			t.Fatalf("row %q resolved no host: %+v", row.ID, row.Environment)
		}
	}
	if stmts := tr.take(); len(stmts) != 1 {
		t.Fatalf("ListEntries ran %d statements for %d rows, want exactly 1: %q", len(stmts), n, stmts)
	}
}

// The recall query costs the same whatever the page holds. It runs more than
// one statement — the page, whether the ledger holds any row at all, and the
// retention horizon, all inside one read transaction — and that is the
// point: the number is a property of the ANSWER, never of the number of rows
// or of the number of hosts in it. Measuring one row against five in five
// distinct environments is what an N+1 cannot survive.
func TestQueryEntriesCostsTheSameStatementsWhateverThePageHolds(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "content.db")
	db, openErr := openTestStore(t, path)
	if openErr != nil {
		t.Fatalf("Open: %v", openErr)
	}
	defer func() { _ = db.Close() }()
	led := db.Ledger()

	seedDistinctEnvironments(t, led, 0, 1)
	s, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("store is %T, not the sqlite backing", db)
	}
	tr := traceStatements(t, s)

	q := LedgerQuery{Scope: ScopeEverywhere, Limit: 100}
	one, err := led.QueryEntries(ctx, q)
	if err != nil {
		t.Fatalf("QueryEntries with one row: %v", err)
	}
	if len(one.Entries) != 1 {
		t.Fatalf("QueryEntries = %d rows, want 1", len(one.Entries))
	}
	forOne := tr.take()

	seedDistinctEnvironments(t, led, 1, 4)
	tr.take() // the writes are not what is being measured
	many, err := led.QueryEntries(ctx, q)
	if err != nil {
		t.Fatalf("QueryEntries with five rows: %v", err)
	}
	if len(many.Entries) != 5 {
		t.Fatalf("QueryEntries = %d rows, want 5", len(many.Entries))
	}
	for _, row := range many.Entries {
		if row.Environment == nil || row.Environment.Host() == "" {
			t.Fatalf("row %q resolved no host: %+v", row.ID, row.Environment)
		}
	}
	forMany := tr.take()

	if len(forOne) != len(forMany) {
		t.Fatalf("QueryEntries ran %d statements for 1 row and %d for 5 — the cost follows the rows:\none: %q\nmany: %q",
			len(forOne), len(forMany), forOne, forMany)
	}
}
