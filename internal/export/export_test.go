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
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
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

// fakeSettingsSink records applied values and can fail on demand.
type fakeSettingsSink struct {
	applied map[string]any
	err     error
}

func (s *fakeSettingsSink) Apply(values map[string]any) error {
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

// fakeContentDB is an in-memory ContentDB whose write seams record calls
// and can fail on demand. The repositories are separate types, exactly as
// in the real store, so each can carry the methods its interface names.
type fakeContentDB struct {
	savedConvs   []content.Conversation
	addedHistory []content.CommandRecord
	saveErr      error
	addErr       error
}

func (f *fakeContentDB) Conversations() content.ConversationRepository {
	return &fakeConvRepo{db: f}
}

func (f *fakeContentDB) CommandHistory() content.CommandHistoryRepository {
	return &fakeHistRepo{db: f}
}
func (f *fakeContentDB) Backup(context.Context, string) error { return nil }
func (f *fakeContentDB) Close() error                         { return nil }

type fakeConvRepo struct{ db *fakeContentDB }

func (r *fakeConvRepo) Save(_ context.Context, c content.Conversation) error {
	if r.db.saveErr != nil {
		return r.db.saveErr
	}
	r.db.savedConvs = append(r.db.savedConvs, c)
	return nil
}

func (r *fakeConvRepo) GetByID(context.Context, string) (*content.Conversation, error) {
	return nil, nil
}

func (r *fakeConvRepo) List(context.Context, int) ([]content.Conversation, error) {
	return nil, nil
}

type fakeHistRepo struct{ db *fakeContentDB }

func (r *fakeHistRepo) Add(_ context.Context, rec content.CommandRecord) (int64, error) {
	if r.db.addErr != nil {
		return 0, r.db.addErr
	}
	r.db.addedHistory = append(r.db.addedHistory, rec)
	return 0, nil
}

func (r *fakeHistRepo) RewriteRedaction(_ context.Context, _ int64, _ content.Redaction, _ string) error {
	return nil
}

func (r *fakeHistRepo) GetByID(context.Context, int64) (*content.CommandRecord, error) {
	return nil, nil
}

func (r *fakeHistRepo) List(context.Context, int) ([]content.CommandRecord, error) {
	return nil, nil
}

func (r *fakeHistRepo) FindByPrefix(context.Context, string, int) ([]content.CommandRecord, error) {
	return nil, nil
}

func (r *fakeHistRepo) Query(context.Context, content.Scope, string, string, int, *int64, string) (content.HistoryPage, error) {
	return content.HistoryPage{}, nil
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
// Private content restore
// -------------------------------------------------------------------------

func TestRestorePrivateContent_NoopWhenNothingCarried(t *testing.T) {
	db := &fakeContentDB{}
	if err := export.RestorePrivateContent(db, nil); err != nil {
		t.Fatalf("nil private block: %v", err)
	}
	if err := export.RestorePrivateContent(db, &export.PrivateContent{Available: false}); err != nil {
		t.Fatalf("unavailable private block: %v", err)
	}
	if len(db.savedConvs) != 0 || len(db.addedHistory) != 0 {
		t.Errorf("store was written despite nothing to restore: convs=%d history=%d",
			len(db.savedConvs), len(db.addedHistory))
	}
}

func TestRestorePrivateContent_AvailableRestoresBothSlices(t *testing.T) {
	db := &fakeContentDB{}
	started := int64(1700000000000)
	ended := int64(1700000001000)
	pc := &export.PrivateContent{
		Available: true,
		Conversations: []content.Conversation{
			{
				ID: "conv-1", Title: "Debugging ssh", CreatedAt: started,
				Messages: []content.Message{
					{Role: "user", Content: "why is this slow", Timestamp: started},
				},
			},
		},
		CommandHistory: []content.CommandRecord{
			{
				ID: 42, Command: "ssh prod", Cwd: "/home/dev", Host: "local",
				Status: content.StatusSuccess, ExitCode: &[]int{0}[0],
				StartedAt: &started, EndedAt: &ended, Trusted: true,
			},
		},
	}
	if err := export.RestorePrivateContent(db, pc); err != nil {
		t.Fatalf("RestorePrivateContent: %v", err)
	}
	if len(db.savedConvs) != 1 {
		t.Fatalf("saved conversations = %d, want 1", len(db.savedConvs))
	}
	saved := db.savedConvs[0]
	if saved.ID != "conv-1" || saved.Title != "Debugging ssh" || saved.CreatedAt != started {
		t.Errorf("conversation identity not preserved: %+v", saved)
	}
	if len(saved.Messages) != 1 || saved.Messages[0].Content != "why is this slow" {
		t.Errorf("conversation messages not preserved: %+v", saved.Messages)
	}
	if len(db.addedHistory) != 1 {
		t.Fatalf("added history = %d, want 1", len(db.addedHistory))
	}
	rec := db.addedHistory[0]
	if rec.Command != "ssh prod" || rec.Cwd != "/home/dev" || rec.Host != "local" {
		t.Errorf("history command fields not preserved: %+v", rec)
	}
	if rec.StartedAt == nil || *rec.StartedAt != started || rec.EndedAt == nil || *rec.EndedAt != ended {
		t.Errorf("history timestamps not preserved: %+v", rec)
	}
	if rec.Status != content.StatusSuccess {
		t.Errorf("history status = %q, want %q", rec.Status, content.StatusSuccess)
	}
}

func TestRestorePrivateContent_ConversationSaveFailureFailsImport(t *testing.T) {
	db := &fakeContentDB{saveErr: errors.New("disk full")}
	pc := &export.PrivateContent{
		Available:     true,
		Conversations: []content.Conversation{{ID: "conv-1", Title: "t"}},
	}
	if err := export.RestorePrivateContent(db, pc); err == nil {
		t.Fatal("conversation save failure reported as success, want error")
	}
}

func TestRestorePrivateContent_HistoryAddFailureFailsImport(t *testing.T) {
	db := &fakeContentDB{addErr: errors.New("disk full")}
	pc := &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	}
	if err := export.RestorePrivateContent(db, pc); err == nil {
		t.Fatal("history add failure reported as success, want error")
	}
}

func TestRestorePrivateContent_NoDBWithCarriedContentFails(t *testing.T) {
	pc := &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	}
	if err := export.RestorePrivateContent(nil, pc); err == nil {
		t.Fatal("carried content with no content database reported as success, want error")
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
