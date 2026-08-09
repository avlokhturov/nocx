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

	a, err := New(WithKeystoreProbe(func(context.Context) bool { return false }))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := a.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer a.Shutdown(ctx)

	conn := dialAppWS(t, a)
	defer func() { _ = conn.Close() }()

	created := callAppWS(t, conn, "backup.create", map[string]any{}, 1)
	if created.Error != nil {
		t.Fatalf("backup.create: %+v", created.Error)
	}
	var backup struct {
		Contents string `json:"contents"`
	}
	if err := json.Unmarshal(created.Result, &backup); err != nil {
		t.Fatalf("decode backup.create: %v", err)
	}
	if backup.Contents == "" {
		t.Fatal("backup.create returned empty contents")
	}

	preview := callAppWS(t, conn, "backup.preview", map[string]any{
		"contents": backup.Contents,
		"strategy": "merge",
	}, 2)
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
	}, 3)
	if restored.Error != nil {
		t.Fatalf("backup.restore: %+v", restored.Error)
	}
}
