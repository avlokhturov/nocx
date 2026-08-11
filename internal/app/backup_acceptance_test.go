package app

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/shady2k/nocx/internal/storage/storagetest"
)

func TestBackup_RoundTripThroughRealSocket(t *testing.T) {
	storagetest.Isolate(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a, newErr := New(WithKeystoreProbe(func(context.Context) bool { return false }))
	if newErr != nil {
		t.Fatalf("New: %v", newErr)
	}
	if err := a.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}

	conn := dialAppWS(t, a)

	// ── Seed non-empty state ──────────────────────────────────────────
	// Create a real profile.
	createProf := callAppWS(t, conn, "profiles.create", map[string]any{
		"id": "ssh:custom:backup-test:0001", "name": "backup-test-host", "type": "ssh",
		"options": map[string]any{"host": "backup.example.com", "port": 2222, "user": "admin"},
	}, 1)
	if createProf.Error != nil {
		t.Fatalf("profiles.create: %+v", createProf.Error)
	}

	// Set a non-default setting value.
	setSetting := callAppWS(t, conn, "settings.set", map[string]any{
		"key": "tab.placement", "value": "vertical",
	}, 2)
	if setSetting.Error != nil {
		t.Fatalf("settings.set: %+v", setSetting.Error)
	}

	// ── Create backup with seeded state ──────────────────────────────
	created := callAppWS(t, conn, "backup.create", map[string]any{}, 3)
	if created.Error != nil {
		t.Fatalf("backup.create: %+v", created.Error)
	}
	var backup struct {
		Contents string `json:"contents"`
		Summary  struct {
			Connections int `json:"connections"`
			Settings    int `json:"settings"`
			Groups      int `json:"groups"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(created.Result, &backup); err != nil {
		t.Fatalf("decode backup.create: %v", err)
	}
	if backup.Contents == "" {
		t.Fatal("backup.create returned empty contents")
	}
	if backup.Summary.Connections < 1 {
		t.Errorf("backup summary connections = %d, want >= 1", backup.Summary.Connections)
	}
	if backup.Summary.Settings < 1 {
		t.Errorf("backup summary settings = %d, want >= 1", backup.Summary.Settings)
	}

	// ── Mutate state: rename profile, change setting ────────────────
	mutateProf := callAppWS(t, conn, "profiles.update", map[string]any{
		"id": "ssh:custom:backup-test:0001", "name": "mutated-name", "type": "ssh",
		"options": map[string]any{"host": "backup.example.com", "port": 2222, "user": "admin"},
	}, 4)
	if mutateProf.Error != nil {
		t.Fatalf("profiles.update (mutate): %+v", mutateProf.Error)
	}

	mutateSetting := callAppWS(t, conn, "settings.set", map[string]any{
		"key": "tab.placement", "value": "horizontal",
	}, 5)
	if mutateSetting.Error != nil {
		t.Fatalf("settings.set (mutate): %+v", mutateSetting.Error)
	}

	// ── Preview and restore ─────────────────────────────────────────
	preview := callAppWS(t, conn, "backup.preview", map[string]any{
		"contents": backup.Contents,
		"strategy": "merge",
	}, 6)
	if preview.Error != nil {
		t.Fatalf("backup.preview: %+v", preview.Error)
	}
	var previewResult struct {
		PreviewToken string `json:"previewToken"`
	}
	if err := json.Unmarshal(preview.Result, &previewResult); err != nil {
		t.Fatalf("decode backup.preview: %v", err)
	}
	if previewResult.PreviewToken == "" {
		t.Fatal("backup.preview returned empty token")
	}

	restored := callAppWS(t, conn, "backup.restore", map[string]any{
		"contents":     backup.Contents,
		"strategy":     "merge",
		"previewToken": previewResult.PreviewToken,
	}, 7)
	if restored.Error != nil {
		t.Fatalf("backup.restore: %+v", restored.Error)
	}

	// ── Verify live state after restore ─────────────────────────────
	listProf := callAppWS(t, conn, "profiles.list", map[string]any{}, 8)
	if listProf.Error != nil {
		t.Fatalf("profiles.list: %+v", listProf.Error)
	}
	var profiles []map[string]any
	if err := json.Unmarshal(listProf.Result, &profiles); err != nil {
		t.Fatalf("decode profiles.list: %v", err)
	}
	if len(profiles) < 1 {
		t.Fatal("no profiles after restore")
	}
	found := false
	for _, p := range profiles {
		if p["id"] == "ssh:custom:backup-test:0001" {
			if name, _ := p["name"].(string); name != "backup-test-host" {
				t.Errorf("restored profile name = %q, want %q", name, "backup-test-host")
			}
			found = true
			break
		}
	}
	if !found {
		t.Error("restored profile not found in list")
	}

	getSnap := callAppWS(t, conn, "settings.getSnapshot", map[string]any{}, 9)
	if getSnap.Error != nil {
		t.Fatalf("settings.getSnapshot: %+v", getSnap.Error)
	}
	var snapshot struct {
		Values map[string]any `json:"values"`
	}
	if err := json.Unmarshal(getSnap.Result, &snapshot); err != nil {
		t.Fatalf("decode settings.getSnapshot: %v", err)
	}
	if val := snapshot.Values["tab.placement"]; val != "vertical" {
		t.Errorf("restored tab.placement = %v, want vertical", val)
	}

	_ = conn.Close()

	// ── Persistence: reopen and verify state survives restart ──────
	a.Shutdown(ctx)

	a2, restartErr := New(WithKeystoreProbe(func(context.Context) bool { return false }))
	if restartErr != nil {
		t.Fatalf("New (restart): %v", restartErr)
	}
	if err := a2.Start(ctx); err != nil {
		t.Fatalf("Start (restart): %v", err)
	}
	defer a2.Shutdown(ctx)

	conn2 := dialAppWS(t, a2)
	defer func() { _ = conn2.Close() }()

	// After restart, the profile must still have the restored name.
	listProf2 := callAppWS(t, conn2, "profiles.list", map[string]any{}, 1)
	if listProf2.Error != nil {
		t.Fatalf("profiles.list (restart): %+v", listProf2.Error)
	}
	var profiles2 []map[string]any
	if err := json.Unmarshal(listProf2.Result, &profiles2); err != nil {
		t.Fatalf("decode profiles.list (restart): %v", err)
	}
	found2 := false
	for _, p := range profiles2 {
		if p["id"] == "ssh:custom:backup-test:0001" {
			if name, _ := p["name"].(string); name != "backup-test-host" {
				t.Errorf("persisted profile name = %q, want %q", name, "backup-test-host")
			}
			found2 = true
			break
		}
	}
	if !found2 {
		t.Error("restored profile not found after restart")
	}

	getSnap2 := callAppWS(t, conn2, "settings.getSnapshot", map[string]any{}, 2)
	if getSnap2.Error != nil {
		t.Fatalf("settings.getSnapshot (restart): %+v", getSnap2.Error)
	}
	var snapshot2 struct {
		Values map[string]any `json:"values"`
	}
	if err := json.Unmarshal(getSnap2.Result, &snapshot2); err != nil {
		t.Fatalf("decode settings.getSnapshot (restart): %v", err)
	}
	if val := snapshot2.Values["tab.placement"]; val != "vertical" {
		t.Errorf("persisted tab.placement = %v, want vertical", val)
	}
}
