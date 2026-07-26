package transport

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/settings"
	"github.com/shady2k/nocx/internal/storage"
)

// ── test-only declarations ─────────────────────────────────────────────

func f64ptr(v float64) *float64 { return &v }

var testSecretKey = settings.MustRegisterSecret(settings.SecretSpec{
	Key:         "test.secret",
	Section:     "Test",
	Label:       "Test Secret",
	Description: "A test secret setting for transport-level tests.",
	DataClass:   settings.SecretAuthenticator,
})

var testNumberKey = settings.MustRegisterNumber(settings.NumberSpec{
	Key:         "test.number",
	Section:     "Test",
	Label:       "Test Number",
	Description: "A test number setting with bounds.",
	DataClass:   settings.PublicConfig,
	Default:     50,
	Min:         f64ptr(0),
	Max:         f64ptr(100),
})

// ── fake secret store ──────────────────────────────────────────────────

type fakeSecretStore struct {
	mu   sync.Mutex
	data map[credential.SecretID]string
}

func (f *fakeSecretStore) Get(id credential.SecretID) (credential.Secret, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if v, ok := f.data[id]; ok {
		return credential.NewSecret(v), nil
	}
	return credential.Secret{}, nil
}

func (f *fakeSecretStore) Set(id credential.SecretID, value credential.Secret) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.data == nil {
		f.data = make(map[credential.SecretID]string)
	}
	var s string
	if err := value.Use(func(b []byte) error { s = string(b); return nil }); err != nil {
		return err
	}
	f.data[id] = s
	return nil
}

func (f *fakeSecretStore) Delete(id credential.SecretID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.data, id)
	return nil
}

func (f *fakeSecretStore) Exists(id credential.SecretID) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.data[id]
	return ok, nil
}

// ── helpers ────────────────────────────────────────────────────────────

func newSettingsWSServer(t *testing.T) (*WSServer, func()) {
	t.Helper()
	dir := t.TempDir()
	docStore := storage.NewDocumentStore(dir)
	secretStore := &fakeSecretStore{}
	reg := settings.New(docStore, secretStore)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithSettingsRegistry(reg))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return ws, func() { _ = ws.Stop(ctx) }
}

type rpcEnvelope struct {
	Result json.RawMessage  `json:"result,omitempty"`
	Error  *jsonrpcErrorObj `json:"error,omitempty"`
}

// ── settings.describe ──────────────────────────────────────────────────

func TestSettingsDescribe_ReturnsDeclarations(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.describe", map[string]any{})
	var env struct {
		Result struct {
			Declarations []settings.Declaration `json:"declarations"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}
	if len(env.Result.Declarations) == 0 {
		t.Fatal("expected at least one declaration")
	}
	// The OSC 52 suppressed declaration must be present.
	found := false
	for _, d := range env.Result.Declarations {
		if d.Key == "clipboard.osc52Suppressed" {
			found = true
			if d.Control != "toggle" {
				t.Errorf("clipboard.osc52Suppressed control = %q, want toggle", d.Control)
			}
		}
	}
	if !found {
		t.Error("clipboard.osc52Suppressed not found in declarations")
	}
}

// ── settings.getAll ────────────────────────────────────────────────────

func TestSettingsGetAll_ContainsNoSecret(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.getAll", map[string]any{})
	var env struct {
		Result struct {
			Values map[string]any `json:"values"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}
	// No secret-class key may appear.
	for _, d := range settings.Descriptors() {
		if d.Control() == "secret" {
			if _, ok := env.Result.Values[d.Key()]; ok {
				t.Errorf("secret key %q found in getAll values", d.Key())
			}
		}
	}
}

func TestSettingsGetAll_ReturnsDefaults(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.getAll", map[string]any{})
	var env struct {
		Result struct {
			Values map[string]any `json:"values"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}
	v, ok := env.Result.Values["clipboard.osc52Suppressed"]
	if !ok {
		t.Fatal("clipboard.osc52Suppressed missing from getAll defaults")
	}
	bv, ok := v.(bool)
	if !ok || bv {
		t.Errorf("expected default false, got %v (%T)", v, v)
	}
}

// ── settings.set ───────────────────────────────────────────────────────

func TestSettingsSet_SetsAndGetsBool(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.set", map[string]any{
		"key":   "clipboard.osc52Suppressed",
		"value": true,
	})
	var env struct {
		Result struct {
			OK bool `json:"ok"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}
	if !env.Result.OK {
		t.Fatal("expected ok: true")
	}
}

func TestSettingsSet_RejectsSecret(t *testing.T) {
	// settings.set MUST refuse a control:'secret' key.  Secrets go
	// through settings.secretSet, never through settings.set.
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.set", map[string]any{
		"key":   testSecretKey.Key(),
		"value": "should-fail",
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error when settings.set called on secret key")
	}
	if env.Error.Code != -32602 {
		t.Errorf("expected code -32602 (Invalid params), got %d", env.Error.Code)
	}
}

func TestSettingsSet_ValidationErrorIsJSONRPCError(t *testing.T) {
	// A *settings.ValidationError from the registry becomes a JSON-RPC
	// error with code -32602, not {ok: false}.
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Set test.number to a value outside [0, 100] to trigger validation.
	resp := jsonrpcCall(t, conn, "settings.set", map[string]any{
		"key":   testNumberKey.Key(),
		"value": float64(200),
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error for out-of-range number, got success")
	}
	if env.Error.Code != -32602 {
		t.Errorf("expected code -32602 (Invalid params), got %d", env.Error.Code)
	}
}

func TestSettingsSet_UnknownKey(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.set", map[string]any{
		"key":   "nonexistent.key",
		"value": true,
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error for unknown key")
	}
	if env.Error.Code != -32602 {
		t.Errorf("expected code -32602 (Invalid params), got %d", env.Error.Code)
	}
}

// ── settings.reset ─────────────────────────────────────────────────────

func TestSettingsReset_RestoresDefault(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Set to true, then reset.
	jsonrpcCall(t, conn, "settings.set", map[string]any{
		"key":   "clipboard.osc52Suppressed",
		"value": true,
	})
	resp := jsonrpcCall(t, conn, "settings.reset", map[string]any{
		"key": "clipboard.osc52Suppressed",
	})
	var env struct {
		Result struct {
			OK bool `json:"ok"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}
	if !env.Result.OK {
		t.Fatal("expected ok: true")
	}
}

func TestSettingsReset_UnknownKey(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.reset", map[string]any{
		"key": "nonexistent.key",
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error for unknown key")
	}
	if env.Error.Code != -32602 {
		t.Errorf("expected code -32602 (Invalid params), got %d", env.Error.Code)
	}
}

func TestSettingsReset_RejectsSecret(t *testing.T) {
	// Reset on a control:'secret' returns ValidationError → JSON-RPC error -32602.
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.reset", map[string]any{
		"key": testSecretKey.Key(),
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error when resetting a secret key")
	}
	if env.Error.Code != -32602 {
		t.Errorf("expected code -32602 (Invalid params), got %d", env.Error.Code)
	}
}

// ── settings.secretSet / secretDelete / secretExists ───────────────────

func TestSettingsSecretSetDeleteExists(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// secretSet on a real secret key.
	resp := jsonrpcCall(t, conn, "settings.secretSet", map[string]any{
		"key":   testSecretKey.Key(),
		"value": "my-secret-value",
	})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal secretSet: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error on secretSet: code=%d msg=%s", env.Error.Code, env.Error.Message)
	}

	// secretExists should report true.
	resp2 := jsonrpcCall(t, conn, "settings.secretExists", map[string]any{
		"key": testSecretKey.Key(),
	})
	var existEnv struct {
		Result struct {
			Exists bool `json:"exists"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp2, &existEnv); err != nil {
		t.Fatalf("unmarshal secretExists: %v", err)
	}
	if existEnv.Error != nil {
		t.Fatalf("unexpected error on secretExists: code=%d msg=%s", existEnv.Error.Code, existEnv.Error.Message)
	}
	if !existEnv.Result.Exists {
		t.Fatal("expected exists: true after secretSet")
	}

	// secretDelete.
	resp3 := jsonrpcCall(t, conn, "settings.secretDelete", map[string]any{
		"key": testSecretKey.Key(),
	})
	var delEnv struct {
		Result struct {
			OK bool `json:"ok"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp3, &delEnv); err != nil {
		t.Fatalf("unmarshal secretDelete: %v", err)
	}
	if delEnv.Error != nil {
		t.Fatalf("unexpected error on secretDelete: code=%d msg=%s", delEnv.Error.Code, delEnv.Error.Message)
	}
	if !delEnv.Result.OK {
		t.Fatal("expected ok: true after secretDelete")
	}

	// secretExists should now report false.
	resp4 := jsonrpcCall(t, conn, "settings.secretExists", map[string]any{
		"key": testSecretKey.Key(),
	})
	var existEnv2 struct {
		Result struct {
			Exists bool `json:"exists"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp4, &existEnv2); err != nil {
		t.Fatalf("unmarshal secretExists: %v", err)
	}
	if existEnv2.Result.Exists {
		t.Fatal("expected exists: false after secretDelete")
	}
}

func TestSettingsSecretMethods_UnknownKey(t *testing.T) {
	ws, cleanup := newSettingsWSServer(t)
	defer cleanup()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	for _, method := range []string{"settings.secretSet", "settings.secretDelete", "settings.secretExists"} {
		params := map[string]any{"key": "nonexistent.secret"}
		if method == "settings.secretSet" {
			params["value"] = "v"
		}
		resp := jsonrpcCall(t, conn, method, params)
		var env rpcEnvelope
		if err := json.Unmarshal(resp, &env); err != nil {
			t.Fatalf("%s unmarshal: %v", method, err)
		}
		if env.Error == nil {
			t.Errorf("%s: expected JSON-RPC error for unknown key, got success", method)
		} else if env.Error.Code != -32602 {
			t.Errorf("%s: expected code -32602, got %d", method, env.Error.Code)
		}
	}
}

// ── not wired ──────────────────────────────────────────────────────────

func TestSettingsDescribe_MethodNotFound_WhenNotWired(t *testing.T) {
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "settings.describe", map[string]any{})
	var env rpcEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Error == nil {
		t.Fatal("expected JSON-RPC error when settings not wired")
	}
	if env.Error.Code != -32601 {
		t.Errorf("expected code -32601 (Method not found), got %d", env.Error.Code)
	}
}

// ── validation error unwrap ────────────────────────────────────────────

func TestSettingsSet_ValidationErrorUnwraps(t *testing.T) {
	if !errors.Is(settings.ErrValidation, settings.ErrValidation) {
		t.Fatal("settings.ErrValidation does not satisfy errors.Is with itself")
	}
	ve := &settings.ValidationError{SettingKey: "test", Value: "bad", Message: "invalid"}
	if !errors.Is(ve, settings.ErrValidation) {
		t.Fatal("ValidationError does not unwrap to ErrValidation")
	}
}
