package content_test

// The layout chain's IDEMPOTENCY and its decoration (nocx-isoph.2, design
// .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §4.5, §5, §7):
// the create that survives a retry, the decoration a user changes, and the
// order a strip is dragged into. The container LIFECYCLE — creation with
// content, dissolution with the last member, the replacement tab and the
// move — is nocx-isoph.3's and is asserted in layout_lifecycle_test.go.
//
// The half of this file that matters most is the IDEMPOTENCY of a create.
// A frontend-minted id is UNTRUSTED input (§7) and there are exactly three
// answers a create can give:
//
//	the id is free                → the rows are written
//	the id is taken by THIS ask   → the SAME objects, Replayed
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

// paneIDs is the tab's panes by id — the count a retry must not change. Its
// two neighbours, tabIDs and workspaceIDs, live in layout_lifecycle_test.go.
func paneIDs(t *testing.T, layout content.LayoutRepository, tabID string) []string {
	t.Helper()
	panes, err := layout.Panes(context.Background(), tabID)
	if err != nil {
		t.Fatalf("Panes(%s): %v", tabID, err)
	}
	ids := make([]string, 0, len(panes))
	for _, p := range panes {
		ids = append(ids, p.ID)
	}
	return ids
}

// ── the create is idempotent, and aliasing is refused ────────────────────

// The retry AD-9 makes ordinary: the same request, twice, because the answer
// to the first was lost. The second call must return the FIRST objects and
// leave one row of each — counted, not inferred from the absence of an error.
func TestCreateWorkspaceReplaysTheSameRequest(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	ws := content.Workspace{ID: "ws-1", Name: "refactor-auth", Position: 2}
	tab := aTab("tab-1", "ws-1")
	pane := aPane("pane-1", "tab-1", "/srv")

	first, err := layout.CreateWorkspace(ctx, ws, tab, pane)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if first.Replayed {
		t.Fatal("the first create reported a replay")
	}
	second, err := layout.CreateWorkspace(ctx, ws, tab, pane)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed {
		t.Fatal("the retry was not reported as a replay")
	}
	// All three rows come back, and they are the FIRST ones: a creation with
	// content has no answer that names only its container.
	if second.Object.Workspace != first.Object.Workspace ||
		second.Object.FirstTab.ID != first.Object.FirstTab.ID ||
		second.Object.FirstPane != first.Object.FirstPane {
		t.Fatalf("retry returned %+v, want the first objects %+v", second.Object, first.Object)
	}
	if got := workspaceIDs(t, layout); len(got) != 1 {
		t.Fatalf("workspaces after a retry = %v, want one", got)
	}
	if got := tabIDs(t, layout, "ws-1"); len(got) != 1 {
		t.Fatalf("tabs after a retry = %v, want one", got)
	}
	if got := paneIDs(t, layout, "tab-1"); len(got) != 1 {
		t.Fatalf("panes after a retry = %v, want one", got)
	}
}

// The same id asking for something else is a DIFFERENT object wearing a used
// key. It is refused, and the row that was there is untouched — a create
// never overwrites (§7). The digest covers the WHOLE request, so a retry that
// changed only the first pane's cwd is an alias too.
func TestCreateWorkspaceRefusesAnIDThatMeansSomethingElse(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")

	for name, ask := range map[string]struct {
		ws   content.Workspace
		tab  content.Tab
		pane content.Pane
	}{
		"another name":      {content.Workspace{ID: "ws-1", Name: "ansible"}, aTab("tab-1", "ws-1"), aPane("pane-1", "tab-1", "/srv")},
		"another first tab": {content.Workspace{ID: "ws-1", Name: "ws-1"}, aTab("tab-9", "ws-1"), aPane("pane-1", "tab-9", "/srv")},
		"another cwd":       {content.Workspace{ID: "ws-1", Name: "ws-1"}, aTab("tab-1", "ws-1"), aPane("pane-1", "tab-1", "/etc")},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := layout.CreateWorkspace(ctx, ask.ws, ask.tab, ask.pane); !errors.Is(err, content.ErrIDConflict) {
				t.Fatalf("create on a taken id = %v, want ErrIDConflict", err)
			}
		})
	}
	spaces, err := layout.Workspaces(ctx)
	if err != nil {
		t.Fatalf("Workspaces: %v", err)
	}
	if len(spaces) != 1 || spaces[0].Name != "ws-1" {
		t.Fatalf("workspaces after the refusals = %+v, want the original row alone", spaces)
	}
	if got := tabIDs(t, layout, "ws-1"); len(got) != 1 || got[0] != "tab-1" {
		t.Fatalf("tabs after the refusals = %v, want tab-1 alone", got)
	}
}

func TestCreateTabReplaysAndRefusesAlias(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")
	tab := aTab("tab-2", "ws-1")
	pane := aPane("pane-2", "tab-2", "/var")

	first, err := layout.CreateTab(ctx, tab, pane)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := layout.CreateTab(ctx, tab, pane)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed || second.Object.Tab.ID != first.Object.Tab.ID || second.Object.FirstPane != first.Object.FirstPane {
		t.Fatalf("retry returned %+v (replayed=%v), want the first objects %+v", second.Object, second.Replayed, first.Object)
	}
	if got := tabIDs(t, layout, "ws-1"); len(got) != 2 {
		t.Fatalf("tabs after a retry = %v, want two", got)
	}

	moved := tab
	moved.Position = 7
	if _, conflict := layout.CreateTab(ctx, moved, pane); !errors.Is(conflict, content.ErrIDConflict) {
		t.Fatalf("create on a taken tab id = %v, want ErrIDConflict", conflict)
	}
	if got := tabIDs(t, layout, "ws-1"); len(got) != 2 {
		t.Fatalf("tabs after a refused create = %v, want two", got)
	}
}

func TestCreatePaneReplaysAndRefusesAlias(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")
	pane := aPane("pane-2", "tab-1", "/var")

	first, err := layout.CreatePane(ctx, pane)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := layout.CreatePane(ctx, pane)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.Replayed || second.Object != first.Object {
		t.Fatalf("retry returned %+v (replayed=%v), want the first object %+v", second.Object, second.Replayed, first.Object)
	}
	if got := paneIDs(t, layout, "tab-1"); len(got) != 2 {
		t.Fatalf("panes after a retry = %v, want two", got)
	}

	elsewhere := pane
	elsewhere.Cwd = "/etc"
	if _, conflict := layout.CreatePane(ctx, elsewhere); !errors.Is(conflict, content.ErrIDConflict) {
		t.Fatalf("create on a taken pane id = %v, want ErrIDConflict", conflict)
	}
	if got := paneIDs(t, layout, "tab-1"); len(got) != 2 {
		t.Fatalf("panes after a refused create = %v, want two", got)
	}
}

// A create whose CONTAINER does not exist writes nothing and says which one
// was missing. The foreign key would refuse it anyway; the point is that the
// caller learns "no such workspace" rather than a driver's constraint text,
// because the wire turns that answer into -32602 and anything else into a
// server fault.
func TestCreateRefusesAMissingContainerByName(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()

	if _, err := layout.CreateTab(ctx, aTab("tab-1", "ws-nope"), aPane("pane-1", "tab-1", "/srv")); !errors.Is(err, content.ErrNoSuchWorkspace) {
		t.Fatalf("CreateTab into a missing workspace = %v, want ErrNoSuchWorkspace", err)
	}
	if _, err := layout.CreatePane(ctx, aPane("pane-1", "tab-nope", "/srv")); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("CreatePane into a missing tab = %v, want ErrNoSuchTab", err)
	}
}

// ── decoration ───────────────────────────────────────────────────────────

func TestRenameWorkspace(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")

	got, err := layout.RenameWorkspace(ctx, "ws-1", "auth")
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
	if _, err := layout.RenameWorkspace(ctx, "ws-nope", "x"); !errors.Is(err, content.ErrNoSuchWorkspace) {
		t.Fatalf("rename of a missing workspace = %v, want ErrNoSuchWorkspace", err)
	}
}

// A tab's name is NULLABLE and clearing it is a real operation: a tab whose
// name is removed goes back to the label derived from its panes (§4.5), so
// a name and nil are different answers and both must survive the round trip.
func TestRenameTabSetsAndClears(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")

	named := "deploy"
	got, err := layout.RenameTab(ctx, "tab-1", &named)
	if err != nil {
		t.Fatalf("RenameTab: %v", err)
	}
	if got.Name == nil || *got.Name != "deploy" {
		t.Fatalf("named tab = %+v, want deploy", got)
	}
	cleared, err := layout.RenameTab(ctx, "tab-1", nil)
	if err != nil {
		t.Fatalf("RenameTab(nil): %v", err)
	}
	if cleared.Name != nil {
		t.Fatalf("cleared tab name = %v, want nil — the label goes back to being derived", *cleared.Name)
	}
	if _, err := layout.RenameTab(ctx, "tab-nope", &named); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("rename of a missing tab = %v, want ErrNoSuchTab", err)
	}
}

func TestRecolourAndPinTab(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")

	colour := "#ff8800"
	got, err := layout.RecolourTab(ctx, "tab-1", &colour)
	if err != nil {
		t.Fatalf("RecolourTab: %v", err)
	}
	if got.Colour == nil || *got.Colour != colour {
		t.Fatalf("recoloured tab = %+v, want %s", got, colour)
	}
	undecorated, err := layout.RecolourTab(ctx, "tab-1", nil)
	if err != nil {
		t.Fatalf("RecolourTab(nil): %v", err)
	}
	if undecorated.Colour != nil {
		t.Fatalf("cleared colour = %v, want nil", *undecorated.Colour)
	}

	pinned, err := layout.PinTab(ctx, "tab-1", true)
	if err != nil {
		t.Fatalf("PinTab: %v", err)
	}
	if !pinned.Pinned {
		t.Fatalf("pinned tab = %+v, want pinned", pinned)
	}
	unpinned, err := layout.PinTab(ctx, "tab-1", false)
	if err != nil {
		t.Fatalf("PinTab(false): %v", err)
	}
	if unpinned.Pinned {
		t.Fatalf("unpinned tab = %+v, want not pinned", unpinned)
	}
	if _, err := layout.RecolourTab(ctx, "tab-nope", &colour); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("recolour of a missing tab = %v, want ErrNoSuchTab", err)
	}
	if _, err := layout.PinTab(ctx, "tab-nope", true); !errors.Is(err, content.ErrNoSuchTab) {
		t.Fatalf("pin of a missing tab = %v, want ErrNoSuchTab", err)
	}
}

// A decoration does NOT rebind the create key. The digest binds the untrusted
// id to the create, and a rename is a second event on a row that already
// exists — recomputing it would turn a later retry of the original create
// into a conflict, which is the trap the ledger's close path names in the
// same words.
func TestDecorationDoesNotBreakTheCreateRetry(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	ws := content.Workspace{ID: "ws-1", Name: "release"}
	tab := aTab("tab-1", "ws-1")
	pane := aPane("pane-1", "tab-1", "/srv")
	if _, err := layout.CreateWorkspace(ctx, ws, tab, pane); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := layout.RenameWorkspace(ctx, "ws-1", "renamed"); err != nil {
		t.Fatalf("RenameWorkspace: %v", err)
	}

	replay, err := layout.CreateWorkspace(ctx, ws, tab, pane)
	if err != nil {
		t.Fatalf("retry after a rename: %v", err)
	}
	if !replay.Replayed {
		t.Fatal("the retry was not a replay — a decoration must not rebind the create key")
	}
	// And it answers with the row as it is NOW, not as it was asked for: a
	// replay reads the store rather than echoing the request.
	if replay.Object.Workspace.Name != "renamed" {
		t.Fatalf("replay returned name %q, want the stored %q", replay.Object.Workspace.Name, "renamed")
	}
}

// ── order ────────────────────────────────────────────────────────────────

// Reorder takes the WHOLE order, never a move: a partial list is a second
// implementation of "where does everything else go", and the two answers
// diverge the first time they disagree. So a list that is not a permutation
// of the container's members is refused and nothing moves.
func TestReorderWorkspacesTakesAPermutationOnly(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")
	seedWorkspace(t, layout, "ws-2", "tab-2", "pane-2")
	seedWorkspace(t, layout, "ws-3", "tab-3", "pane-3")

	want := []string{"ws-3", "ws-1", "ws-2"}
	got, err := layout.ReorderWorkspaces(ctx, want)
	if err != nil {
		t.Fatalf("ReorderWorkspaces: %v", err)
	}
	for i, id := range want {
		if got[i].ID != id || got[i].Position != i {
			t.Fatalf("reordered workspaces = %+v, want %v in position order", got, want)
		}
	}
	if stored := workspaceIDs(t, layout); stored[0] != "ws-3" || stored[1] != "ws-1" || stored[2] != "ws-2" {
		t.Fatalf("stored order = %v, want %v", stored, want)
	}

	for _, bad := range [][]string{
		{"ws-3", "ws-1"},                  // short
		{"ws-3", "ws-1", "ws-2", "ws-no"}, // a stranger
		{"ws-3", "ws-3", "ws-1"},          // a duplicate
	} {
		if _, err := layout.ReorderWorkspaces(ctx, bad); !errors.Is(err, content.ErrNotAPermutation) {
			t.Fatalf("ReorderWorkspaces(%v) = %v, want ErrNotAPermutation", bad, err)
		}
	}
	if stored := workspaceIDs(t, layout); stored[0] != "ws-3" {
		t.Fatalf("order after a refused reorder = %v, want %v unchanged", stored, want)
	}
}

// A tab's order is a permutation of ITS WORKSPACE's tabs. A tab belonging to
// another workspace is not a member here, and naming one is the same refusal:
// reorder moves a strip, it never moves a tab between workspaces.
func TestReorderTabsIsScopedToOneWorkspace(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")
	seedWorkspace(t, layout, "ws-2", "tab-3", "pane-3")
	if _, err := layout.CreateTab(ctx, aTab("tab-2", "ws-1"), aPane("pane-2", "tab-2", "/var")); err != nil {
		t.Fatalf("CreateTab: %v", err)
	}

	got, err := layout.ReorderTabs(ctx, "ws-1", []string{"tab-2", "tab-1"})
	if err != nil {
		t.Fatalf("ReorderTabs: %v", err)
	}
	if len(got) != 2 || got[0].ID != "tab-2" || got[0].Position != 0 || got[1].ID != "tab-1" {
		t.Fatalf("reordered tabs = %+v, want tab-2 then tab-1", got)
	}
	if _, err := layout.ReorderTabs(ctx, "ws-1", []string{"tab-2", "tab-3"}); !errors.Is(err, content.ErrNotAPermutation) {
		t.Fatalf("reorder naming another workspace's tab = %v, want ErrNotAPermutation", err)
	}
	if stored := tabIDs(t, layout, "ws-1"); stored[0] != "tab-2" {
		t.Fatalf("order after a refused reorder = %v, want the accepted order unchanged", stored)
	}
	if _, err := layout.ReorderTabs(ctx, "ws-nope", []string{"tab-1"}); !errors.Is(err, content.ErrNoSuchWorkspace) {
		t.Fatalf("reorder in a missing workspace = %v, want ErrNoSuchWorkspace", err)
	}
}

// ── the chain resolves itself ────────────────────────────────────────────

// The whole point of §4.5 moving workspaceId off the session: the BACKEND
// owns the chain, so it answers "which workspace is this pane in" by walking
// pane → tab → workspace rather than by being told.
func TestWorkspaceForPaneWalksTheChain(t *testing.T) {
	_, layout := newLayout(t)
	ctx := context.Background()
	seedWorkspace(t, layout, "ws-1", "tab-1", "pane-1")
	if _, err := layout.CreateTab(ctx, aTab("tab-2", "ws-1"), aPane("pane-2", "tab-2", "/var")); err != nil {
		t.Fatalf("CreateTab: %v", err)
	}

	got, err := layout.WorkspaceForPane(ctx, "pane-1")
	if err != nil {
		t.Fatalf("WorkspaceForPane: %v", err)
	}
	if got != "ws-1" {
		t.Fatalf("WorkspaceForPane = %q, want ws-1", got)
	}
	// And it follows the pane when the pane moves: the answer is the chain's,
	// not a copy taken when the pane was made.
	if _, moveErr := layout.MovePane(ctx, "pane-1", "tab-2"); moveErr != nil {
		t.Fatalf("MovePane: %v", moveErr)
	}
	got, err = layout.WorkspaceForPane(ctx, "pane-1")
	if err != nil {
		t.Fatalf("WorkspaceForPane after move: %v", err)
	}
	if got != "ws-1" {
		t.Fatalf("WorkspaceForPane after move = %q, want ws-1", got)
	}
	if _, err := layout.WorkspaceForPane(ctx, "pane-nope"); !errors.Is(err, content.ErrNoSuchPane) {
		t.Fatalf("WorkspaceForPane of a missing pane = %v, want ErrNoSuchPane", err)
	}
}
