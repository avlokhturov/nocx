package agenttools

import (
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// The block capability is the authority half of the block tools (nocx-5u3oz.6):
// it holds EXACTLY the grant's session scopes, so a tool that holds it can
// name no other session — the narrowing ADR-0028 decision 4 asks for, not a
// check the executor could forget.

func TestNewBlockReader_HoldsOnlyTheGrantsSessions(t *testing.T) {
	r := NewBlockReader([]content.GrantScope{
		{Kind: content.ResourceSession, ID: "lane-1"},
		{Kind: content.ResourcePath, ID: "/workspace"},
		{Kind: content.ResourceSession, ID: ""},
	})
	if !r.Allows("lane-1") {
		t.Errorf("Allows(lane-1) = false, want true — it is the grant's session")
	}
	if r.Allows("lane-2") {
		t.Errorf("Allows(lane-2) = true, want false — the grant never named it")
	}
	if r.Allows("/workspace") {
		t.Errorf("Allows(/workspace) = true, want false — a path scope is not a session")
	}
	if r.Allows("") {
		t.Errorf("Allows(\"\") = true, want false")
	}
}

// A grant with no session scope builds a capability that refuses every read:
// the tool can never exceed the grant because it never holds more than it.
func TestNewBlockReader_NoSessionScopeRefusesEverything(t *testing.T) {
	r := NewBlockReader([]content.GrantScope{{Kind: content.ResourcePath, ID: "/workspace"}})
	if r.Allows("lane-1") {
		t.Errorf("a grant with no session scope allowed lane-1")
	}
	var nilReader *BlockReader
	if nilReader.Allows("lane-1") {
		t.Errorf("a nil capability allowed lane-1")
	}
}

// narrowBlocks is the row's own constructor: the middleware needs no per-tool
// switch to know how to narrow a block tool, and what it builds holds the
// grant's sessions and nothing else.
func TestNarrowBlocks_BuildsFromTheGrant(t *testing.T) {
	g := content.Grant{Scopes: []content.GrantScope{
		{Kind: content.ResourceSession, ID: "lane-1"},
		{Kind: content.ResourceSession, ID: "lane-9"},
	}}
	cap, err := narrowBlocks(g)
	if err != nil {
		t.Fatalf("narrowBlocks: %v", err)
	}
	r, ok := cap.(*BlockReader)
	if !ok {
		t.Fatalf("narrowBlocks built %T, want *BlockReader", cap)
	}
	if !r.Allows("lane-1") || !r.Allows("lane-9") {
		t.Errorf("capability does not hold both of the grant's sessions")
	}
	if r.Allows("lane-2") {
		t.Errorf("capability holds a session the grant never named")
	}
}

// Both rows are in the table, classified, executable, and pointed at their
// schema files: a declared-but-not-executable row is refused by the
// middleware, and that is not the state these two ship in.
func TestBlockDeclarations_AreDeclaredAndExecutable(t *testing.T) {
	byName := map[string]Declaration{}
	for _, d := range declarations {
		byName[d.Name] = d
	}
	for _, name := range []string{"blocks.list", "blocks.read"} {
		d, ok := byName[name]
		if !ok {
			t.Fatalf("%s is not declared", name)
		}
		if d.Effect != content.EffectObserve {
			t.Errorf("%s effect = %q, want observe — reading a block changes nothing", name, d.Effect)
		}
		if len(d.Resources) != 1 || d.Resources[0] != content.ResourceSession {
			t.Errorf("%s resources = %v, want [session]", name, d.Resources)
		}
		if d.ResourceArg != "sessionId" {
			t.Errorf("%s resourceArg = %q, want sessionId — the policy's scope check reads it", name, d.ResourceArg)
		}
		if d.Executes != InGo {
			t.Errorf("%s executes = %q, want go — the ledger read happens in this process", name, d.Executes)
		}
		if d.Narrow == nil {
			t.Errorf("%s has no capability constructor: declared but not executable", name)
		}
	}
}
