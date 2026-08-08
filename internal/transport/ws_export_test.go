package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/settings"
	"github.com/shady2k/nocx/internal/storage"
)

// ── helpers ────────────────────────────────────────────────────────────

// recordingContentDB is a ContentDB whose write seams record what restore
// wrote, so the over-the-wire tests can assert what actually landed.
type recordingContentDB struct {
	convs   []content.Conversation
	history []content.CommandRecord
}

func (r *recordingContentDB) Conversations() content.ConversationRepository {
	return &recordingConvRepo{db: r}
}

func (r *recordingContentDB) CommandHistory() content.CommandHistoryRepository {
	return &recordingHistRepo{db: r}
}
func (r *recordingContentDB) Backup(context.Context, string) error { return nil }
func (r *recordingContentDB) Close() error                         { return nil }
func (r *recordingContentDB) RestorePrivate(_ context.Context, conversations []content.Conversation, history []content.CommandRecord) error {
	r.convs = append(r.convs, conversations...)
	r.history = append(r.history, history...)
	return nil
}

type recordingConvRepo struct{ db *recordingContentDB }

func (r *recordingConvRepo) Save(_ context.Context, c content.Conversation) error {
	r.db.convs = append(r.db.convs, c)
	return nil
}

func (r *recordingConvRepo) GetByID(context.Context, string) (*content.Conversation, error) {
	return nil, nil
}

func (r *recordingConvRepo) List(context.Context, int) ([]content.Conversation, error) {
	return r.db.convs, nil
}

type recordingHistRepo struct{ db *recordingContentDB }

func (r *recordingHistRepo) Add(_ context.Context, rec content.CommandRecord) (int64, error) {
	r.db.history = append(r.db.history, rec)
	return 0, nil
}

func (r *recordingHistRepo) RewriteRedaction(_ context.Context, _ int64, _ content.Redaction, _ string) error {
	return nil
}

func (r *recordingHistRepo) GetByID(context.Context, int64) (*content.CommandRecord, error) {
	return nil, nil
}

func (r *recordingHistRepo) FindByPrefix(context.Context, string, int) ([]content.CommandRecord, error) {
	return nil, nil
}

func (r *recordingHistRepo) List(context.Context, int) ([]content.CommandRecord, error) {
	return r.db.history, nil
}

func (r *recordingHistRepo) Query(context.Context, content.Scope, string, string, int, *int64, string) (content.HistoryPage, error) {
	return content.HistoryPage{}, nil
}

// newExportWSServer wires a profile store, its service, a settings registry
// and an export ContentDB, and returns the server plus handles for asserting
// on what an import wrote.
func newExportWSServer(t *testing.T, contentDB content.ContentDB) (*WSServer, *profile.JSONStore, *settings.Registry, func()) {
	t.Helper()
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	reg := settings.New(storage.NewDocumentStore(dir), &fakeSecretStore{})
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithProfileService(svc),
		WithSettingsRegistry(reg),
		WithExportContentDB(contentDB))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return ws, ps, reg, func() { _ = ws.Stop(ctx) }
}

func exportCall(t *testing.T, conn *websocket.Conn, method string, params any) rpcEnvelope {
	t.Helper()
	raw := jsonrpcCall(t, conn, method, params)
	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal %s response: %v", method, err)
	}
	return env
}

// The real handlers through the real socket: a payload is sent, a result
// comes back, and the result satisfies the schema. Nothing here names a
// field, so nothing here can silently omit one.
func TestExportImport_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "export.import.schema.json")
	ws, _, _, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.import", map[string]any{
		"data": map[string]any{
			"profiles": []any{map[string]any{
				"id": "ssh:wire:0001", "type": "ssh", "name": "Wire Host",
				"options": map[string]any{"host": "wire.example.com", "port": 22},
			}},
			"groups": []any{},
		},
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	validateJSON(t, schema, resp.Result, "export.import result")
}

func TestExportImportPortable_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "export.importPortable.schema.json")
	ws, _, _, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Build a real passphrase-encrypted backup through the export package,
	// the way the renderer would have received it from export.portableEncrypted.
	enc, err := export.ExportPortableEncrypted(export.PortableEncryptedDeps{
		ConfigExport: export.ConfigExportDeps{
			Profiles: &wireProfileRepo{},
			Groups:   &wireGroupRepo{},
		},
		ContentDB: content.NewStub(log.NewSlogAdapter(nil)),
	}, "wire-pass", false)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}

	resp := exportCall(t, conn, "export.importPortable", map[string]any{
		"payload":    base64.StdEncoding.EncodeToString(enc.Payload),
		"passphrase": "wire-pass",
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	validateJSON(t, schema, resp.Result, "export.importPortable result")
}

// ── settings are restored, not dropped (nocx-ojxa) ─────────────────────

func TestExportImport_RestoresSettingsOverTheWire(t *testing.T) {
	ws, _, reg, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.import", map[string]any{
		"data": map[string]any{
			"profiles": []any{},
			"groups":   []any{},
			"settings": map[string]any{
				"history.enabled":       true,
				"history.retentionDays": float64(90),
				"tab.placement":         "vertical",
			},
		},
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	if got, _ := reg.GetBool(settings.HistoryEnabled); !got {
		t.Error("history.enabled was not restored")
	}
	if got, _ := reg.GetNumber(settings.HistoryRetentionDays); got != 90 {
		t.Errorf("history.retentionDays = %v, want 90", got)
	}
	if got, _ := reg.GetSelect(settings.TabPlacement); got != "vertical" {
		t.Errorf("tab.placement = %q, want vertical", got)
	}
}

// A renderer-forged secret reference must not survive import over the wire
// (nocx-jb20.1): the resolver honours references at connect time, so a
// reference that lands in storage is a reference spent against the caller's
// host.
func TestExportImport_StripsForgedSecretRefsOverTheWire(t *testing.T) {
	ws, ps, _, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.import", map[string]any{
		"data": map[string]any{
			"profiles": []any{map[string]any{
				"id": "ssh:forged:0001", "type": "ssh", "name": "Forged",
				"options": map[string]any{
					"host":                "attacker.example.com",
					"passwordSecret":      "sec:v1:victim-password",
					"keySecret":           "sec:v1:victim-key",
					"keyPassphraseSecret": "sec:v1:victim-passphrase",
				},
			}},
			"groups": []any{},
		},
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	stored, err := ps.LoadProfiles()
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("stored profiles = %d, want 1", len(stored))
	}
	if stored[0].Options.PasswordSecret != "" ||
		stored[0].Options.KeySecret != "" ||
		stored[0].Options.KeyPassphraseSecret != "" {
		t.Errorf("forged secret references persisted: %+v", stored[0].Options)
	}
}

// A settings key the receiving build does not know fails the import loudly
// rather than being dropped: silent loss is the defect (nocx-ojxa).
func TestExportImport_UnknownSettingsKeyRejected(t *testing.T) {
	ws, ps, _, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.import", map[string]any{
		"data": map[string]any{
			"profiles": []any{},
			"groups":   []any{},
			"settings": map[string]any{"no.such.setting": true},
		},
	})
	if resp.Error == nil {
		t.Fatal("import with unknown settings key succeeded, want error")
	}
	// The profile import itself must not have happened either — the call
	// failed, so the receiving machine is unchanged apart from what the
	// caller's payload named.
	if _, err := ps.LoadProfiles(); err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
}

// ── portable import restores private content (nocx-ojxa) ───────────────

func TestExportImportPortable_RestoresPrivateContentOverTheWire(t *testing.T) {
	src := &recordingContentDB{
		convs: []content.Conversation{{
			ID: "conv-1", Title: "Debugging", CreatedAt: 1700000000000,
			Messages: []content.Message{{Role: "user", Content: "why slow", Timestamp: 1700000000000}},
		}},
		history: []content.CommandRecord{{
			Command: "ssh prod", Cwd: "/home/dev", Host: "local",
			Status: content.StatusSuccess,
		}},
	}
	// Machine A: build the backup with private content included.
	enc, err := export.ExportPortableEncrypted(export.PortableEncryptedDeps{
		ConfigExport: export.ConfigExportDeps{
			Profiles: &wireProfileRepo{},
			Groups:   &wireGroupRepo{},
		},
		ContentDB: src,
	}, "pass", true)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}

	// Machine B: restore it.
	dst := &recordingContentDB{}
	ws, _, _, cleanup := newExportWSServer(t, dst)
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.importPortable", map[string]any{
		"payload":    base64.StdEncoding.EncodeToString(enc.Payload),
		"passphrase": "pass",
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	if len(dst.convs) != 1 || dst.convs[0].ID != "conv-1" || dst.convs[0].Title != "Debugging" {
		t.Errorf("conversation not restored: %+v", dst.convs)
	}
	if len(dst.history) != 1 || dst.history[0].Command != "ssh prod" {
		t.Errorf("command history not restored: %+v", dst.history)
	}
}

// A backup that carries private content restored onto a machine with no
// store for it fails the whole call — success would be the lie that a
// silent drop is (nocx-ojxa).
func TestExportImportPortable_StubStoreFailsOnCarriedContent(t *testing.T) {
	src := &recordingContentDB{history: []content.CommandRecord{{Command: "ssh prod"}}}
	enc, err := export.ExportPortableEncrypted(export.PortableEncryptedDeps{
		ConfigExport: export.ConfigExportDeps{
			Profiles: &wireProfileRepo{},
			Groups:   &wireGroupRepo{},
		},
		ContentDB: src,
	}, "pass", true)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}

	ws, _, _, cleanup := newExportWSServer(t, content.NewStub(log.NewSlogAdapter(nil)))
	defer cleanup()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := exportCall(t, conn, "export.importPortable", map[string]any{
		"payload":    base64.StdEncoding.EncodeToString(enc.Payload),
		"passphrase": "pass",
	})
	if resp.Error == nil {
		t.Fatal("import of private-content backup onto a stub store succeeded, want error")
	}
}

// wireProfileRepo and wireGroupRepo are the minimal empty repositories the
// export package needs to build a payload without a real store.
type wireProfileRepo struct{}

func (r *wireProfileRepo) LoadProfiles() ([]profile.SSHProfile, error) { return nil, nil }
func (r *wireProfileRepo) CreateProfile(profile.SSHProfile) error      { return nil }
func (r *wireProfileRepo) UpdateProfile(profile.SSHProfile) error      { return nil }
func (r *wireProfileRepo) DeleteProfile(string) error                  { return nil }

type wireGroupRepo struct{}

func (r *wireGroupRepo) LoadGroups() ([]profile.ProfileGroup, error) { return nil, nil }
func (r *wireGroupRepo) CreateGroup(profile.ProfileGroup) error      { return nil }
func (r *wireGroupRepo) UpdateGroup(profile.ProfileGroup) error      { return nil }
func (r *wireGroupRepo) DeleteGroup(string) error                    { return nil }
