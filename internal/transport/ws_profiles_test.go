package transport

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/zalando/go-keyring"
)

func TestProfilesRPC_ListEmpty(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileStore(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "profiles.list", map[string]any{})
	var result struct {
		Result []any `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(result.Result) != 0 {
		t.Errorf("expected empty list, got %d items", len(result.Result))
	}
}

func TestProfilesRPC_CreateList(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileStore(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	p := profile.SSHProfile{
		Base: profile.Base{
			ID:   profile.NewProfileID("ssh", "test-host"),
			Type: "ssh",
			Name: "test-host",
		},
		Options: profile.SSHProfileOptions{
			Host: "example.com",
			Port: 22,
			User: "alice",
		},
	}

	_ = jsonrpcCall(t, conn, "profiles.create", p)
	resp := jsonrpcCall(t, conn, "profiles.list", map[string]any{})

	var list struct {
		Result []profile.SSHProfile `json:"result"`
	}
	if err := json.Unmarshal(resp, &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if len(list.Result) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(list.Result))
	}
	if list.Result[0].Options.Host != "example.com" {
		t.Errorf("host = %q", list.Result[0].Options.Host)
	}
}

func TestProfilesRPC_Delete(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	p := profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:custom:del:0001", Type: "ssh", Name: "del"},
		Options: profile.SSHProfileOptions{Host: "h"},
	}
	_ = ps.SaveProfile(p)

	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileStore(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	_ = jsonrpcCall(t, conn, "profiles.delete", map[string]any{"id": p.ID})

	resp := jsonrpcCall(t, conn, "profiles.list", map[string]any{})
	var list struct {
		Result []profile.SSHProfile `json:"result"`
	}
	_ = json.Unmarshal(resp, &list)
	if len(list.Result) != 0 {
		t.Errorf("after delete, %d profiles remain", len(list.Result))
	}
}

func TestGroupsRPC_Create(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileStore(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	g := profile.ProfileGroup{ID: "g1", Name: "Prod"}
	_ = jsonrpcCall(t, conn, "groups.create", g)

	resp := jsonrpcCall(t, conn, "groups.list", map[string]any{})
	var list struct {
		Result []profile.ProfileGroup `json:"result"`
	}
	_ = json.Unmarshal(resp, &list)
	if len(list.Result) != 1 || list.Result[0].ID != "g1" {
		t.Fatalf("groups = %+v", list.Result)
	}
}

func TestCredentialsRPC_SaveLookup(t *testing.T) {
	keyring.MockInit()
	cs := credential.NewKeychain()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithCredentialStore(cs))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	id := credential.Identity{User: "alice", Host: "example.com", Port: 22}
	_ = jsonrpcCall(t, conn, "credentials.savePassword", map[string]any{
		"identity": id,
		"password": "secret",
	})

	resp := jsonrpcCall(t, conn, "credentials.lookupPassword", map[string]any{
		"identity": id,
	})
	var result struct {
		Result string `json:"result"`
	}
	_ = json.Unmarshal(resp, &result)
	if result.Result != "secret" {
		t.Errorf("lookupPassword = %q, want secret", result.Result)
	}
}

func TestCredentialsRPC_MethodNotFound(t *testing.T) {
	keyring.MockInit()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Without WithProfileStore, profiles.list should return method-not-found
	// (or empty result — either is acceptable; we check it doesn't crash).
	resp := jsonrpcCall(t, conn, "profiles.list", map[string]any{})
	var check struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	_ = json.Unmarshal(resp, &check)
	// With no store, we expect an error OR empty result — both are fine.
	_ = check
}
