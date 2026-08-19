package content

// The transactional half of the container lifecycle (nocx-isoph.3, design
// .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §4.1, §4.4).
//
// "The container's row goes in the SAME TRANSACTION that removes its last
// member" is a claim about a failure that never happens on the happy path, so
// the only test that can report it is one that MAKES the transaction fail
// between its two writes. These tests do it deterministically, with a trigger
// that aborts the second statement: no sleep, no race, no kill signal whose
// landing point is a matter of luck. What is asserted afterwards is the
// interval, both ends — either both rows are gone or both are present, and a
// tab with no panes is unreachable in between.
//
// They live in the internal test package because installing the trigger needs
// a connection the seam does not expose, and because the same-row assertion
// reads the rowid, which is how "the SAME pane moved" is told apart from "a
// new pane with the same contents".

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// abortOn installs a trigger that fails every op (DELETE, INSERT) against
// table, and returns the function that removes it again. This is the "killed
// partway" harness: the first statement of the lifecycle transaction
// succeeds, a later one raises, and nothing may survive the rollback.
func abortOn(t *testing.T, s *sqliteContent, op, table string) func() {
	t.Helper()
	name := "abort_" + strings.ToLower(op) + "_" + table
	if _, err := s.db.ExecContext(context.Background(),
		`CREATE TRIGGER `+name+` BEFORE `+op+` ON `+table+
			` BEGIN SELECT RAISE(ABORT, 'killed mid-transaction'); END`); err != nil {
		t.Fatalf("install abort trigger on %s %s: %v", op, table, err)
	}
	return func() {
		if _, err := s.db.ExecContext(context.Background(), `DROP TRIGGER `+name); err != nil {
			t.Fatalf("drop abort trigger on %s %s: %v", op, table, err)
		}
	}
}

func lifecycleStore(t *testing.T) (ContentDB, *sqliteContent, LayoutRepository) {
	t.Helper()
	db, err := openTestStore(t, filepath.Join(t.TempDir(), "content.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("store is %T, want *sqliteContent", db)
	}
	return db, s, db.Layout()
}

func countRows(t *testing.T, s *sqliteContent, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func seedChainInternal(t *testing.T, layout LayoutRepository, wsID, tabID, paneID string) {
	t.Helper()
	if _, err := layout.CreateWorkspace(context.Background(),
		Workspace{ID: wsID, Name: wsID},
		Tab{ID: tabID, WorkspaceID: wsID, Layout: LayoutRow},
		Pane{ID: paneID, TabID: tabID, Cwd: "/srv", Kind: PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateWorkspace %s: %v", wsID, err)
	}
}

// The pane leaves and the tab leaves together, or neither does. With the
// tab's mark raising, the pane's — which had already succeeded inside the
// transaction — must be rolled back with it: a store that marked the pane in
// one transaction and the tab in another would leave a tab with no panes IN
// THE WINDOW, which is the state §4.1 says is unreachable.
//
// The trigger is on UPDATE rather than DELETE since nocx-l21ib.4, because
// that is now the statement the lifecycle issues; a trigger left on DELETE
// would fire on nothing and the test would report a rollback it never made.
func TestTheTabLeavesInTheSameTransactionAsItsLastPane(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	// A second workspace so the close is not also the application's last tab;
	// the replacement is a different rule and has its own test.
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	restore := abortOn(t, s, "UPDATE", "tabs")
	err := layout.DeletePane(ctx, "pane-1", Replacement{TabID: "tab-r", PaneID: "pane-r"})
	if err == nil {
		t.Fatal("DeletePane with the tab's mark raising: err = nil, want the failure reported")
	}
	// BOTH still in the window: the interval's other end.
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1' AND closed_at IS NULL`); n != 1 {
		t.Fatalf("open panes named pane-1 after the killed transaction = %d, want 1 — the pane's mark was not rolled back", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE id = 'tab-1' AND closed_at IS NULL`); n != 1 {
		t.Fatalf("open tabs named tab-1 after the killed transaction = %d, want 1", n)
	}
	// And never the forbidden middle: no open tab holds zero open panes.
	if n := countRows(t, s,
		`SELECT count(*) FROM tabs WHERE closed_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM panes WHERE panes.tab_id = tabs.id AND panes.closed_at IS NULL)`); n != 0 {
		t.Fatalf("open tabs with no open panes = %d, want 0 — a killed transaction left the state §4.1 calls unreachable", n)
	}

	// Both out of the window, once the transaction can complete — and both
	// rows still there, which is the half a delete could never have.
	restore()
	if err := layout.DeletePane(ctx, "pane-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1' AND closed_at IS NULL`); n != 0 {
		t.Fatalf("open panes named pane-1 = %d, want 0", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE id = 'tab-1' AND closed_at IS NULL`); n != 0 {
		t.Fatalf("open tabs named tab-1 = %d, want 0 — the tab leaves with its last pane", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1'`); n != 1 {
		t.Fatalf("rows for pane-1 = %d, want 1 — the pane's row is the block's anchor and is never deleted", n)
	}
}

// The same property one rung up: the workspace's row goes in the transaction
// that removes its last tab, and a failure there takes the tab's removal back
// with it. A workspace with no tabs is as unreachable as a tab with no panes.
func TestTheWorkspaceGoesInTheSameTransactionAsItsLastTab(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	restore := abortOn(t, s, "DELETE", "workspaces")
	err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"})
	if err == nil {
		t.Fatal("DeleteTab with the workspace's delete raising: err = nil, want the failure reported")
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE id = 'tab-1'`); n != 1 {
		t.Fatalf("tabs named tab-1 after the killed transaction = %d, want 1 — the tab's delete was not rolled back", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 1 {
		t.Fatalf("workspaces named ws-1 after the killed transaction = %d, want 1", n)
	}
	if n := countRows(t, s,
		`SELECT count(*) FROM workspaces WHERE id != ? AND NOT EXISTS (SELECT 1 FROM tabs WHERE tabs.workspace_id = workspaces.id)`,
		DefaultWorkspaceID); n != 0 {
		t.Fatalf("workspaces with no tabs = %d, want 0", n)
	}

	restore()
	if err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err != nil {
		t.Fatalf("DeleteTab: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 0 {
		t.Fatalf("workspaces named ws-1 = %d, want 0 — the workspace goes with its last tab", n)
	}
}

// The replacement is minted in the SAME transaction as well: if it cannot be
// written, nothing was closed. Otherwise a failure there is exactly the state
// the rule forbids — an application with no tab at all.
func TestTheReplacementIsMintedInTheSameTransactionAsTheClose(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")

	// The replacement's pane cannot be written — its insert raises — after
	// the close has already deleted three rows. (An id "already taken" would
	// not do it: the close freed tab-1 and pane-1 earlier in the same
	// transaction, so the replacement may legally reuse them.)
	restore := abortOn(t, s, "INSERT", "panes")
	defer restore()
	err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"})
	if err == nil {
		t.Fatal("close whose replacement cannot be written: err = nil, want the failure reported")
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs`); n != 1 {
		t.Fatalf("tabs = %d, want the original one — the close was not rolled back", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1'`); n != 1 {
		t.Fatalf("panes named pane-1 = %d, want 1", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 1 {
		t.Fatalf("workspaces named ws-1 = %d, want 1", n)
	}
}

// "A new pane with the same contents" is the failure the whole model exists
// to prevent, and an assertion on the pane's FIELDS cannot see it: a delete
// and a re-insert reproduce every one of them. The rowid can — SQLite gives a
// re-inserted row a new one — so this is what says the move was an UPDATE of
// one column on the row that was already there.
func TestMovingAPaneKeepsTheSameRowNotAnEqualOne(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	if _, err := layout.CreateTab(ctx,
		Tab{ID: "tab-2", WorkspaceID: "ws-1", Layout: LayoutRow},
		Pane{ID: "pane-2", TabID: "tab-2", Cwd: "/var", Kind: PaneLocal, SizeShare: 1}); err != nil {
		t.Fatalf("CreateTab: %v", err)
	}

	rowidOf := func(id string) int64 {
		t.Helper()
		var rowid int64
		if err := s.db.QueryRowContext(ctx, `SELECT rowid FROM panes WHERE id = ?`, id).Scan(&rowid); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				t.Fatalf("pane %s has no row", id)
			}
			t.Fatalf("rowid of %s: %v", id, err)
		}
		return rowid
	}

	before := rowidOf("pane-1")
	if _, err := layout.MovePane(ctx, "pane-1", "tab-2"); err != nil {
		t.Fatalf("MovePane: %v", err)
	}
	if after := rowidOf("pane-1"); after != before {
		t.Fatalf("pane rowid %d → %d: the pane was re-created, not moved — its blocks, its history and its live pipe hang off the row that was there before",
			before, after)
	}
}
