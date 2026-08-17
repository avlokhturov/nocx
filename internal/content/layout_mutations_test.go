package content_test

// The layout chain's MUTATIONS (nocx-isoph.2, design
// .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §4.5, §5, §7):
// the create that survives a retry, the decoration a user changes, the order
// a strip is dragged into, and the pane that moves between tabs.
//
// The half of this file that matters most is the IDEMPOTENCY of a create.
// A frontend-minted id is UNTRUSTED input (§7) and there are exactly three
// answers a create can give:
//
//	the id is free                → a row is written
//	the id is taken by THIS ask   → the SAME object, Replayed
//	the id is taken by ANOTHER    → ErrIDConflict, and nothing changes
//
// The second answer is what AD-9 buys: the socket drops, the answer to a
// create is lost, and the renderer asks again. Without it that retry is a
// second workspace. The third is what stops a replay ALIASING — one id
// standing for two different objects, which is the failure the ledger's
// entries.digest exists to prevent and this is the same mechanism.

import (
	"context"
	"errors"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// ── fixtures ─────────────────────────────────────────────────────────────

func mutWorkspace(t *testing.T, layout content.LayoutRepository, id, name string) content.Workspace {
	t.Helper()
	made, err := layout.CreateWorkspace(context.Background(), content.Workspace{ID: id, Name: name})
	if err != nil {
		t.Fatalf("CreateWorkspace(%s): %v", id, err)
	}
	return made.Object
}

func mutTab(t *testing.T, layout content.LayoutRepository, id, workspaceID string, position int) content.Tab {
	t.Helper()
	made, err := layout.CreateTab(context.Background(), content.Tab{
		ID: id, WorkspaceID: workspaceID, Position: position, Layout: content.LayoutRow,
	})
	if err != nil {
		t.Fatalf("CreateTab(%s): %v", id, err)
	}
	return made.Object
}

func mutPane(t *testing.T, layout content.LayoutRepository, id, tabID, cwd string) content.Pane {
	t.Helper()
	made, err := layout.CreatePane(context.Background(), content.Pane{
		ID: id, TabID: tabID, Cwd: cwd, Kind: content.PaneLocal, SizeShare: 1,
	})
	if err != nil {
		t.Fatalf("CreatePane(%s): %v", id, err)
	}
	return made.Object
}

// ── the create is idempotent, and aliasing is refused ────────────────────

// The retry AD-9 makes ordinary: the same request, twice, because the answer
// to the first was lost. The second call must return the FIRST object and
// leave one row — counted, not inferred from the absence of an error.
func TestCreateWorkspaceReplaysTheSameRequest(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	ask := content.Workspace{ID: "0199-ws-1", Name: "refactor-auth", Position: 2}

	first, err := layout.CreateWorkspace(ctx, ask)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if first.Replayed {
		t.Fatal("the first create reported a replay")
	}
	second, err := layout.CreateWorkspace(ctx, ask)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed {
		t.Fatal("the retry was not reported as a replay")
	}
	if second.Object != first.Object {
		t.Fatalf("retry returned %+v, want the first object %+v", second.Object, first.Object)
	}
	all, err := layout.Workspaces(ctx)
	if err != nil {
		t.Fatalf("Workspaces: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("workspaces after a retry = %d rows, want 1", len(all))
	}
}

// The same id asking for something else is a DIFFERENT object wearing a used
// key. It is refused, and the row that was there is untouched — a create
// never overwrites (§7).
func TestCreateWorkspaceRefusesAnIDThatMeansSomethingElse(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")

	_, err := layout.CreateWorkspace(ctx, content.Workspace{ID: "0199-ws-1", Name: "ansible-rollout"})
	if !errors.Is(err, content.ErrIDConflict) {
		t.Fatalf("create on a taken id = %v, want ErrIDConflict", err)
	}
	all, err := layout.Workspaces(ctx)
	if err != nil {
		t.Fatalf("Workspaces: %v", err)
	}
	if len(all) != 1 || all[0].Name != "refactor-auth" {
		t.Fatalf("workspaces after a refused create = %+v, want the original row alone", all)
	}
}

func TestCreateTabReplaysAndRefusesAlias(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")
	ask := content.Tab{ID: "0199-tab-1", WorkspaceID: "0199-ws-1", Position: 1, Layout: content.LayoutRow}

	first, err := layout.CreateTab(ctx, ask)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := layout.CreateTab(ctx, ask)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed || second.Object.ID != first.Object.ID || second.Object.Position != first.Object.Position {
		t.Fatalf("retry returned %+v (replayed=%v), want the first object %+v", second.Object, second.Replayed, first.Object)
	}
	tabs, err := layout.Tabs(ctx, "0199-ws-1")
	if err != nil {
		t.Fatalf("Tabs: %v", err)
	}
	if len(tabs) != 1 {
		t.Fatalf("tabs after a retry = %d rows, want 1", len(tabs))
	}

	other := ask
	other.Position = 7
	if _, conflict := layout.CreateTab(ctx, other); !errors.Is(conflict, content.ErrIDConflict) {
		t.Fatalf("create on a taken tab id = %v, want ErrIDConflict", conflict)
	}
	tabs, err = layout.Tabs(ctx, "0199-ws-1")
	if err != nil {
		t.Fatalf("Tabs: %v", err)
	}
	if len(tabs) != 1 || tabs[0].Position != 1 {
		t.Fatalf("tabs after a refused create = %+v, want the original row alone", tabs)
	}
}

func TestCreatePaneReplaysAndRefusesAlias(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)
	ask := content.Pane{ID: "0199-pane-1", TabID: "0199-tab-1", Cwd: "/repos/nocx", Kind: content.PaneLocal, SizeShare: 1}

	first, err := layout.CreatePane(ctx, ask)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := layout.CreatePane(ctx, ask)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed || second.Object != first.Object {
		t.Fatalf("retry returned %+v (replayed=%v), want the first object %+v", second.Object, second.Replayed, first.Object)
	}
	panes, err := layout.Panes(ctx, "0199-tab-1")
	if err != nil {
		t.Fatalf("Panes: %v", err)
	}
	if len(panes) != 1 {
		t.Fatalf("panes after a retry = %d rows, want 1", len(panes))
	}

	elsewhere := ask
	elsewhere.Cwd = "/etc"
	if _, conflict := layout.CreatePane(ctx, elsewhere); !errors.Is(conflict, content.ErrIDConflict) {
		t.Fatalf("create on a taken pane id = %v, want ErrIDConflict", conflict)
	}
	panes, err = layout.Panes(ctx, "0199-tab-1")
	if err != nil {
		t.Fatalf("Panes: %v", err)
	}
	if len(panes) != 1 || panes[0].Cwd != "/repos/nocx" {
		t.Fatalf("panes after a refused create = %+v, want the original row alone", panes)
	}
}

// A create whose CONTAINER does not exist writes nothing and says which one
// was missing. The foreign key would refuse it anyway; the point is that the
// caller learns "no such workspace" rather than a driver's constraint text.
func TestCreateTabRefusesAMissingWorkspace(t *testing.T) {
	_, layout := newLayout(t)
	_, err := layout.CreateTab(context.Background(), content.Tab{
		ID: "0199-tab-1", WorkspaceID: "0199-ws-nope", Layout: content.LayoutRow,
	})
	if !errors.Is(err, content.ErrNoSuchWorkspace) {
		t.Fatalf("CreateTab into a missing workspace = %v, want ErrNoSuchWorkspace", err)
	}
}

func TestCreatePaneRefusesAMissingTab(t *testing.T) {
	_, layout := newLayout(t)
	_, err := layout.CreatePane(context.Background(), content.Pane{
		ID: "0199-pane-1", TabID: "0199-tab-nope", Cwd: "/", Kind: content.PaneLocal, SizeShare: 1,
	})
	if !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("CreatePane into a missing tab = %v, want ErrNoSuchTab", err)
	}
}

// ── decoration ───────────────────────────────────────────────────────────

func TestRenameWorkspace(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")

	got, err := layout.RenameWorkspace(ctx, "0199-ws-1", "auth")
	if err != nil {
		t.Fatalf("RenameWorkspace: %v", err)
	}
	if got.Name != "auth" {
		t.Fatalf("renamed workspace = %+v, want name auth", got)
	}
	all, _ := layout.Workspaces(ctx)
	if len(all) != 1 || all[0].Name != "auth" {
		t.Fatalf("stored workspaces = %+v, want the rename", all)
	}
	if _, err := layout.RenameWorkspace(ctx, "0199-ws-nope", "x"); !errors.Is(err, content.ErrNoSuchWorkspace) {
		t.Fatalf("rename of a missing workspace = %v, want ErrNoSuchWorkspace", err)
	}
}

// A tab's name is NULLABLE and clearing it is a real operation: a tab whose
// name is removed goes back to the label derived from its panes (§4.5), so
// "" and nil are different answers and both must survive the round trip.
func TestRenameTabSetsAndClears(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)

	named := "deploy"
	got, err := layout.RenameTab(ctx, "0199-tab-1", &named)
	if err != nil {
		t.Fatalf("RenameTab: %v", err)
	}
	if got.Name == nil || *got.Name != "deploy" {
		t.Fatalf("named tab = %+v, want deploy", got)
	}
	cleared, err := layout.RenameTab(ctx, "0199-tab-1", nil)
	if err != nil {
		t.Fatalf("RenameTab(nil): %v", err)
	}
	if cleared.Name != nil {
		t.Fatalf("cleared tab name = %v, want nil — the label goes back to being derived", *cleared.Name)
	}
	if _, err := layout.RenameTab(ctx, "0199-tab-nope", &named); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("rename of a missing tab = %v, want ErrNoSuchTab", err)
	}
}

func TestRecolourAndPinTab(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)

	colour := "#ff8800"
	got, err := layout.RecolourTab(ctx, "0199-tab-1", &colour)
	if err != nil {
		t.Fatalf("RecolourTab: %v", err)
	}
	if got.Colour == nil || *got.Colour != colour {
		t.Fatalf("recoloured tab = %+v, want %s", got, colour)
	}
	undecorated, err := layout.RecolourTab(ctx, "0199-tab-1", nil)
	if err != nil {
		t.Fatalf("RecolourTab(nil): %v", err)
	}
	if undecorated.Colour != nil {
		t.Fatalf("cleared colour = %v, want nil", *undecorated.Colour)
	}

	pinned, err := layout.PinTab(ctx, "0199-tab-1", true)
	if err != nil {
		t.Fatalf("PinTab: %v", err)
	}
	if !pinned.Pinned {
		t.Fatalf("pinned tab = %+v, want pinned", pinned)
	}
	unpinned, err := layout.PinTab(ctx, "0199-tab-1", false)
	if err != nil {
		t.Fatalf("PinTab(false): %v", err)
	}
	if unpinned.Pinned {
		t.Fatalf("unpinned tab = %+v, want not pinned", unpinned)
	}
	if _, err := layout.RecolourTab(ctx, "0199-tab-nope", &colour); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("recolour of a missing tab = %v, want ErrNoSuchTab", err)
	}
	if _, err := layout.PinTab(ctx, "0199-tab-nope", true); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("pin of a missing tab = %v, want ErrNoSuchTab", err)
	}
}

// ── order ────────────────────────────────────────────────────────────────

// Reorder takes the WHOLE order, never a move: a partial list is a second
// implementation of "where does everything else go", and the two answers
// diverge the first time they disagree. So a list that is not a permutation
// of the container's members is refused and nothing moves — the same rule
// snippet.ErrNotAPermutation already states for the snippet library.
func TestReorderWorkspacesTakesAPermutationOnly(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "one")
	mutWorkspace(t, layout, "0199-ws-2", "two")
	mutWorkspace(t, layout, "0199-ws-3", "three")

	got, err := layout.ReorderWorkspaces(ctx, []string{"0199-ws-3", "0199-ws-1", "0199-ws-2"})
	if err != nil {
		t.Fatalf("ReorderWorkspaces: %v", err)
	}
	want := []string{"0199-ws-3", "0199-ws-1", "0199-ws-2"}
	for i, w := range want {
		if got[i].ID != w || got[i].Position != i {
			t.Fatalf("reordered workspaces = %+v, want %v in position order", got, want)
		}
	}
	stored, _ := layout.Workspaces(ctx)
	for i, w := range want {
		if stored[i].ID != w {
			t.Fatalf("stored order = %+v, want %v", stored, want)
		}
	}

	for _, bad := range [][]string{
		{"0199-ws-3", "0199-ws-1"},                              // short
		{"0199-ws-3", "0199-ws-1", "0199-ws-2", "0199-ws-nope"}, // a stranger
		{"0199-ws-3", "0199-ws-3", "0199-ws-1"},                 // a duplicate
	} {
		if _, err := layout.ReorderWorkspaces(ctx, bad); !errors.Is(err, content.ErrNotAPermutation) {
			t.Fatalf("ReorderWorkspaces(%v) = %v, want ErrNotAPermutation", bad, err)
		}
	}
	stored, _ = layout.Workspaces(ctx)
	for i, w := range want {
		if stored[i].ID != w {
			t.Fatalf("order after a refused reorder = %+v, want %v unchanged", stored, want)
		}
	}
}

// A tab's order is a permutation of ITS WORKSPACE's tabs. A tab belonging to
// another workspace is not a member here, and naming one is the same refusal:
// reorder moves a strip, it never moves a tab between workspaces.
func TestReorderTabsIsScopedToOneWorkspace(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "one")
	mutWorkspace(t, layout, "0199-ws-2", "two")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)
	mutTab(t, layout, "0199-tab-2", "0199-ws-1", 1)
	mutTab(t, layout, "0199-tab-3", "0199-ws-2", 0)

	got, err := layout.ReorderTabs(ctx, "0199-ws-1", []string{"0199-tab-2", "0199-tab-1"})
	if err != nil {
		t.Fatalf("ReorderTabs: %v", err)
	}
	if len(got) != 2 || got[0].ID != "0199-tab-2" || got[0].Position != 0 || got[1].ID != "0199-tab-1" {
		t.Fatalf("reordered tabs = %+v, want tab-2 then tab-1", got)
	}
	if _, err := layout.ReorderTabs(ctx, "0199-ws-1", []string{"0199-tab-2", "0199-tab-3"}); !errors.Is(err, content.ErrNotAPermutation) {
		t.Fatalf("reorder naming another workspace's tab = %v, want ErrNotAPermutation", err)
	}
	stored, _ := layout.Tabs(ctx, "0199-ws-1")
	if stored[0].ID != "0199-tab-2" {
		t.Fatalf("order after a refused reorder = %+v, want the accepted order unchanged", stored)
	}
}

// ── the pane moves, and only a reference moves with it ───────────────────

// §4.4: dragging a pane into another tab changes its tab_id and NOTHING
// else. The pane's identity, its cwd and its kind are the same row — which
// is what makes the round trip lossless, and is the whole reason the durable
// object is the pane rather than the tab.
func TestMovePaneChangesOnlyTheReference(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "one")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)
	mutTab(t, layout, "0199-tab-2", "0199-ws-1", 1)
	before := mutPane(t, layout, "0199-pane-1", "0199-tab-1", "/repos/nocx")

	after, err := layout.MovePane(ctx, "0199-pane-1", "0199-tab-2")
	if err != nil {
		t.Fatalf("MovePane: %v", err)
	}
	if after.ID != before.ID || after.Cwd != before.Cwd || after.Kind != before.Kind || after.SizeShare != before.SizeShare {
		t.Fatalf("moved pane = %+v, want everything but tabId unchanged from %+v", after, before)
	}
	if after.TabID != "0199-tab-2" {
		t.Fatalf("moved pane tab = %q, want 0199-tab-2", after.TabID)
	}
	left, _ := layout.Panes(ctx, "0199-tab-1")
	if len(left) != 0 {
		t.Fatalf("source tab still holds %+v", left)
	}
	arrived, _ := layout.Panes(ctx, "0199-tab-2")
	if len(arrived) != 1 || arrived[0].ID != "0199-pane-1" {
		t.Fatalf("destination tab holds %+v, want the moved pane", arrived)
	}
}

func TestMovePaneRefusesAMissingPaneOrTab(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "one")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)
	mutPane(t, layout, "0199-pane-1", "0199-tab-1", "/repos/nocx")

	if _, err := layout.MovePane(ctx, "0199-pane-nope", "0199-tab-1"); !errors.Is(err, content.ErrNoSuchPane) {
		t.Fatalf("move of a missing pane = %v, want ErrNoSuchPane", err)
	}
	if _, err := layout.MovePane(ctx, "0199-pane-1", "0199-tab-nope"); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("move into a missing tab = %v, want ErrNoSuchTab", err)
	}
	panes, _ := layout.Panes(ctx, "0199-tab-1")
	if len(panes) != 1 {
		t.Fatalf("panes after two refused moves = %+v, want the pane where it was", panes)
	}
}

// ── the chain resolves itself ────────────────────────────────────────────

// The whole point of §4.5 moving workspaceId off the session: the BACKEND
// owns the chain, so it answers "which workspace is this pane in" by walking
// pane → tab → workspace rather than by being told.
func TestWorkspaceForPaneWalksTheChain(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	mutWorkspace(t, layout, "0199-ws-1", "refactor-auth")
	mutTab(t, layout, "0199-tab-1", "0199-ws-1", 0)
	mutPane(t, layout, "0199-pane-1", "0199-tab-1", "/repos/nocx")

	got, err := layout.WorkspaceForPane(ctx, "0199-pane-1")
	if err != nil {
		t.Fatalf("WorkspaceForPane: %v", err)
	}
	if got != "0199-ws-1" {
		t.Fatalf("WorkspaceForPane = %q, want 0199-ws-1", got)
	}
	// And it follows the pane when the pane moves: the answer is the chain's,
	// not a copy taken when the pane was made.
	mutWorkspace(t, layout, "0199-ws-2", "ansible")
	mutTab(t, layout, "0199-tab-2", "0199-ws-2", 0)
	if _, moveErr := layout.MovePane(ctx, "0199-pane-1", "0199-tab-2"); moveErr != nil {
		t.Fatalf("MovePane: %v", moveErr)
	}
	got, err = layout.WorkspaceForPane(ctx, "0199-pane-1")
	if err != nil {
		t.Fatalf("WorkspaceForPane after move: %v", err)
	}
	if got != "0199-ws-2" {
		t.Fatalf("WorkspaceForPane after move = %q, want 0199-ws-2", got)
	}
	if _, err := layout.WorkspaceForPane(ctx, "0199-pane-nope"); !errors.Is(err, content.ErrNoSuchPane) {
		t.Fatalf("WorkspaceForPane of a missing pane = %v, want ErrNoSuchPane", err)
	}
}
