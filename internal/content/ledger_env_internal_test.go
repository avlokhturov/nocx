package content

// The N+1 property of the environment read (nocx-rtg0.25), asserted by
// COUNTING the statements the store executes rather than by reading the SQL
// and believing it. nocx-rtg0.20 builds ledger.query on this method, so a
// per-row environment lookup added here would be a page of history costing
// one query per row — and a join bolted on afterwards is a rewrite of that
// query rather than a fix to it.
//
// Internal, because the count is taken from the store's own pool: the pool
// is pinned to ONE connection and a SQLITE_TRACE_STMT callback is installed
// on it, so every statement ListEntries runs is recorded, whichever code
// path ran it.

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
)

func TestListEntriesResolvesEveryHostInOneStatement(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "content.db")
	db, openErr := openTestStore(t, path)
	if openErr != nil {
		t.Fatalf("Open: %v", openErr)
	}
	defer func() { _ = db.Close() }()
	led := db.Ledger()

	// N entries in N DISTINCT environments: one shared environment would
	// let a per-row lookup pass on a cache it does not have.
	const n = 5
	for i := range n {
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

	s, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("store is %T, not the sqlite backing", db)
	}
	// One connection in the pool, and it is the one being traced: the read
	// below cannot run a statement anywhere else.
	s.db.SetMaxOpenConns(1)
	pinned, pinErr := s.db.Conn(ctx)
	if pinErr != nil {
		t.Fatalf("pin a connection: %v", pinErr)
	}
	var stmts []string
	if err := pinned.Raw(func(dc any) error {
		raw, ok := dc.(driver.Conn)
		if !ok {
			return fmt.Errorf("driver connection is %T", dc)
		}
		return raw.Raw().Trace(sqlite3.TRACE_STMT, func(_ sqlite3.TraceEvent, _, arg2 any) error {
			if sql, ok := arg2.(string); ok {
				stmts = append(stmts, sql)
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
	if len(stmts) != 1 {
		t.Fatalf("ListEntries ran %d statements for %d rows, want exactly 1: %q", len(stmts), n, stmts)
	}
}
