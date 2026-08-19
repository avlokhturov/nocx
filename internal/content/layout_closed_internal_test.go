package content

// The row-level half of "marked closed, never deleted" (nocx-l21ib.4). These
// assertions cannot be made through the seam at all: every window read
// filters closed_at IS NULL, so the seam's answer to "is the row still there"
// is the same as its answer to "was it deleted" — which is the confusion the
// bead exists to end. Raw SQL is the only reader that can tell them apart.
//
// It also holds the transactional half for the new write paths, the same way
// layout_lifecycle_internal_test.go holds it for the old ones: a close now
// touches two tables (the pane's mark and the tab's), and "both or neither"
// is a claim about a failure the happy path never reaches.

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// closedAt reads the mark itself: NULL means the row is in the window.
func closedAt(t *testing.T, s *sqliteContent, table, id string) sql.NullInt64 {
	t.Helper()
	var at sql.NullInt64
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT closed_at FROM `+table+` WHERE id = ?`, id).Scan(&at); err != nil {
		t.Fatalf("closed_at of %s %s: %v", table, id, err)
	}
	return at
}

// A closed tab keeps its row AND its panes keep theirs. The panes matter as
// much as the tab: panes.tab_id is ON DELETE CASCADE, so a tab that was
// deleted took them with it, and entries.pane_id went null behind that.
func TestClosingATabMarksItAndItsPanesRatherThanDeletingThem(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	if err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err != nil {
		t.Fatalf("DeleteTab: %v", err)
	}

	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE id = 'tab-1'`); n != 1 {
		t.Fatalf("rows for the closed tab = %d, want 1 — it was deleted, not marked", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1'`); n != 1 {
		t.Fatalf("rows for the closed tab's pane = %d, want 1", n)
	}
	if at := closedAt(t, s, "tabs", "tab-1"); !at.Valid {
		t.Fatal("closed tab's closed_at is NULL — the row is still in the window set")
	}
	if at := closedAt(t, s, "panes", "pane-1"); !at.Valid {
		t.Fatal("closed tab's pane has a NULL closed_at — a pane may not outlive its tab in the window")
	}
	// And the tab that stayed is untouched: the mark is not a sweep.
	if at := closedAt(t, s, "tabs", "tab-2"); at.Valid {
		t.Fatalf("open tab-2 closed_at = %v, want NULL", at)
	}
}

// The workspace is the ONE row that is still deleted, and its closed tabs
// outlive it. That is what tabs.workspace_id being nullable with ON DELETE
// SET NULL buys: the cascade would otherwise take the closed tabs and then
// their panes, which is exactly what the marking exists to prevent.
func TestAWorkspaceIsDeletedAndItsClosedTabsOutliveItWithNoWorkspace(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	// Its last open tab leaves, so the workspace goes with it.
	if err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err != nil {
		t.Fatalf("DeleteTab: %v", err)
	}

	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 0 {
		t.Fatalf("workspaces named ws-1 = %d, want 0 — a workspace is still deleted", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE id = 'tab-1' AND workspace_id IS NULL`); n != 1 {
		t.Fatalf("closed tabs left with no workspace = %d, want 1 — the cascade took the tab with its workspace", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE id = 'pane-1'`); n != 1 {
		t.Fatalf("panes of the orphaned closed tab = %d, want 1", n)
	}
}

// Closing the WORKSPACE itself, rather than its last tab, is the same fact
// from the other end: the tabs it held are marked before the row goes, so
// nothing is deleted through the foreign key.
func TestClosingAWorkspaceMarksItsTabsAndPanesBeforeItsRowGoes(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	if err := layout.DeleteWorkspace(ctx, "ws-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err != nil {
		t.Fatalf("DeleteWorkspace: %v", err)
	}

	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 0 {
		t.Fatalf("workspaces named ws-1 = %d, want 0", n)
	}
	if at := closedAt(t, s, "tabs", "tab-1"); !at.Valid {
		t.Fatal("the closed workspace's tab has a NULL closed_at — it is still in the window set")
	}
	if at := closedAt(t, s, "panes", "pane-1"); !at.Valid {
		t.Fatal("the closed workspace's pane has a NULL closed_at")
	}
}

// The invariant, stated as the schema states it: an OPEN tab is always in a
// workspace; a CLOSED tab may have outlived its own. A store that only
// promised it in Go would let any later writer break it silently.
func TestAnOpenTabAlwaysHasAWorkspace(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")

	_, err := s.db.ExecContext(context.Background(),
		`UPDATE tabs SET workspace_id = NULL WHERE id = 'tab-1'`)
	if err == nil {
		t.Fatal("an open tab was orphaned from its workspace: want the CHECK to refuse it")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "constraint") {
		t.Fatalf("orphaning an open tab failed with %v, want a constraint failure", err)
	}
}

// The clean start's sweep, at the row level: every open row is marked, the
// workspaces left holding no open tab go the way any emptied workspace goes,
// and the DEFAULT keeps the exemption it has everywhere else — the
// replacement tab goes there and the ledger records against it.
func TestClearWindowMarksEveryOpenRowAndKeepsTheDefaultWorkspace(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")
	if err := ensureDefaultWorkspace(ctx, s.db); err != nil {
		t.Fatalf("ensureDefaultWorkspace: %v", err)
	}

	if err := layout.ClearWindow(ctx); err != nil {
		t.Fatalf("ClearWindow: %v", err)
	}

	if n := countRows(t, s, `SELECT count(*) FROM tabs WHERE closed_at IS NULL`); n != 0 {
		t.Fatalf("open tabs after the sweep = %d, want 0", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE closed_at IS NULL`); n != 0 {
		t.Fatalf("open panes after the sweep = %d, want 0", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM tabs`); n != 2 {
		t.Fatalf("tab rows after the sweep = %d, want both kept", n)
	}
	if n := countRows(t, s,
		`SELECT count(*) FROM workspaces WHERE id != ?`, DefaultWorkspaceID); n != 0 {
		t.Fatalf("user workspaces after the sweep = %d, want 0 — a workspace holding no open tab is deleted", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = ?`, DefaultWorkspaceID); n != 1 {
		t.Fatalf("the default workspace after the sweep = %d rows, want 1 — it is never deleted", n)
	}
}

// A sweep that half-applied would be the defect it exists to fix, one launch
// later: the leftovers it did not reach come back on the next start with
// restore on. With the tabs' mark raising, the panes' mark — already written
// inside the transaction — must be rolled back with it.
func TestTheSweepMarksEveryRowInOneTransactionOrNone(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")

	restore := abortOn(t, s, "UPDATE", "tabs")
	if err := layout.ClearWindow(ctx); err == nil {
		t.Fatal("ClearWindow with the tabs' mark raising: err = nil, want the failure reported")
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE closed_at IS NULL`); n != 1 {
		t.Fatalf("open panes after the killed sweep = %d, want 1 — the pane's mark was not rolled back", n)
	}
	restore()
	if err := layout.ClearWindow(ctx); err != nil {
		t.Fatalf("ClearWindow: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM panes WHERE closed_at IS NULL`); n != 0 {
		t.Fatalf("open panes after the sweep = %d, want 0", n)
	}
}

// The same interval on the ordinary close, which now marks two tables where
// it used to delete one and let the cascade take the other: the tab's mark
// and its panes' mark are one act.
func TestATabAndItsPanesAreMarkedInTheSameTransaction(t *testing.T) {
	_, s, layout := lifecycleStore(t)
	ctx := context.Background()
	seedChainInternal(t, layout, "ws-1", "tab-1", "pane-1")
	seedChainInternal(t, layout, "ws-2", "tab-2", "pane-2")

	restore := abortOn(t, s, "UPDATE", "panes")
	defer restore()
	if err := layout.DeleteTab(ctx, "tab-1", Replacement{TabID: "tab-r", PaneID: "pane-r"}); err == nil {
		t.Fatal("DeleteTab with the panes' mark raising: err = nil, want the failure reported")
	}
	if at := closedAt(t, s, "tabs", "tab-1"); at.Valid {
		t.Fatal("the tab is marked closed while its pane is not — the two marks are not one transaction")
	}
	if n := countRows(t, s, `SELECT count(*) FROM workspaces WHERE id = 'ws-1'`); n != 1 {
		t.Fatalf("workspaces named ws-1 = %d, want 1 — the workspace's delete was not rolled back", n)
	}
}
