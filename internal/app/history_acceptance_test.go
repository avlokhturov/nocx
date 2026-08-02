package app

// The composition-root acceptance for the ContentDB key (nocx-rtg0.14) and
// the write path (nocx-rtg0.13), in the owner's words:
//
//	Run a command. Restart. Press Up. The command is there, and the panel
//	says source: store.
//
// On a host with NO OS keystore and a SEALED vault — the vault is never
// unsealed anywhere in this test, so it cannot be anything but sealed — the
// app must come up with the REAL store, never the stub, and a command
// recorded over the real socket must be readable after a full restart of
// the composition root. The seal is irrelevant: neither branch of the key
// lifecycle touches it, which is exactly what used to fail here ("content
// key: probe \"file\": vault is sealed").

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gorilla/websocket"
)

func TestHistory_NoKeystoreSealedVault_RecordSurvivesRestart(t *testing.T) {
	cfgHome := t.TempDir()
	dataHome := t.TempDir()
	cacheHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfgHome)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("XDG_CACHE_HOME", cacheHome)
	noKeystore := func(context.Context) bool { return false }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a, err := New(WithKeystoreProbe(noKeystore))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if startErr := a.Start(ctx); startErr != nil {
		t.Fatalf("Start: %v", startErr)
	}

	// The derived-key artifacts landed where the design says: the salt in
	// the CONFIG directory — a copy of the data directory carries nothing
	// that opens it — and the database in the DATA directory.
	saltPath := filepath.Join(cfgHome, "nocx", "contentkey.salt")
	if _, statErr := os.Stat(saltPath); statErr != nil {
		t.Fatalf("salt not minted in config dir: %v", statErr)
	}
	dbPath := filepath.Join(dataHome, "nocx", "content.db")
	if _, statErr := os.Stat(dbPath); statErr != nil {
		t.Fatalf("content.db not created in data dir: %v", statErr)
	}

	// Run a command: the frontend's exact call over the real socket.
	conn := dialAppWS(t, a)
	if resp := callAppWS(t, conn, "history.record", map[string]any{
		"command":   "echo survived",
		"cwd":       "/srv",
		"host":      "",
		"status":    "success",
		"exitCode":  0,
		"startedAt": int64(1_750_000_000_000),
		"endedAt":   int64(1_750_000_000_100),
		"trusted":   true,
	}, 1); resp.Error != nil {
		t.Fatalf("history.record: %+v", resp.Error)
	}
	_ = conn.Close()

	// Restart: shut the first composition root down and build a second one
	// over the same directories — the process equivalent of quitting and
	// relaunching the app.
	a.Shutdown(ctx)
	a2, err := New(WithKeystoreProbe(noKeystore))
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	if startErr := a2.Start(ctx); startErr != nil {
		t.Fatalf("Start after restart: %v", startErr)
	}
	defer a2.Shutdown(ctx)

	// Press Up: the recall overlay's exact call. The command is there, and
	// the panel says source: store — the row came from the database, not
	// from this session.
	conn2 := dialAppWS(t, a2)
	defer func() { _ = conn2.Close() }()
	resp := callAppWS(t, conn2, "history.query", map[string]any{
		"scope": "directory", "cwd": "/srv", "host": "", "limit": 50,
	}, 2)
	if resp.Error != nil {
		t.Fatalf("history.query after restart: %+v", resp.Error)
	}
	var q struct {
		Entries []struct {
			Command string `json:"command"`
			Status  string `json:"status"`
		} `json:"entries"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(resp.Result, &q); err != nil {
		t.Fatalf("decode query result: %v (raw %s)", err, resp.Result)
	}
	if q.Source != "store" {
		t.Fatalf("source = %q, want store (the panel must say the row came from the store)", q.Source)
	}
	if len(q.Entries) != 1 || q.Entries[0].Command != "echo survived" {
		t.Fatalf("entries = %+v, want the recorded command after restart", q.Entries)
	}
	if q.Entries[0].Status != "success" {
		t.Fatalf("status = %q, want success", q.Entries[0].Status)
	}
}

// ── helpers: the real socket, the real token, the real JSON-RPC ───────────

type wsRPCResult struct {
	ID     int             `json:"id,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func dialAppWS(t *testing.T, a *App) *websocket.Conn {
	t.Helper()
	u := url.URL{Scheme: "ws", Host: fmt.Sprintf("127.0.0.1:%d", a.WSPort()), Path: "/session"}
	d := websocket.Dialer{Subprotocols: []string{"nocx.token." + a.WSToken()}}
	conn, _, err := d.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

func callAppWS(t *testing.T, conn *websocket.Conn, method string, params map[string]any, id int) *wsRPCResult {
	t.Helper()
	req, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if writeErr := conn.WriteMessage(websocket.TextMessage, req); writeErr != nil {
		t.Fatalf("write %s: %v", method, writeErr)
	}
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read %s response: %v", method, err)
	}
	var resp wsRPCResult
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decode %s response: %v (raw %s)", method, err, raw)
	}
	return &resp
}
