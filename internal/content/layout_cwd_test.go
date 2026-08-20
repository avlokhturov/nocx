package content_test

// SetPaneCwd — the one writer of panes.cwd after creation (nocx-zkiv4,
// design §5).
//
// A pane's cwd was written once, at creation, and never revised: layout.go
// said so in as many words, with "until restore needs one" beside it.
// Restore needs one. Without it a restored local pane opens wherever the
// pane was FIRST created rather than where the person left it, which for a
// tab that has been working in a repository all afternoon is the wrong
// directory every time.

import (
	"context"
	"errors"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

func TestSetPaneCwd_WritesTheDirectoryARestoreWillOpenIn(t *testing.T) {
	ctx := context.Background()
	db, _ := newLedger(t)
	aPaneUnder(t, db, "0198f2b0-0000-7000-8000-00000000e001",
		"0198f2b0-0000-7000-8000-00000000e002", "0198f2b0-0000-7000-8000-00000000e003")
	const paneID = "0198f2b0-0000-7000-8000-00000000e003"

	got, err := db.Layout().SetPaneCwd(ctx, paneID, "/repo/frontend/src")
	if err != nil {
		t.Fatalf("SetPaneCwd: %v", err)
	}
	if got.Cwd != "/repo/frontend/src" {
		t.Fatalf("returned cwd = %q", got.Cwd)
	}

	// Read back through the snapshot, which is what a restore actually reads.
	snap, err := db.Layout().Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	found := false
	for _, p := range snap.Panes {
		if p.ID == paneID {
			found = true
			if p.Cwd != "/repo/frontend/src" {
				t.Fatalf("stored cwd = %q, want /repo/frontend/src", p.Cwd)
			}
		}
	}
	if !found {
		t.Fatal("the pane is not in the snapshot")
	}
}

// Idempotent, because the renderer reports a cwd on every verified OSC 7 and
// most of them say what the last one said: a shell that prints its prompt
// twice in the same directory must not cost two writes.
func TestSetPaneCwd_TheSameDirectoryTwiceIsOneAnswer(t *testing.T) {
	ctx := context.Background()
	db, _ := newLedger(t)
	aPaneUnder(t, db, "0198f2b0-0000-7000-8000-00000000e011",
		"0198f2b0-0000-7000-8000-00000000e012", "0198f2b0-0000-7000-8000-00000000e013")
	const paneID = "0198f2b0-0000-7000-8000-00000000e013"

	first, err := db.Layout().SetPaneCwd(ctx, paneID, "/srv")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := db.Layout().SetPaneCwd(ctx, paneID, "/srv")
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first != second {
		t.Fatalf("second call answered differently: %+v vs %+v", first, second)
	}
}

// An id no pane carries is ErrNoSuchPane, never a silent no-op: a renderer
// reporting a cwd for a pane the chain does not hold is a bug somewhere, and
// swallowing it hides which.
func TestSetPaneCwd_UnknownPane(t *testing.T) {
	_, err := newLedger(t)
	_ = err
	db, _ := newLedger(t)
	if _, setErr := db.Layout().SetPaneCwd(context.Background(),
		"0198f2b0-0000-7000-8000-0000000000ff", "/tmp"); !errors.Is(setErr, content.ErrNoSuchPane) {
		t.Fatalf("err = %v, want ErrNoSuchPane", setErr)
	}
}
