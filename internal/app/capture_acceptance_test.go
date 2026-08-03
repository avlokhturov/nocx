package app

// The capture round's acceptance over the REAL composition root and the
// real socket (the brief's words): submit a command carrying a key, get a
// capture id back, save it, and read the history row as a reference — then
// repeat with the capture expired and read it as a structured redaction.
// The vault is set up with a passphrase (no keystore on this host), so the
// save path runs against the real file provider and the real encrypted
// content store.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestCapture_SaveAndExpiryOverTheRealSocket(t *testing.T) {
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
	defer a.Shutdown(ctx)

	conn := dialAppWS(t, a)
	defer func() { _ = conn.Close() }()

	// The vault needs to be unsealed before a save can create a secret:
	// passphrase setup (the no-keystore host has no OS key).
	setup := callAppWS(t, conn, "vault.setup", map[string]any{"passphrase": "correct horse battery staple"}, 1)
	if setup.Error != nil {
		t.Fatalf("vault.setup: %+v", setup.Error)
	}

	// ── leg 1: submit a key, save it, read the row as a reference ────────
	record := callAppWS(t, conn, "history.record", map[string]any{
		"command": `curl -H "Authorization: Bearer sk-proj-abcdef1234567890" https://openrouter.ai/api`,
		"cwd":     "/srv", "host": "", "status": "success", "exitCode": 0,
		"startedAt": int64(1_750_000_000_000), "endedAt": int64(1_750_000_000_100), "trusted": true,
	}, 2)
	if record.Error != nil {
		t.Fatalf("history.record: %+v", record.Error)
	}
	var ack struct {
		EntryID     string `json:"entryId"`
		MaskedCount int    `json:"maskedCount"`
		Redactions  []struct {
			Kind  string `json:"kind"`
			Start int    `json:"start"`
			End   int    `json:"end"`
		} `json:"redactions"`
		Captures []struct {
			ID            string `json:"id"`
			SuggestedName string `json:"suggestedName"`
		} `json:"captures"`
	}
	if err := json.Unmarshal(record.Result, &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if ack.MaskedCount != 1 || len(ack.Captures) != 1 {
		t.Fatalf("ack = %+v, want one mask and one offer", ack)
	}
	if ack.Captures[0].SuggestedName != "openrouter.ai" {
		t.Errorf("suggestedName = %q, want the host openrouter.ai", ack.Captures[0].SuggestedName)
	}
	if ack.EntryID == "" {
		t.Fatal("entryId is empty")
	}

	save := callAppWS(t, conn, "secrets.captureSave", map[string]any{"captureId": ack.Captures[0].ID}, 3)
	if save.Error != nil {
		t.Fatalf("secrets.captureSave: %+v", save.Error)
	}
	var saved struct {
		Name    string `json:"name"`
		Partial bool   `json:"partial"`
	}
	if err := json.Unmarshal(save.Result, &saved); err != nil {
		t.Fatalf("decode save: %v", err)
	}
	if saved.Name != "openrouter.ai" {
		t.Errorf("saved name = %q, want the real name", saved.Name)
	}
	if saved.Partial {
		t.Error("save reported partial, want the full success")
	}

	// Read the row back: it is a reference now, and the raw key is nowhere.
	q := callAppWS(t, conn, "history.query", map[string]any{
		"scope": "directory", "cwd": "/srv", "host": "", "limit": 50,
	}, 4)
	if q.Error != nil {
		t.Fatalf("history.query: %+v", q.Error)
	}
	var page struct {
		Entries []struct {
			Command    string `json:"command"`
			Redactions []struct {
				Kind string `json:"kind"`
			} `json:"redactions"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(q.Result, &page); err != nil {
		t.Fatalf("decode query: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %+v, want the one recorded row", page.Entries)
	}
	if !strings.Contains(page.Entries[0].Command, "{{secret:openrouter.ai}}") {
		t.Errorf("row command = %q, want the vault reference", page.Entries[0].Command)
	}
	if len(page.Entries[0].Redactions) != 0 {
		t.Errorf("row redactions = %+v, want the saved segment gone", page.Entries[0].Redactions)
	}

	// ── leg 2: a key whose capture dies before it is saved ───────────────
	// A second submission from the same tab supersedes only PENDING
	// captures; the saved one above is settled and untouched.
	//
	// This leg used to wait out the real expiry — 32 seconds of wall clock
	// in the suite for a timer whose behaviour internal/credential already
	// pins with an injected clock. It asserts the same thing through the
	// destruction path a person actually triggers: submit the next command,
	// and the previous command's pending capture is gone.
	record2 := callAppWS(t, conn, "history.record", map[string]any{
		"command": "TOKEN=abcdefghijklmnopqrstuvwxyz123456 ./run.sh",
		"cwd":     "/srv", "host": "", "status": "success", "exitCode": 0,
		"startedAt": int64(1_750_000_000_200), "endedAt": int64(1_750_000_000_300), "trusted": true,
	}, 5)
	if record2.Error != nil {
		t.Fatalf("history.record (leg 2): %+v", record2.Error)
	}
	var ack2 struct {
		Captures []struct {
			ID string `json:"id"`
		} `json:"captures"`
		Redactions []struct {
			Kind   string `json:"kind"`
			Prefix string `json:"prefix"`
			Suffix string `json:"suffix"`
		} `json:"redactions"`
	}
	if err := json.Unmarshal(record2.Result, &ack2); err != nil {
		t.Fatalf("decode ack2: %v", err)
	}
	if len(ack2.Captures) != 1 || len(ack2.Redactions) != 1 {
		t.Fatalf("ack2 = %+v, want one capture and one structured redaction", ack2)
	}

	// The next command from the same tab: leg 2's capture is superseded.
	record3 := callAppWS(t, conn, "history.record", map[string]any{
		"command": "echo done",
		"cwd":     "/srv", "host": "", "status": "success", "exitCode": 0,
		"startedAt": int64(1_750_000_000_400), "endedAt": int64(1_750_000_000_500), "trusted": true,
	}, 8)
	if record3.Error != nil {
		t.Fatalf("history.record (leg 3): %+v", record3.Error)
	}

	expired := callAppWS(t, conn, "secrets.captureSave", map[string]any{"captureId": ack2.Captures[0].ID}, 6)
	if expired.Error == nil {
		t.Fatal("save of a destroyed capture must fail")
	}
	if expired.Error.Code != -32010 {
		t.Errorf("expired save code = %d, want -32010 (capture-expired)", expired.Error.Code)
	}

	// The row still carries the structured redaction — expiry never
	// rewrites a masked history entry.
	q2 := callAppWS(t, conn, "history.query", map[string]any{
		"scope": "directory", "cwd": "/srv", "host": "", "limit": 50,
	}, 7)
	if q2.Error != nil {
		t.Fatalf("history.query (leg 2): %+v", q2.Error)
	}
	var page2 struct {
		Entries []struct {
			Command     string `json:"command"`
			MaskedCount int    `json:"maskedCount"`
			Redactions  []struct {
				Kind   string `json:"kind"`
				Prefix string `json:"prefix"`
				Suffix string `json:"suffix"`
			} `json:"redactions"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(q2.Result, &page2); err != nil {
		t.Fatalf("decode query2: %v", err)
	}
	var expiredRow *struct {
		Command     string `json:"command"`
		MaskedCount int    `json:"maskedCount"`
		Redactions  []struct {
			Kind   string `json:"kind"`
			Prefix string `json:"prefix"`
			Suffix string `json:"suffix"`
		} `json:"redactions"`
	}
	for i := range page2.Entries {
		if strings.HasPrefix(page2.Entries[i].Command, "TOKEN=") {
			expiredRow = &page2.Entries[i]
			break
		}
	}
	if expiredRow == nil {
		t.Fatal("the leg-2 row is missing from history")
	}
	if !strings.Contains(expiredRow.Command, "TOKEN=abcd...3456") {
		t.Errorf("leg-2 command = %q, want the masked form", expiredRow.Command)
	}
	if len(expiredRow.Redactions) != 1 || expiredRow.Redactions[0].Kind != "env-assignment" {
		t.Errorf("leg-2 redactions = %+v, want the structured segment (kind env-assignment)", expiredRow.Redactions)
	}
	if expiredRow.Redactions[0].Prefix != "abcd" || expiredRow.Redactions[0].Suffix != "3456" {
		t.Errorf("leg-2 prefix/suffix = %q/%q, want the mask's head/tail", expiredRow.Redactions[0].Prefix, expiredRow.Redactions[0].Suffix)
	}
}

// wsRPCResult, dialAppWS and callAppWS are shared with the history
// acceptance tests in history_acceptance_test.go.
var _ = websocket.TextMessage
