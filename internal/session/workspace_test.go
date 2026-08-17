package session

import (
	"context"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/workspace"
)

// THE SESSION NO LONGER STORES A WORKSPACE (nocx-isoph.2, tabs-panes-and-blocks
// §4.5). The field nocx-fraus put here was the intermediate step and not the
// destination: the workspace is a column on the TAB now, and the backend owns
// the whole chain, so it resolves pane → tab → workspace itself
// (content.LayoutRepository.WorkspaceForPane, and the open ack derives its
// workspaceId through it).
//
// This file is what keeps the copy from coming back. A session that carried
// one would be the second owner of a fact the chain already answers, and the
// two would part company the first time a pane was dragged into another tab —
// with the session's copy still answering confidently, which is the failure
// mode AGENTS.md names: the loser goes on advertising what it can no longer
// deliver.
//
// The invariant itself is UNCHANGED and is asserted where it now lives: never
// null, one owner of the default (internal/workspace.Default), tested over the
// wire in internal/transport/ws_layout_workspace_test.go.
func TestSession_DoesNotCarryAWorkspace(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})

	sess, err := reg.Open(context.Background(), Config{Kind: KindLocal})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = reg.Close(sess.ID()) }()

	if _, ok := any(sess).(interface{ WorkspaceID() workspace.ID }); ok {
		t.Fatal("Session exposes WorkspaceID; the workspace is the TAB's column since §4.5, and the backend resolves it through the chain")
	}
	if _, ok := any(sess).(interface{ SetWorkspaceID(workspace.ID) }); ok {
		t.Fatal("Session exposes SetWorkspaceID; membership is a property of the tab, and moving a pane is what changes it")
	}
}

// NEGATIVE, and the one the epic cares most about: membership carries NO
// BEHAVIOUR. Nothing reads authority, addressability or reachability from it,
// and a grep cannot say so — a grep reports where a name appears, not what a
// dispatcher consults. So it is asserted where it would break: two sessions
// are reached, listed, written to and closed identically, and the registry has
// no workspace to filter on at all.
//
// The fence that WILL make membership an operand is a separate epic
// (workspaces-ux §5), and §5.4 lists four questions it must answer first.
// Until then this test fails the moment somebody makes one session less
// reachable than another, which is the point: "membership implies control"
// arriving as a temporary shortcut is what nocx-ebl4 exists to prevent.
func TestWorkspace_CarriesNoBehaviour(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	reg := New(logger, &stubPTYFactory{stub: pty.NewStub(logger)})
	ctx := context.Background()

	mine, err := reg.Open(ctx, Config{Kind: KindLocal})
	if err != nil {
		t.Fatalf("Open mine: %v", err)
	}
	theirs, err := reg.Open(ctx, Config{Kind: KindLocal})
	if err != nil {
		t.Fatalf("Open theirs: %v", err)
	}

	// Addressing: neither is hidden from the registry.
	for _, s := range []Session{mine, theirs} {
		got, err := reg.Get(s.ID())
		if err != nil {
			t.Fatalf("Get(%s): %v", s.ID(), err)
		}
		if got.ID() != s.ID() {
			t.Fatalf("Get(%s) returned %s", s.ID(), got.ID())
		}
	}

	// Listing: the registry lists both.
	if n := len(reg.List()); n != 2 {
		t.Fatalf("List returned %d sessions, want both — membership must not filter", n)
	}

	// Input: writing to a session is not gated on where it belongs.
	if _, err := theirs.Write([]byte("echo hi\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Closing: the same, and it is what a later fence would gate first.
	if err := reg.Close(theirs.ID()); err != nil {
		t.Fatalf("Close theirs: %v", err)
	}
	if err := reg.Close(mine.ID()); err != nil {
		t.Fatalf("Close mine: %v", err)
	}
}
