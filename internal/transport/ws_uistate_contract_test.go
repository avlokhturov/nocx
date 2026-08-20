package transport

// The uistate.* wire contract, from both ends (AGENTS.md rule 5): the DTO
// marshals to something the schema accepts, and the REAL result off the REAL
// socket satisfies it too. The second is the one that matters — a test that
// validates a payload it constructed itself proves the struct is well-formed,
// not that the server sends it.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/uistate"
)

func TestUIStateGet_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "uistate.schema.json")

	cases := map[string]uiStateLayout{
		"a fresh profile": {
			Sidebar:   uiStateSidebar{Width: uistate.DefaultSidebarWidth},
			ActiveTab: "",
		},
		"a used profile": {
			Sidebar:   uiStateSidebar{Collapsed: true, ActiveViewID: "ports", Width: 320},
			ActiveTab: "pane-7",
		},
	}
	for name, dto := range cases {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(dto)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			validateJSON(t, schema, raw, "uistate.get result ("+name+")")
		})
	}
}

func TestUIStateSet_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "uistate.schema.json")
	raw, err := json.Marshal(uiStateLayout{
		Sidebar:   uiStateSidebar{Collapsed: false, ActiveViewID: "files", Width: 206},
		ActiveTab: "pane-1",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	validateJSON(t, schema, raw, "uistate.set result")
}

// newUIStateWSServer builds a server over a real DocumentStore in a temp
// directory: the store IS what is under test here, and a fake one would prove
// the DTO and nothing about the wire.
func newUIStateWSServer(t *testing.T) (*WSServer, *uistate.Store, func()) {
	t.Helper()
	store := uistate.New(storage.NewDocumentStore(t.TempDir()), nil)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)), WithUIState(store))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return ws, store, func() { _ = ws.Stop(ctx); _ = store.Close() }
}

func TestUIStateGet_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "uistate.schema.json")
	ws, _, stop := newUIStateWSServer(t)
	defer stop()

	resp := snippetCall(t, connectWS(t, ws), "uistate.get", map[string]any{}, 1)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	validateJSON(t, schema, resp.Result, "uistate.get result")
}

func TestUIStateSet_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "uistate.schema.json")
	ws, _, stop := newUIStateWSServer(t)
	defer stop()

	resp := snippetCall(t, connectWS(t, ws), "uistate.set", map[string]any{
		"sidebar":   map[string]any{"collapsed": true, "activeViewId": "ports", "width": 320},
		"activeTab": "pane-3",
	}, 1)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	validateJSON(t, schema, resp.Result, "uistate.set result")
}

// The round trip a user performs: drag the panel, restart, find it where they
// left it. Two connections against one store, because a restart is exactly a
// new renderer reading what the last one wrote.
func TestUIStateSurvivesOverTheWire(t *testing.T) {
	ws, _, stop := newUIStateWSServer(t)
	defer stop()

	set := snippetCall(t, connectWS(t, ws), "uistate.set", map[string]any{
		"sidebar":   map[string]any{"collapsed": true, "activeViewId": "ports", "width": 320},
		"activeTab": "pane-3",
	}, 1)
	if set.Error != nil {
		t.Fatalf("uistate.set: %+v", set.Error)
	}

	got := snippetCall(t, connectWS(t, ws), "uistate.get", map[string]any{}, 1)
	if got.Error != nil {
		t.Fatalf("uistate.get: %+v", got.Error)
	}
	var layout struct {
		Sidebar struct {
			Collapsed    bool   `json:"collapsed"`
			ActiveViewID string `json:"activeViewId"`
			Width        int    `json:"width"`
		} `json:"sidebar"`
		ActiveTab string `json:"activeTab"`
	}
	if err := json.Unmarshal(got.Result, &layout); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !layout.Sidebar.Collapsed || layout.Sidebar.ActiveViewID != "ports" || layout.Sidebar.Width != 320 {
		t.Fatalf("sidebar came back as %+v, want what was set", layout.Sidebar)
	}
	if layout.ActiveTab != "pane-3" {
		t.Fatalf("activeTab = %q, want pane-3", layout.ActiveTab)
	}
}

// The stored value is what comes back, not the sent one. A renderer that never
// learns its width was clamped holds a number nobody will ever read back —
// which is the defect that bought the whole contracts directory.
func TestUIStateSetAnswersWithTheStoredWidth(t *testing.T) {
	ws, _, stop := newUIStateWSServer(t)
	defer stop()

	resp := snippetCall(t, connectWS(t, ws), "uistate.set", map[string]any{
		"sidebar":   map[string]any{"collapsed": false, "activeViewId": "", "width": 99999},
		"activeTab": "",
	}, 1)
	if resp.Error != nil {
		t.Fatalf("uistate.set: %+v", resp.Error)
	}
	var layout struct {
		Sidebar struct {
			Width int `json:"width"`
		} `json:"sidebar"`
	}
	if err := json.Unmarshal(resp.Result, &layout); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if layout.Sidebar.Width != uistate.MaxSidebarWidth {
		t.Fatalf("width came back %d, want it clamped to %d", layout.Sidebar.Width, uistate.MaxSidebarWidth)
	}
}

// The unwired configuration — cmd/devharness and the dev-web harness build a
// server without the store. The methods must say so rather than pretending.
func TestUIStateUnwiredIsMethodNotFound(t *testing.T) {
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	resp := snippetCall(t, connectWS(t, ws), "uistate.get", map[string]any{}, 1)
	if resp.Error == nil {
		t.Fatal("an unwired uistate answered a result")
	}
	if resp.Error.Code != -32601 {
		t.Fatalf("error code = %d, want -32601", resp.Error.Code)
	}
}
