package session

import (
	"context"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/workspace"
)

// A session ALWAYS carries a workspace, and the field is never empty
// (.internal/specs/2026-08-15-workspaces-ux-design.md §4.2 — "a tab is
// always in a workspace, there is no null"). The renderer does not supply
// one and must not: the default workspace never renders, so the renderer
// has no name for it, and AD-7 keeps the fact server-authoritative. The
// registry is the single owner of that default.
func TestOpen_SessionWithNoWorkspaceGetsTheDefault(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})

	sess, err := reg.Open(context.Background(), Config{Kind: KindLocal})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if got := sess.WorkspaceID(); got == "" {
		t.Fatal("a session opened with no workspace has an empty WorkspaceID; the field is not nullable")
	}
	if got, want := sess.WorkspaceID(), workspace.Default; got != want {
		t.Errorf("WorkspaceID = %q, want the default %q", got, want)
	}
}

// A workspace the caller names is kept. This is the path nocx-isoph starts
// using when workspaces are real; it must already work, or the field is
// decorative until that epic lands.
func TestOpen_ExplicitWorkspaceIsPreserved(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})

	sess, err := reg.Open(context.Background(), Config{
		Kind:        KindLocal,
		WorkspaceID: "workspace:refactor-auth",
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if got, want := sess.WorkspaceID(), workspace.ID("workspace:refactor-auth"); got != want {
		t.Errorf("WorkspaceID = %q, want %q", got, want)
	}
}

// The workspace is immutable for the session's lifetime, like the identity
// beside it. Moving a session between workspaces is a lifecycle transition
// the backend registry owns (design §4.4), not a setter on the record — and
// this epic ships no such transition at all. A mutable field would let one
// arrive by accident.
func TestSession_WorkspaceIsNotSettable(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})

	sess, err := reg.Open(context.Background(), Config{Kind: KindLocal})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if _, ok := any(sess).(interface{ SetWorkspaceID(workspace.ID) }); ok {
		t.Fatal("Session exposes SetWorkspaceID; membership changes belong to the registry's lifecycle (design §4.4), not to a setter")
	}
}

// NEGATIVE, and the one the bead cares most about: membership carries NO
// BEHAVIOUR in this epic. Nothing reads authority, addressability or
// reachability from the field, and a grep cannot say so — a grep reports
// where a name appears, not what a dispatcher consults. So this asserts it
// where it would break: two sessions in two different workspaces are
// reached, listed, written to and closed identically.
//
// The fence that WILL make membership an operand is a separate epic
// (design §5), and §5.4 lists four questions it must answer first. Until
// then a session in one workspace is exactly as reachable as any other,
// and this test fails the moment somebody makes it otherwise — which is
// the point, because "lineage implies control" arriving as a temporary
// shortcut is what nocx-ebl4 exists to prevent.
func TestWorkspace_CarriesNoBehaviour(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})
	ctx := context.Background()

	mine, err := reg.Open(ctx, Config{Kind: KindLocal, WorkspaceID: "workspace:mine"})
	if err != nil {
		t.Fatalf("Open mine: %v", err)
	}
	theirs, err := reg.Open(ctx, Config{Kind: KindLocal, WorkspaceID: "workspace:theirs"})
	if err != nil {
		t.Fatalf("Open theirs: %v", err)
	}
	if mine.WorkspaceID() == theirs.WorkspaceID() {
		t.Fatal("the two sessions must be in different workspaces for this test to assert anything")
	}

	// Addressing: neither is hidden from the registry by its workspace.
	for _, s := range []Session{mine, theirs} {
		got, err := reg.Get(s.ID())
		if err != nil {
			t.Fatalf("Get(%s) in workspace %q: %v", s.ID(), s.WorkspaceID(), err)
		}
		if got.ID() != s.ID() {
			t.Fatalf("Get(%s) returned %s", s.ID(), got.ID())
		}
	}

	// Listing: the registry lists both, whatever workspace they are in.
	if n := len(reg.List()); n != 2 {
		t.Fatalf("List returned %d sessions, want both — membership must not filter", n)
	}

	// Input: writing to a session is not gated on its workspace.
	if _, err := theirs.Write([]byte("echo hi\n")); err != nil {
		t.Fatalf("Write to a session in another workspace: %v", err)
	}

	// Closing: the same, and it is what a later fence would gate first.
	if err := reg.Close(theirs.ID()); err != nil {
		t.Fatalf("Close a session in another workspace: %v", err)
	}
	if err := reg.Close(mine.ID()); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
