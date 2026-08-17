package content_test

// Snapshot — the layout chain's READ (nocx-isoph.4, design §4.1). Twelve
// write methods shipped with nocx-isoph.2 and no way to read any of them
// back, which is why the epic's own sentence — "order, activation and
// decoration come from the backend" — could not be true: a renderer that
// cannot read the layout has to remember it, and a fact the renderer
// remembers is a fact the renderer owns.
//
// The tests below are about the whole picture rather than about one row:
// that every rung comes back, that the ORDER is the stored one and not the
// insertion one, that an empty store answers an empty snapshot rather than
// an error, and that the default workspace is named by the store rather than
// spelled out again by whoever reads it.

import (
	"context"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/workspace"
)

// The chain a renderer builds, read back whole. Written through the public
// seam, read through the file after a REOPEN would be stronger still — but
// that is TestLayoutStoresAndReadsBackEveryField's job; what this asserts is
// that one call answers with all three rungs and their edges.
func TestLayoutSnapshotAnswersTheWholeChain(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()

	if _, err := layout.CreateWorkspace(ctx,
		content.Workspace{ID: "ws-1", Name: "release", Position: 0},
		content.Tab{ID: "tab-1", Position: 0, Layout: content.LayoutRow},
		content.Pane{ID: "pane-1", Cwd: "/repos/nocx", Kind: content.PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := layout.CreateTab(ctx, content.Tab{
		ID: "tab-2", WorkspaceID: "ws-1", Name: str("deploy"), Colour: str("#ff8800"),
		Position: 1, Pinned: true, Layout: content.LayoutColumn,
	}, content.Pane{ID: "pane-2", Cwd: "/srv", Kind: content.PaneLocal, SizeShare: 1}); err != nil {
		t.Fatalf("CreateTab: %v", err)
	}
	if _, err := layout.CreatePane(ctx, content.Pane{
		ID: "pane-3", TabID: "tab-2", Cwd: "/var", Kind: content.PaneLocal, SizeShare: 0.5,
	}); err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	snap, err := layout.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Workspaces) != 1 || snap.Workspaces[0].ID != "ws-1" {
		t.Fatalf("workspaces = %+v, want exactly ws-1", snap.Workspaces)
	}
	if len(snap.Tabs) != 2 || snap.Tabs[0].ID != "tab-1" || snap.Tabs[1].ID != "tab-2" {
		t.Fatalf("tabs = %+v, want tab-1 then tab-2", snap.Tabs)
	}
	// The DECORATION is what the epic's headline is about: a reloaded
	// renderer finds the colour, the name and the pinning because they were
	// never in the renderer.
	deploy := snap.Tabs[1]
	if deploy.Name == nil || *deploy.Name != "deploy" || deploy.Colour == nil || *deploy.Colour != "#ff8800" || !deploy.Pinned {
		t.Fatalf("tab-2 read back as %+v, want name=deploy colour=#ff8800 pinned", deploy)
	}
	if len(snap.Panes) != 3 {
		t.Fatalf("panes = %+v, want three", snap.Panes)
	}
	// Every pane names the tab it is in — the strip cannot be drawn from the
	// tabs alone, because a tab is labelled by its panes (§4.5).
	inTab := map[string]int{}
	for _, p := range snap.Panes {
		inTab[p.TabID]++
	}
	if inTab["tab-1"] != 1 || inTab["tab-2"] != 2 {
		t.Fatalf("panes per tab = %v, want one in tab-1 and two in tab-2", inTab)
	}
}

// The order is the STORED one, not the insertion one. A snapshot that
// answered in insertion order would pass every test above and lose a reorder
// on the next read, which is exactly the fact this method exists to carry.
func TestLayoutSnapshotAnswersInStoredOrder(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()

	if _, err := layout.CreateWorkspace(ctx,
		content.Workspace{ID: "ws-1", Name: "one", Position: 0},
		content.Tab{ID: "tab-1", Position: 0, Layout: content.LayoutRow},
		content.Pane{ID: "pane-1", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := layout.CreateWorkspace(ctx,
		content.Workspace{ID: "ws-2", Name: "two", Position: 1},
		content.Tab{ID: "tab-2", Position: 0, Layout: content.LayoutRow},
		content.Pane{ID: "pane-2", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := layout.CreateTab(ctx,
		content.Tab{ID: "tab-3", WorkspaceID: "ws-1", Position: 1, Layout: content.LayoutRow},
		content.Pane{ID: "pane-3", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateTab: %v", err)
	}
	if _, err := layout.ReorderTabs(ctx, "ws-1", []string{"tab-3", "tab-1"}); err != nil {
		t.Fatalf("ReorderTabs: %v", err)
	}
	if _, err := layout.ReorderWorkspaces(ctx, []string{"ws-2", "ws-1"}); err != nil {
		t.Fatalf("ReorderWorkspaces: %v", err)
	}

	snap, err := layout.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if got := []string{snap.Workspaces[0].ID, snap.Workspaces[1].ID}; got[0] != "ws-2" || got[1] != "ws-1" {
		t.Fatalf("workspaces in %v, want the reordered ws-2 then ws-1", got)
	}
	// Tabs come back grouped by their workspace, each strip in its own
	// order: ws-2's tab first because ws-2 is now first.
	var ids []string
	for _, tab := range snap.Tabs {
		ids = append(ids, tab.ID)
	}
	want := []string{"tab-2", "tab-3", "tab-1"}
	if !equalStrings(ids, want) {
		t.Fatalf("tabs in %v, want %v", ids, want)
	}
}

// An empty store is a real state — a fresh profile has one — and it answers
// with empty collections rather than an error or a nil the wire would send
// as null.
func TestLayoutSnapshotOfAnEmptyStoreIsEmptyAndNotNil(t *testing.T) {
	_, layout := newLayout(t)
	snap, err := layout.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.Workspaces == nil || snap.Tabs == nil || snap.Panes == nil {
		t.Fatalf("Snapshot answered nil collections: %+v", snap)
	}
	if len(snap.Workspaces)+len(snap.Tabs)+len(snap.Panes) != 0 {
		t.Fatalf("Snapshot of an empty store = %+v, want nothing", snap)
	}
	if snap.DefaultWorkspaceID != string(workspace.Default) {
		t.Fatalf("DefaultWorkspaceID = %q, want %q", snap.DefaultWorkspaceID, workspace.Default)
	}
}

// A tab may be created in the DEFAULT workspace on a store that has never
// seen one. Nothing creates that row eagerly — the ledger's fallback and the
// replacement mint it when they need it — so a renderer with nowhere else to
// put its first tab would otherwise be refused with ErrNoSuchWorkspace and
// have no way to fix it: the id is the backend's, and workspaces.create
// refuses anything that is not a UUIDv7.
func TestLayoutCreateTabInTheDefaultWorkspaceMintsItsRow(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()

	if _, err := layout.CreateTab(ctx,
		content.Tab{ID: "tab-1", WorkspaceID: content.DefaultWorkspaceID, Position: 0, Layout: content.LayoutRow},
		content.Pane{ID: "pane-1", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateTab into the default workspace: %v", err)
	}
	snap, err := layout.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Workspaces) != 1 || snap.Workspaces[0].ID != content.DefaultWorkspaceID {
		t.Fatalf("workspaces = %+v, want the default", snap.Workspaces)
	}
	if len(snap.Tabs) != 1 || snap.Tabs[0].WorkspaceID != content.DefaultWorkspaceID {
		t.Fatalf("tabs = %+v, want one in the default workspace", snap.Tabs)
	}
	// And a workspace that is NOT the default is still refused: the exemption
	// is for the one id the backend owns, never for any id a caller invents.
	if _, err := layout.CreateTab(ctx,
		content.Tab{ID: "tab-2", WorkspaceID: "ws-nobody-made", Position: 0, Layout: content.LayoutRow},
		content.Pane{ID: "pane-2", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1},
	); err == nil {
		t.Fatal("CreateTab invented a workspace nobody created")
	}
}
