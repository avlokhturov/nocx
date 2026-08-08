package export_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/storage"
)

// --- test helpers ---

type testLogger struct{}

func (l *testLogger) Debug(msg string, args ...any)            {}
func (l *testLogger) Info(msg string, args ...any)             {}
func (l *testLogger) Warn(msg string, args ...any)             {}
func (l *testLogger) Error(msg string, args ...any)            {}
func (l *testLogger) With(args ...any) log.Logger              { return l }
func (l *testLogger) WithContext(_ context.Context) log.Logger { return l }

// fakeProfileRepo is an in-memory ProfileRepository.
type fakeProfileRepo struct{ profiles []profile.SSHProfile }

func (r *fakeProfileRepo) LoadProfiles() ([]profile.SSHProfile, error) { return r.profiles, nil }
func (r *fakeProfileRepo) CreateProfile(p profile.SSHProfile) error {
	for _, e := range r.profiles {
		if e.ID == p.ID {
			return profile.ErrProfileExists
		}
	}
	r.profiles = append(r.profiles, p)
	return nil
}

func (r *fakeProfileRepo) UpdateProfile(p profile.SSHProfile) error {
	for i, e := range r.profiles {
		if e.ID == p.ID {
			r.profiles[i] = p
			return nil
		}
	}
	return profile.ErrProfileNotFound
}

func (r *fakeProfileRepo) DeleteProfile(id string) error {
	for i, p := range r.profiles {
		if p.ID == id {
			r.profiles = append(r.profiles[:i], r.profiles[i+1:]...)
			return nil
		}
	}
	return nil
}

// fakeGroupRepo is an in-memory GroupRepository.
type fakeGroupRepo struct{ groups []profile.ProfileGroup }

func (r *fakeGroupRepo) LoadGroups() ([]profile.ProfileGroup, error) { return r.groups, nil }
func (r *fakeGroupRepo) CreateGroup(g profile.ProfileGroup) error {
	for _, e := range r.groups {
		if e.ID == g.ID {
			return profile.ErrGroupExists
		}
	}
	r.groups = append(r.groups, g)
	return nil
}

func (r *fakeGroupRepo) UpdateGroup(g profile.ProfileGroup) error {
	for i, e := range r.groups {
		if e.ID == g.ID {
			r.groups[i] = g
			return nil
		}
	}
	return profile.ErrGroupNotFound
}

func (r *fakeGroupRepo) DeleteGroup(id string) error {
	for i, g := range r.groups {
		if g.ID == id {
			r.groups = append(r.groups[:i], r.groups[i+1:]...)
			return nil
		}
	}
	return nil
}

func makeProfile(id, name, host string) profile.SSHProfile {
	return profile.SSHProfile{
		Base: profile.Base{
			ID:   id,
			Type: "ssh",
			Name: name,
		},
		Options: profile.StoredSSHProfileOptions{Host: host, Port: profile.Ptr(22), User: profile.Ptr("root")},
	}
}

func makeGroup(id, name string) profile.ProfileGroup {
	return profile.ProfileGroup{ID: id, Name: name}
}

// staticPaths implements storage.Paths with fixed values.
type staticPaths struct{ config, data, cache string }

func (p *staticPaths) ConfigDir() string { return p.config }
func (p *staticPaths) DataDir() string   { return p.data }
func (p *staticPaths) CacheDir() string  { return p.cache }

// fakeSettingsSink records applied values and can fail on demand. failOnce
// fails only the NEXT Apply — the restore operation's rollback re-applies
// the old settings through the SAME sink, so a test that wants the import
// apply to fail and the rollback to succeed needs one-shot failure.
type fakeSettingsSink struct {
	applied    map[string]any
	err        error // fail every Apply
	failOnce   error // fail the next Apply only
	applyCalls int   // counts every Apply, including a rollback's
}

func (s *fakeSettingsSink) Apply(values map[string]any) error {
	s.applyCalls++
	if s.failOnce != nil {
		e := s.failOnce
		s.failOnce = nil
		return e
	}
	if s.err != nil {
		return s.err
	}
	if s.applied == nil {
		s.applied = map[string]any{}
	}
	for k, v := range values {
		s.applied[k] = v
	}
	return nil
}

// fakeSettingsProvider returns canned settings for ExportConfiguration.
type fakeSettingsProvider struct {
	values map[string]any
	err    error
}

func (p *fakeSettingsProvider) All() (map[string]any, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.values, nil
}

// fakeContentDB is an in-memory ContentDB whose restore seam records the
// block and can fail on demand. The store-level atomicity (all-or-nothing)
// is the real store's contract, so the fake lands the whole block or fails
// — exactly what the restore operation is allowed to assume.
type fakeContentDB struct {
	restoredConvs   []content.Conversation
	restoredHistory []content.CommandRecord
	restoreErr      error
	restoreHook     func() // fires inside RestorePrivate, before the error/success
	calls           int
}

func (f *fakeContentDB) RestorePrivate(_ context.Context, conversations []content.Conversation, history []content.CommandRecord) error {
	f.calls++
	if f.restoreHook != nil {
		f.restoreHook()
	}
	if f.restoreErr != nil {
		return f.restoreErr
	}
	f.restoredConvs = append(f.restoredConvs, conversations...)
	f.restoredHistory = append(f.restoredHistory, history...)
	return nil
}

func (f *fakeContentDB) Conversations() content.ConversationRepository {
	return nilConversationRepo{}
}

func (f *fakeContentDB) CommandHistory() content.CommandHistoryRepository {
	return nilHistoryRepo{}
}
func (f *fakeContentDB) Backup(context.Context, string) error { return nil }
func (f *fakeContentDB) Close() error                         { return nil }

// nilConversationRepo and nilHistoryRepo are unreachable stubs: the restore
// path goes through RestorePrivate, never the per-row repositories, and the
// fake's other methods exist only to satisfy the ContentDB shape.
type nilConversationRepo struct{}

func (nilConversationRepo) Save(context.Context, content.Conversation) error { return nil }
func (nilConversationRepo) GetByID(context.Context, string) (*content.Conversation, error) {
	return nil, nil
}

func (nilConversationRepo) List(context.Context, int) ([]content.Conversation, error) {
	return nil, nil
}

type nilHistoryRepo struct{}

func (nilHistoryRepo) Add(context.Context, content.CommandRecord) (int64, error) { return 0, nil }
func (nilHistoryRepo) List(context.Context, int) ([]content.CommandRecord, error) {
	return nil, nil
}

func (nilHistoryRepo) GetByID(context.Context, int64) (*content.CommandRecord, error) {
	return nil, nil
}

func (nilHistoryRepo) FindByPrefix(context.Context, string, int) ([]content.CommandRecord, error) {
	return nil, nil
}

func (nilHistoryRepo) RewriteRedaction(context.Context, int64, content.Redaction, string) error {
	return nil
}

func (nilHistoryRepo) Query(context.Context, content.Scope, string, string, int, *int64, string) (content.HistoryPage, error) {
	return content.HistoryPage{}, nil
}

// flippingDocStore fails every Write once armed — the rollback-failure
// injection for the restore operation's honest error reporting.
type flippingDocStore struct {
	storage.DocumentStore
	fail atomic.Bool
}

func (s *flippingDocStore) Write(name string, doc any) error {
	if s.fail.Load() {
		return errors.New("injected write failure")
	}
	return s.DocumentStore.Write(name, doc)
}

// =========================================================================
// Manifest tests
// =========================================================================

func TestManifestFor_ConfigExport(t *testing.T) {
	m := export.ManifestFor(export.ModeConfigExport)
	if m.Mode != export.ModeConfigExport {
		t.Errorf("mode = %v, want %v", m.Mode, export.ModeConfigExport)
	}
	if len(m.Carries) == 0 {
		t.Error("carries is empty")
	}
	if len(m.Omits) == 0 {
		t.Error("omits is empty")
	}
	foundSecret := false
	for _, o := range m.Omits {
		if strings.Contains(strings.ToLower(o), "secret") {
			foundSecret = true
			break
		}
	}
	if !foundSecret {
		t.Error("omits does not mention secrets")
	}
}

func TestManifestFor_PortableEncrypted(t *testing.T) {
	m := export.ManifestFor(export.ModePortableEncrypted)
	if m.Mode != export.ModePortableEncrypted {
		t.Errorf("mode = %v, want %v", m.Mode, export.ModePortableEncrypted)
	}
	// Private content is carried when the user opts in — the manifest states
	// that condition in Carries rather than burying it in Omits (nocx-ojxa:
	// the import now restores what the export carries, so the old "omitted
	// unless you ask" phrasing would contradict what restore actually does).
	foundPrivate := false
	for _, c := range m.Carries {
		lower := strings.ToLower(c)
		if strings.Contains(lower, "private") || strings.Contains(lower, "conversation") {
			foundPrivate = true
			break
		}
	}
	if !foundPrivate {
		t.Error("carries does not mention private content")
	}
	foundSecret := false
	for _, o := range m.Omits {
		if strings.Contains(strings.ToLower(o), "secret") {
			foundSecret = true
			break
		}
	}
	if !foundSecret {
		t.Error("omits does not mention secret material")
	}
}

func TestManifestFor_SameMachineBackup(t *testing.T) {
	m := export.ManifestFor(export.ModeSameMachineBackup)
	if m.Mode != export.ModeSameMachineBackup {
		t.Errorf("mode = %v, want %v", m.Mode, export.ModeSameMachineBackup)
	}
	foundSecret := false
	for _, o := range m.Omits {
		if strings.Contains(strings.ToLower(o), "secret") || strings.Contains(strings.ToLower(o), "keychain") {
			foundSecret = true
			break
		}
	}
	if !foundSecret {
		t.Error("omits does not mention secrets/keychain")
	}
}

func TestManifestFor_Import(t *testing.T) {
	m := export.ManifestFor(export.ModeImport)
	if m.Mode != export.ModeImport {
		t.Errorf("mode = %v, want %v", m.Mode, export.ModeImport)
	}
	foundSecret := false
	for _, o := range m.Omits {
		if strings.Contains(strings.ToLower(o), "secret") || strings.Contains(strings.ToLower(o), "resolve") || strings.Contains(strings.ToLower(o), "invent") {
			foundSecret = true
			break
		}
	}
	if !foundSecret {
		t.Error("omits does not mention secret resolution")
	}
}

// =========================================================================
// Configuration export
// =========================================================================

// Secret bindings are backend-owned AND machine-local (ADR-0011 §2): the
// export must strip them, so a reimport never claims a saved password that
// cannot exist on the receiving machine.
func TestExportConfiguration_StripsSecretBindings(t *testing.T) {
	prof := makeProfile("ssh:custom:test:0001", "test-host", "example.com")
	prof.Options.PasswordSecret = "sec:v1:file:aaaa"
	prof.Options.KeySecret = "sec:v1:file:bbbb"
	prof.Options.KeyPassphraseSecret = "sec:v1:file:cccc"
	profiles := []profile.SSHProfile{prof}
	groups := []profile.ProfileGroup{makeGroup("group-1", "Work")}

	deps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{profiles: profiles},
		Groups:   &fakeGroupRepo{groups: groups},
	}

	result, err := export.ExportConfiguration(deps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}
	if len(result.Profiles) != 1 {
		t.Errorf("profiles = %d, want 1", len(result.Profiles))
	}
	if len(result.Groups) != 1 {
		t.Errorf("groups = %d, want 1", len(result.Groups))
	}

	exported := result.Profiles[0]
	if exported.Options.PasswordSecret != "" ||
		exported.Options.KeySecret != "" ||
		exported.Options.KeyPassphraseSecret != "" {
		t.Errorf("secret bindings survived the export: %+v", exported.Options)
	}
	if exported.Options.Host != "example.com" || exported.Name != "test-host" {
		t.Errorf("profile identity changed by stripping: %+v", exported)
	}
}

func TestExportConfiguration_EmptyRepos(t *testing.T) {
	deps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}
	if len(result.Profiles) != 0 || len(result.Groups) != 0 {
		t.Error("expected empty result from empty repos")
	}
}

func TestExportConfiguration_NilSettingsProvider(t *testing.T) {
	deps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
		Settings: nil,
	}
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		t.Fatalf("ExportConfiguration with nil settings: %v", err)
	}
	if len(result.Settings) > 0 {
		t.Error("Settings is non-empty with nil provider")
	}
}

// =========================================================================
// Portable encrypted export
// =========================================================================

func TestPortableEncrypted_RoundTrip(t *testing.T) {
	profiles := []profile.SSHProfile{makeProfile("ssh:custom:test:0001", "test-host", "example.com")}
	groups := []profile.ProfileGroup{makeGroup("group-1", "Work")}

	configDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{profiles: profiles},
		Groups:   &fakeGroupRepo{groups: groups},
	}
	portableDeps := export.PortableEncryptedDeps{
		ConfigExport: configDeps,
		ContentDB:    content.NewStub(&testLogger{}),
	}

	passphrase := "correct horse battery staple"
	enc, err := export.ExportPortableEncrypted(portableDeps, passphrase, false)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}
	if len(enc.Payload) == 0 {
		t.Fatal("payload is empty")
	}
	if enc.IncludePrivateContent {
		t.Error("IncludePrivateContent is true but was passed as false")
	}

	decrypted, err := export.DecryptPortableExport(enc, passphrase)
	if err != nil {
		t.Fatalf("DecryptPortableExport: %v", err)
	}
	if len(decrypted.Config.Profiles) != 1 {
		t.Errorf("decrypted profiles = %d, want 1", len(decrypted.Config.Profiles))
	}
	if len(decrypted.Config.Groups) != 1 {
		t.Errorf("decrypted groups = %d, want 1", len(decrypted.Config.Groups))
	}
}

func TestPortableEncrypted_NilContentDB(t *testing.T) {
	configDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	portableDeps := export.PortableEncryptedDeps{
		ConfigExport: configDeps,
		ContentDB:    nil, // not wired
	}

	// includePrivateContent=true with nil ContentDB must not panic.
	enc, err := export.ExportPortableEncrypted(portableDeps, "pass", true)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted with nil ContentDB: %v", err)
	}
	if !enc.IncludePrivateContent {
		t.Error("IncludePrivateContent is false when true was requested")
	}

	decrypted, err := export.DecryptPortableExport(enc, "pass")
	if err != nil {
		t.Fatalf("DecryptPortableExport: %v", err)
	}
	if decrypted.Private == nil {
		t.Error("Private is nil when includePrivateContent was true")
	}
	if decrypted.Private.Available {
		t.Error("Private.Available is true with nil ContentDB")
	}
}

func TestPortableEncrypted_WrongPassphrase(t *testing.T) {
	configDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	portableDeps := export.PortableEncryptedDeps{
		ConfigExport: configDeps,
		ContentDB:    content.NewStub(&testLogger{}),
	}

	enc, err := export.ExportPortableEncrypted(portableDeps, "correct", false)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}
	_, err = export.DecryptPortableExport(enc, "wrong")
	if err == nil {
		t.Fatal("expected error with wrong passphrase, got nil")
	}
}

func TestPortableEncrypted_PrivateContentNotIncludedByDefault(t *testing.T) {
	configDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	portableDeps := export.PortableEncryptedDeps{
		ConfigExport: configDeps,
		ContentDB:    content.NewStub(&testLogger{}),
	}

	// Default: includePrivateContent = false — PrivateContent is nil.
	enc, err := export.ExportPortableEncrypted(portableDeps, "pass", false)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted: %v", err)
	}
	if enc.IncludePrivateContent {
		t.Error("IncludePrivateContent is true when false was requested")
	}

	// Explicit: includePrivateContent = true — PrivateContent is populated
	// (even if content.db is a stub, we note that it's unavailable).
	enc2, err := export.ExportPortableEncrypted(portableDeps, "pass", true)
	if err != nil {
		t.Fatalf("ExportPortableEncrypted with private content: %v", err)
	}
	if !enc2.IncludePrivateContent {
		t.Error("IncludePrivateContent is false when true was requested")
	}

	// Decrypt and verify the private content block exists.
	decrypted, err := export.DecryptPortableExport(enc2, "pass")
	if err != nil {
		t.Fatalf("DecryptPortableExport: %v", err)
	}
	if decrypted.Private == nil {
		t.Error("Private is nil when includePrivateContent was true")
	}
}

// =========================================================================
// Same-machine backup
// =========================================================================

func TestBackup_ReportsPaths(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	deps := export.BackupDeps{
		Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
	}

	result, err := export.Backup(ctx, deps)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if result.ConfigDir != configDir {
		t.Errorf("ConfigDir = %q, want %q", result.ConfigDir, configDir)
	}
	if result.Mode != export.ModeSameMachineBackup {
		t.Errorf("Mode = %v, want %v", result.Mode, export.ModeSameMachineBackup)
	}
	if result.SecretsStatement == "" {
		t.Error("SecretsStatement is empty")
	}
}

func TestBackup_ContentDBAbsent(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	deps := export.BackupDeps{
		Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
	}
	result, err := export.Backup(ctx, deps)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if !result.ContentDBAbsent {
		t.Error("ContentDBAbsent = false, want true (content.db does not exist)")
	}
	if result.ContentDBPath != "" {
		t.Errorf("ContentDBPath = %q, want empty", result.ContentDBPath)
	}
}

func TestBackup_ContentDBPresent(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	dbPath := filepath.Join(dataDir, "content.db")
	if err := os.WriteFile(dbPath, []byte("stub db"), 0o600); err != nil {
		t.Fatalf("create content.db: %v", err)
	}

	deps := export.BackupDeps{
		Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
	}
	result, err := export.Backup(ctx, deps)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if result.ContentDBAbsent {
		t.Error("ContentDBAbsent = true, want false (content.db exists)")
	}
	if result.ContentDBPath == "" {
		t.Error("ContentDBPath is empty, want path to content.db")
	}
}

// =========================================================================
// Import
// =========================================================================

func TestImportConfiguration_RoundTrip(t *testing.T) {
	original := &export.ConfigExport{
		Profiles: []profile.SSHProfile{makeProfile("ssh:custom:test:0001", "test-host", "example.com")},
		Groups:   []profile.ProfileGroup{makeGroup("group-1", "Work")},
	}

	importDeps := export.ImportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}

	result, err := export.ImportConfiguration(importDeps, original)
	if err != nil {
		t.Fatalf("ImportConfiguration: %v", err)
	}
	if result.ProfilesImported != 1 {
		t.Errorf("ProfilesImported = %d, want 1", result.ProfilesImported)
	}
	if result.GroupsImported != 1 {
		t.Errorf("GroupsImported = %d, want 1", result.GroupsImported)
	}

	profiles, _ := importDeps.Profiles.LoadProfiles()
	if len(profiles) != 1 {
		t.Errorf("profiles after import = %d, want 1", len(profiles))
	}
}

func TestImportConfiguration_FullRoundTrip(t *testing.T) {
	originalProfile := makeProfile("ssh:custom:test:0001", "test-host", "example.com")
	originalGroup := makeGroup("group-1", "Work")

	exportDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{profiles: []profile.SSHProfile{originalProfile}},
		Groups:   &fakeGroupRepo{groups: []profile.ProfileGroup{originalGroup}},
	}
	exported, err := export.ExportConfiguration(exportDeps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}

	importDeps := export.ImportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	result, err := export.ImportConfiguration(importDeps, exported)
	if err != nil {
		t.Fatalf("ImportConfiguration: %v", err)
	}
	if result.ProfilesImported != 1 {
		t.Errorf("ProfilesImported = %d, want 1", result.ProfilesImported)
	}
	if result.GroupsImported != 1 {
		t.Errorf("GroupsImported = %d, want 1", result.GroupsImported)
	}

	profiles, _ := importDeps.Profiles.LoadProfiles()
	if profiles[0].Name != originalProfile.Name {
		t.Errorf("profile name = %q, want %q", profiles[0].Name, originalProfile.Name)
	}
	groups, _ := importDeps.Groups.LoadGroups()
	if groups[0].Name != originalGroup.Name {
		t.Errorf("group name = %q, want %q", groups[0].Name, originalGroup.Name)
	}
}

// The round trip, compared field by field, not by "it did not error": a
// populated profile (every non-secret option), a group, and settings go
// through ExportConfiguration and come out of ImportConfiguration equal.
// This is the test that pins nocx-ojxa — import used to drop settings
// silently, and nothing compared the two ends.
func TestImportConfiguration_FullRoundTrip_FieldByField(t *testing.T) {
	port := 2222
	user := "deploy"
	auth := profile.AuthPassword
	keepalive := 30
	keepaliveMax := 3
	readyTimeout := 15
	keyPath := "/home/deploy/.ssh/id_ed25519"
	jumpHost := "bastion"
	agentForward := true
	canBeJump := true
	behavior := profile.BehaviorReconnect

	richProfile := profile.SSHProfile{
		Base: profile.Base{
			ID:                   "ssh:rich:0001",
			Type:                 "ssh",
			Name:                 "Rich Host",
			Group:                "group-1",
			Icon:                 "server",
			Color:                "#ff5500",
			DisableDynamicTitle:  true,
			BehaviorOnSessionEnd: behavior,
			Weight:               3,
		},
		Options: profile.StoredSSHProfileOptions{
			Host:                 "rich.example.com",
			Port:                 &port,
			User:                 &user,
			Auth:                 &auth,
			KeepaliveInterval:    &keepalive,
			KeepaliveCountMax:    &keepaliveMax,
			ReadyTimeout:         &readyTimeout,
			KeyPath:              &keyPath,
			JumpHost:             &jumpHost,
			AgentForward:         &agentForward,
			CanBeJumpServer:      &canBeJump,
			BehaviorOnSessionEnd: &behavior,
			// Secret bindings are machine-local; the export strips them and
			// the import must not resurrect them (ADR-0011 §2).
			PasswordSecret:      "sec:v1:must-not-survive",
			KeySecret:           "sec:v1:key-must-not-survive",
			KeyPassphraseSecret: "sec:v1:pp-must-not-survive",
		},
	}
	group := profile.ProfileGroup{ID: "group-1", Name: "Work", Defaults: &profile.ProfileDefaults{
		SparseSSHOptions: profile.SparseSSHOptions{Port: profile.Ptr(22), User: profile.Ptr("root")},
	}}
	settings := map[string]any{
		"history.enabled":       true,
		"history.retentionDays": float64(90),
		"tab.placement":         "vertical",
	}

	exportDeps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{profiles: []profile.SSHProfile{richProfile}},
		Groups:   &fakeGroupRepo{groups: []profile.ProfileGroup{group}},
		Settings: &fakeSettingsProvider{values: settings},
	}
	exported, err := export.ExportConfiguration(exportDeps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}

	profRepo := &fakeProfileRepo{}
	groupRepo := &fakeGroupRepo{}
	sink := &fakeSettingsSink{}
	importDeps := export.ImportDeps{
		Profiles: profRepo,
		Groups:   groupRepo,
		Settings: sink,
	}
	if _, err := export.ImportConfiguration(importDeps, exported); err != nil {
		t.Fatalf("ImportConfiguration: %v", err)
	}

	// Field by field: the stored profile equals the exported profile.
	storedProfiles, _ := profRepo.LoadProfiles()
	if len(storedProfiles) != 1 {
		t.Fatalf("stored profiles = %d, want 1", len(storedProfiles))
	}
	if !reflect.DeepEqual(storedProfiles[0], exported.Profiles[0]) {
		t.Errorf("stored profile differs from exported:\nstored:  %+v\nexported: %+v",
			storedProfiles[0], exported.Profiles[0])
	}
	if storedProfiles[0].Options.PasswordSecret != "" ||
		storedProfiles[0].Options.KeySecret != "" ||
		storedProfiles[0].Options.KeyPassphraseSecret != "" {
		t.Errorf("stored profile carries secret bindings: %+v", storedProfiles[0].Options)
	}

	storedGroups, _ := groupRepo.LoadGroups()
	if len(storedGroups) != 1 {
		t.Fatalf("stored groups = %d, want 1", len(storedGroups))
	}
	if !reflect.DeepEqual(storedGroups[0], exported.Groups[0]) {
		t.Errorf("stored group differs from exported:\nstored:  %+v\nexported: %+v",
			storedGroups[0], exported.Groups[0])
	}

	// Settings: every value the export carried was applied, no more.
	if !reflect.DeepEqual(sink.applied, settings) {
		t.Errorf("settings applied differ from exported:\napplied:  %+v\nexported: %+v",
			sink.applied, settings)
	}
}

// A renderer-forged import carrying secret references must not persist them:
// import never names a secret (ADR-0011 §2), and a reference that reaches the
// resolver would be honoured at connect time against the attacker's host
// (nocx-jb20.1). This pins both import paths' strip at the shared helper.
func TestImportConfiguration_StripsForgedSecretReferences(t *testing.T) {
	forged := &export.ConfigExport{
		Profiles: []profile.SSHProfile{{
			Base: profile.Base{ID: "ssh:forged:0001", Type: "ssh", Name: "Forged"},
			Options: profile.StoredSSHProfileOptions{
				Host:                "attacker.example.com",
				PasswordSecret:      "sec:v1:victim-password",
				KeySecret:           "sec:v1:victim-key",
				KeyPassphraseSecret: "sec:v1:victim-passphrase",
			},
		}},
	}

	profRepo := &fakeProfileRepo{}
	importDeps := export.ImportDeps{
		Profiles: profRepo,
		Groups:   &fakeGroupRepo{},
	}
	if _, err := export.ImportConfiguration(importDeps, forged); err != nil {
		t.Fatalf("ImportConfiguration: %v", err)
	}

	stored, _ := profRepo.LoadProfiles()
	if len(stored) != 1 {
		t.Fatalf("stored profiles = %d, want 1", len(stored))
	}
	if stored[0].Options.PasswordSecret != "" ||
		stored[0].Options.KeySecret != "" ||
		stored[0].Options.KeyPassphraseSecret != "" {
		t.Errorf("forged secret references persisted: %+v", stored[0].Options)
	}
}

// The symmetry property has both ends: an export that carries settings must
// not be importable into a world with no sink for them — silent drop is the
// defect (nocx-ojxa), so the import refuses instead.
func TestImportConfiguration_SettingsCarriedWithoutSinkFails(t *testing.T) {
	data := &export.ConfigExport{
		Profiles: []profile.SSHProfile{makeProfile("ssh:p:0001", "p", "h.example.com")},
		Settings: map[string]any{"history.enabled": true},
	}
	importDeps := export.ImportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
		// Settings sink deliberately absent.
	}
	if _, err := export.ImportConfiguration(importDeps, data); err == nil {
		t.Fatal("import with settings but no sink succeeded, want error")
	}
}

// A failing settings sink fails the import — a half-restored settings
// document reported as success is how the lie propagates.
func TestImportConfiguration_SettingsSinkFailureFailsImport(t *testing.T) {
	data := &export.ConfigExport{
		Profiles: []profile.SSHProfile{makeProfile("ssh:p:0002", "p", "h.example.com")},
		Settings: map[string]any{"history.enabled": true},
	}
	importDeps := export.ImportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
		Settings: &fakeSettingsSink{err: errors.New("boom")},
	}
	if _, err := export.ImportConfiguration(importDeps, data); err == nil {
		t.Fatal("import with failing settings sink succeeded, want error")
	}
}

// -------------------------------------------------------------------------
// RestoreImport — the whole profiles + groups + settings + content restore
// -------------------------------------------------------------------------

// newRestoreProfileService builds a profile service over a real JSON store
// rooted in a temp dir, and returns both — the service is what the restore
// operation writes through, the store is what the tests assert on.
func newRestoreProfileService(t *testing.T) (*profile.ProfileService, *profile.JSONStore) {
	t.Helper()
	store := profile.NewJSONStore(filepath.Join(t.TempDir(), "p.json"))
	return profile.NewProfileService(store), store
}

// seedOldGeneration plants one profile, one group and one setting so the
// tests have a pre-restore generation to compare against.
func seedOldGeneration(t *testing.T, svc *profile.ProfileService, sink *fakeSettingsSink) {
	t.Helper()
	if err := svc.SaveProfile(makeProfile("ssh:old:0001", "old", "old.example.com")); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	if err := svc.SaveGroup(makeGroup("group-1", "Work")); err != nil {
		t.Fatalf("SaveGroup: %v", err)
	}
	if err := sink.Apply(map[string]any{"history.enabled": true}); err != nil {
		t.Fatalf("Apply old settings: %v", err)
	}
}

// newGeneration returns an import payload that overwrites the seeded
// profile, adds a profile that did not exist before, keeps the group, and
// flips the setting.
func newGeneration() *export.ConfigExport {
	return &export.ConfigExport{
		Profiles: []profile.SSHProfile{
			makeProfile("ssh:old:0001", "new-name", "new.example.com"),
			makeProfile("ssh:imported:0001", "imported", "imported.example.com"),
		},
		Groups:   []profile.ProfileGroup{makeGroup("group-1", "Work")},
		Settings: map[string]any{"history.enabled": false},
	}
}

// The headline acceptance: a failure injected between the configuration
// commit and the content restore must leave ALL stores at one generation —
// here, the OLD one, because the failure aborts the restore. Asserted on
// the stores, never on a log line: the imported-only profile is GONE, the
// overwritten profile is RESTORED, and the settings are back to the old
// value.
func TestRestoreImport_FailureBetweenConfigAndContentLeavesAllStoresAtOneGeneration(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	contentDB := &fakeContentDB{restoreErr: errors.New("disk full")}

	deps := export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}
	priv := &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	}
	_, err := export.RestoreImport(context.Background(), deps, newGeneration(), priv)
	if err == nil {
		t.Fatal("restore with a failing content store succeeded, want error")
	}

	// Profiles: back at the OLD generation — the overwritten profile is
	// restored and the imported-only one is gone.
	profiles, lerr := store.LoadProfiles()
	if lerr != nil {
		t.Fatalf("LoadProfiles: %v", lerr)
	}
	if len(profiles) != 1 {
		t.Fatalf("profiles = %d, want 1 (imported profile must be gone): %+v", len(profiles), profiles)
	}
	if profiles[0].Name != "old" {
		t.Errorf("profile name = %q, want %q (overwritten profile must be restored)", profiles[0].Name, "old")
	}
	groups, gerr := store.LoadGroups()
	if gerr != nil {
		t.Fatalf("LoadGroups: %v", gerr)
	}
	if len(groups) != 1 || groups[0].Name != "Work" {
		t.Errorf("groups = %+v, want the old generation group", groups)
	}
	// Settings: rolled back to the old value.
	if sink.applied == nil || sink.applied["history.enabled"] != true {
		t.Errorf("settings after failed restore = %+v, want history.enabled=true", sink.applied)
	}
}

// Cancellation BEFORE the commit point changes nothing on disk: no profile,
// no group, no setting, no content write.
func TestRestoreImport_CancelledBeforeCommitChangesNothing(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	contentDB := &fakeContentDB{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := export.RestoreImport(ctx, export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}, newGeneration(), &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	profiles, _ := store.LoadProfiles()
	if len(profiles) != 1 || profiles[0].Name != "old" {
		t.Errorf("profiles changed by a cancelled restore: %+v", profiles)
	}
	if len(sink.applied) != 1 || sink.applied["history.enabled"] != true {
		t.Errorf("settings changed by a cancelled restore: %+v", sink.applied)
	}
	if contentDB.calls != 0 {
		t.Errorf("content store was touched by a cancelled restore: %d calls", contentDB.calls)
	}
}

// Cancellation AFTER the commit point (observed by the store mid-restore)
// still returns with the invariant restored: the operation does not abandon
// half-applied state because its context died. The store aborts its atomic
// restore (modelled here by the fake returning context.Canceled) and the
// configuration is rolled back — every store at the OLD generation.
func TestRestoreImport_CancellationDuringContentRestoreRollsBack(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	contentDB := &fakeContentDB{restoreErr: context.Canceled}

	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}, newGeneration(), &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	// Both halves of the configuration are at the OLD generation, asserted
	// independently — a wrong setting must not be hidden by a profile
	// failure, and vice versa.
	profiles, _ := store.LoadProfiles()
	if len(profiles) != 1 || profiles[0].Name != "old" {
		t.Errorf("profiles after cancelled restore = %+v, want the old generation", profiles)
	}
	if sink.applied["history.enabled"] != true {
		t.Errorf("settings after cancelled restore = %+v, want history.enabled=true", sink.applied)
	}
}

// A failing settings sink (the import's settings apply fails) rolls the
// profiles back: the configuration must not be left at the new generation
// when part of it did not commit.
func TestRestoreImport_SettingsApplyFailureRollsBackProfiles(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	// Arm the one-shot failure AFTER seeding: the seed itself applies the
	// old settings through the same sink.
	sink.failOnce = errors.New("settings registry boom")

	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    &fakeContentDB{},
	}, newGeneration(), nil)
	if err == nil {
		t.Fatal("import with a failing settings sink succeeded, want error")
	}

	profiles, _ := store.LoadProfiles()
	if len(profiles) != 1 || profiles[0].Name != "old" {
		t.Errorf("profiles after failed settings apply = %+v, want the old generation", profiles)
	}
	// The rollback itself reapplied the old settings.
	if sink.applied == nil || sink.applied["history.enabled"] != true {
		t.Errorf("settings after rollback = %+v, want history.enabled=true", sink.applied)
	}
}

// A settings-carrying export imported with no sink fails AND rolls the
// profiles back — the old two-phase shape left them at the new generation.
func TestRestoreImport_SettingsCarriedWithoutSinkFailsAndRollsBack(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)

	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       nil,
		Content:    &fakeContentDB{},
	}, newGeneration(), nil)
	if err == nil {
		t.Fatal("settings-carrying import without a sink succeeded, want error")
	}
	profiles, _ := store.LoadProfiles()
	if len(profiles) != 1 || profiles[0].Name != "old" {
		t.Errorf("profiles = %+v, want the old generation (profiles must roll back with the failed settings)", profiles)
	}
}

// Carried private content with no content database is an error — success
// would be the lie that a silent drop is (nocx-ojxa) — and the error leaves
// the configuration at the OLD generation.
func TestRestoreImport_CarriedContentWithoutStoreFailsAndRollsBack(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)

	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    nil,
	}, newGeneration(), &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	})
	if err == nil {
		t.Fatal("carried content with no content database succeeded, want error")
	}
	profiles, _ := store.LoadProfiles()
	if len(profiles) != 1 || profiles[0].Name != "old" {
		t.Errorf("profiles = %+v, want the old generation", profiles)
	}
}

// When the rollback itself fails (the store's disk died between the commit
// and the rollback), the operation reports BOTH failures: the invariant
// could not be restored and the caller must know, not be told a clean
// single cause.
func TestRestoreImport_RollbackFailureIsReportedNotHidden(t *testing.T) {
	flip := &flippingDocStore{DocumentStore: storage.NewDocumentStore(t.TempDir())}
	store := profile.NewJSONStoreWithDocStore(flip, "p.json")
	svc := profile.NewProfileService(store)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)

	contentDB := &fakeContentDB{
		restoreErr: errors.New("content boom"),
		restoreHook: func() {
			flip.fail.Store(true)
		},
	}
	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}, newGeneration(), &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	})
	if err == nil {
		t.Fatal("restore succeeded despite a failing rollback, want error")
	}
	if !strings.Contains(err.Error(), "content boom") || !strings.Contains(err.Error(), "rollback failed") {
		t.Errorf("error hides one of the two failures: %v", err)
	}
}

// A normal machine: the whole restore succeeds, every store lands at the
// NEW generation, and the counts and payloads are what the archive carried.
func TestRestoreImport_SuccessOnNormalMachine(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	contentDB := &fakeContentDB{}
	started := int64(1700000000000)

	cfg := newGeneration()
	priv := &export.PrivateContent{
		Available: true,
		Conversations: []content.Conversation{{
			ID: "conv-1", Title: "Debugging", CreatedAt: started,
			Messages: []content.Message{{Role: "user", Content: "why slow", Timestamp: started}},
		}},
		CommandHistory: []content.CommandRecord{{Command: "ssh prod", Cwd: "/home/dev", Host: "local"}},
	}
	result, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}, cfg, priv)
	if err != nil {
		t.Fatalf("RestoreImport: %v", err)
	}
	if result.ProfilesImported != 2 {
		t.Errorf("ProfilesImported = %d, want 2", result.ProfilesImported)
	}

	// All stores at the NEW generation.
	profiles, _ := store.LoadProfiles()
	if len(profiles) != 2 {
		t.Fatalf("profiles = %d, want 2", len(profiles))
	}
	got := map[string]string{}
	for _, p := range profiles {
		got[p.ID] = p.Name
	}
	if got["ssh:old:0001"] != "new-name" || got["ssh:imported:0001"] != "imported" {
		t.Errorf("profiles = %+v, want overwritten old + imported", got)
	}
	if sink.applied == nil || sink.applied["history.enabled"] != false {
		t.Errorf("settings = %+v, want history.enabled=false", sink.applied)
	}
	if len(contentDB.restoredConvs) != 1 || contentDB.restoredConvs[0].ID != "conv-1" {
		t.Errorf("conversations restored = %+v, want conv-1", contentDB.restoredConvs)
	}
	if len(contentDB.restoredHistory) != 1 || contentDB.restoredHistory[0].Command != "ssh prod" {
		t.Errorf("history restored = %+v, want ssh prod", contentDB.restoredHistory)
	}
}

// A payload that carries no private content never touches the content
// store — the operation restores the configuration and stops.
func TestRestoreImport_NoPrivateContentNeverTouchesContentStore(t *testing.T) {
	svc, store := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}
	seedOldGeneration(t, svc, sink)
	contentDB := &fakeContentDB{}

	result, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		Settings:   &fakeSettingsProvider{values: map[string]any{"history.enabled": true}},
		Sink:       sink,
		Content:    contentDB,
	}, newGeneration(), nil)
	if err != nil {
		t.Fatalf("RestoreImport: %v", err)
	}
	if contentDB.calls != 0 {
		t.Errorf("content store touched by a config-only restore: %d calls", contentDB.calls)
	}
	profiles, _ := store.LoadProfiles()
	if len(profiles) != 2 {
		t.Errorf("profiles = %d, want 2 (import succeeded)", len(profiles))
	}
	if result.ProfilesImported != 2 {
		t.Errorf("ProfilesImported = %d, want 2", result.ProfilesImported)
	}
}

// =========================================================================
// Proof: no mode resolves a secret
// =========================================================================

func TestNoModeResolvesASecret(t *testing.T) {
	// credential.Secret fails json.Marshal by design. If any mode
	// inadvertently included a Secret, json.Marshal would fail — this
	// test proves that doesn't happen.
	deps := export.ConfigExportDeps{
		Profiles: &fakeProfileRepo{},
		Groups:   &fakeGroupRepo{},
	}
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal of ConfigExport failed: %v — a Secret may have leaked", err)
	}
	if strings.Contains(string(raw), "[REDACTED]") {
		t.Error("[REDACTED] found in serialized output — a Secret leaked")
	}
}

// =========================================================================
// Structural invariant: internal/export MUST NOT import credential
// =========================================================================

// TestExportDoesNotImportCredential ensures the build enforces the
// ADR-0011 §2 invariant: no export mode can resolve a secret because
// the export package never imports credential.SecretStore. This test
// inspects the package's production imports (not test imports) via
// go list -json, so it fails the moment someone adds the import.
func TestExportDoesNotImportCredential(t *testing.T) {
	cmd := exec.Command("go", "list", "-json", "github.com/shady2k/nocx/internal/export")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -json failed: %v", err)
	}

	var pkg struct {
		Imports []string `json:"Imports"`
	}
	if err := json.Unmarshal(out, &pkg); err != nil {
		t.Fatalf("unmarshal go list output: %v", err)
	}

	for _, imp := range pkg.Imports {
		if imp == "github.com/shady2k/nocx/internal/credential" {
			t.Fatal("INTERNAL/EXPORT IMPORTS CREDENTIAL — this is the ADR-0011 §2 structural invariant. No export mode may resolve a secret. Remove the credential import and wire the RPCs so they call into the export package, never passing a resolved secret.")
		}
	}
}

// The same-machine backup of a live store must produce a consistent,
// encrypted, single-file snapshot — never a torn copy of the three live
// WAL files. This is correctness, not a threat-model nicety: WAL mode means
// the running store is content.db + -wal + -shm.
func TestBackup_SnapshotWithRealStore(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	store, err := content.Open(ctx, content.Config{
		Path:   filepath.Join(dataDir, "content.db"),
		Key:    key,
		Budget: content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: nil,
	})
	if err != nil {
		t.Fatalf("content.Open: %v", err)
	}
	defer func() { _ = store.Close() }()
	for range 5 {
		if _, addErr := store.CommandHistory().Add(ctx, content.CommandRecord{
			Command: "exported-cmd", Cwd: "/repo", Host: "", Status: content.StatusSuccess,
		}); addErr != nil {
			t.Fatalf("Add: %v", addErr)
		}
	}
	// Deliberately leave the WAL uncheckpointed: the newest rows are live
	// only in -wal when the snapshot is taken.

	deps := export.BackupDeps{
		Paths:     &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
		ContentDB: store,
	}
	result, err := export.Backup(ctx, deps)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if result.ContentDBSnapshotPath == "" {
		t.Fatal("manifest carries no snapshot path, want the consistent snapshot")
	}
	if result.ContentDBSnapshotPath != filepath.Join(dataDir, "content.db.snapshot") {
		t.Fatalf("snapshot path = %q, want content.db.snapshot next to the live db", result.ContentDBSnapshotPath)
	}

	// The snapshot is encrypted (no plaintext marker, no SQLite header) and
	// is a complete database: it reopens with the key and holds the rows
	// that were WAL-only at backup time.
	data, err := os.ReadFile(result.ContentDBSnapshotPath)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if len(data) >= 15 && string(data[:15]) == "SQLite format 3" {
		t.Fatal("snapshot has a plaintext SQLite header")
	}
	if strings.Contains(string(data), "exported-cmd") {
		t.Fatal("snapshot contains plaintext of a written row")
	}

	snap, err := content.Open(ctx, content.Config{
		Path:   result.ContentDBSnapshotPath,
		Key:    key,
		Budget: content.Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: nil,
	})
	if err != nil {
		t.Fatalf("snapshot does not reopen with the key: %v", err)
	}
	defer func() { _ = snap.Close() }()
	recs, err := snap.CommandHistory().List(ctx, 10)
	if err != nil {
		t.Fatalf("List from snapshot: %v", err)
	}
	if len(recs) != 5 {
		t.Fatalf("snapshot holds %d rows, want 5 (WAL-only rows lost)", len(recs))
	}
}

// Without a wired store (stub mode) the manifest must still name the live
// WAL set, so a copy step that ignores the snapshot API copies all three
// files rather than a torn single file.
func TestBackup_NoStoreReportsLiveWALSet(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	dbPath := filepath.Join(dataDir, "content.db")
	if err := os.WriteFile(dbPath, []byte("stub"), 0o600); err != nil {
		t.Fatalf("write content.db: %v", err)
	}
	if err := os.WriteFile(dbPath+"-wal", []byte("wal"), 0o600); err != nil {
		t.Fatalf("write -wal: %v", err)
	}

	deps := export.BackupDeps{Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")}}
	result, err := export.Backup(ctx, deps)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if result.ContentDBSnapshotPath != "" {
		t.Fatalf("no store wired but snapshot path set: %q", result.ContentDBSnapshotPath)
	}
	if result.ContentDBWalPath != dbPath+"-wal" {
		t.Fatalf("ContentDBWalPath = %q, want the live -wal named for the copy step", result.ContentDBWalPath)
	}
}
