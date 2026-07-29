package export_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/credential"
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

// fakeCredRepo is an in-memory CredentialMetadataRepository.
type fakeCredRepo struct{ creds []profile.Credential }

func (r *fakeCredRepo) LoadCredentials() ([]profile.Credential, error) { return r.creds, nil }
func (r *fakeCredRepo) CreateCredential(c profile.Credential) error {
	for _, e := range r.creds {
		if e.ID == c.ID {
			return profile.ErrCredentialExists
		}
	}
	r.creds = append(r.creds, c)
	return nil
}

func (r *fakeCredRepo) UpdateCredential(id string, p profile.CredentialPatch) (profile.Credential, error) {
	for i, e := range r.creds {
		if e.ID == id {
			r.creds[i] = e.WithPatch(p)
			return r.creds[i], nil
		}
	}
	return profile.Credential{}, profile.ErrCredentialNotFound
}

func (r *fakeCredRepo) UpdateCurrentVersionRefs(id, passwordSecretID, passphraseSecretID string) error {
	for i, e := range r.creds {
		if e.ID == id {
			if len(e.Versions) == 0 {
				r.creds[i].SecretID = passwordSecretID
				r.creds[i].PassphraseSecretID = passphraseSecretID
			} else {
				for j := range r.creds[i].Versions {
					if r.creds[i].Versions[j].ID == r.creds[i].CurrentVersionID {
						r.creds[i].Versions[j].PasswordSecretID = passwordSecretID
						r.creds[i].Versions[j].PassphraseSecretID = passphraseSecretID
						break
					}
				}
			}
			return nil
		}
	}
	return profile.ErrCredentialNotFound
}

func (r *fakeCredRepo) AppendCredentialVersion(id, passwordSecretID, passphraseSecretID string) error {
	for i, e := range r.creds {
		if e.ID == id {
			if len(e.Versions) == 0 {
				r.creds[i].Versions = []profile.CredentialVersion{
					{
						ID:                 "v1",
						PasswordSecretID:   e.SecretID,
						PassphraseSecretID: e.PassphraseSecretID,
					},
				}
				r.creds[i].CurrentVersionID = "v1"
				r.creds[i].SecretID = ""
				r.creds[i].PassphraseSecretID = ""
			}
			nextID := fmt.Sprintf("v%d", len(r.creds[i].Versions)+1)
			r.creds[i].Versions = append(r.creds[i].Versions, profile.CredentialVersion{
				ID:                 nextID,
				PasswordSecretID:   passwordSecretID,
				PassphraseSecretID: passphraseSecretID,
			})
			r.creds[i].CurrentVersionID = nextID
			return nil
		}
	}
	return profile.ErrCredentialNotFound
}

func (r *fakeCredRepo) SetCandidateVersion(id, passwordSecretID, passphraseSecretID string) error {
	for i, e := range r.creds {
		if e.ID == id {
			if e.CandidateVersionID != "" {
				return profile.ErrCandidateExists
			}
			if len(e.Versions) == 0 {
				r.creds[i].Versions = []profile.CredentialVersion{
					{
						ID:                 "v1",
						PasswordSecretID:   e.SecretID,
						PassphraseSecretID: e.PassphraseSecretID,
					},
				}
				r.creds[i].CurrentVersionID = "v1"
				r.creds[i].SecretID = ""
				r.creds[i].PassphraseSecretID = ""
			}
			nextID := fmt.Sprintf("v%d", len(r.creds[i].Versions)+1)
			r.creds[i].Versions = append(r.creds[i].Versions, profile.CredentialVersion{
				ID:                 nextID,
				PasswordSecretID:   passwordSecretID,
				PassphraseSecretID: passphraseSecretID,
			})
			r.creds[i].CandidateVersionID = nextID
			return nil
		}
	}
	return profile.ErrCredentialNotFound
}

func (r *fakeCredRepo) ClearCandidateVersion(id string) error {
	for i, e := range r.creds {
		if e.ID == id {
			if e.CandidateVersionID == "" {
				return nil
			}
			remaining := make([]profile.CredentialVersion, 0, len(e.Versions)-1)
			for _, v := range r.creds[i].Versions {
				if v.ID != e.CandidateVersionID {
					remaining = append(remaining, v)
				}
			}
			r.creds[i].Versions = remaining
			r.creds[i].CandidateVersionID = ""
			return nil
		}
	}
	return profile.ErrCredentialNotFound
}

func (r *fakeCredRepo) DeleteCredential(id string) error {
	for i, c := range r.creds {
		if c.ID == id {
			r.creds = append(r.creds[:i], r.creds[i+1:]...)
			return nil
		}
	}
	return nil
}

var (
	_ profile.ProfileRepository            = (*fakeProfileRepo)(nil)
	_ profile.GroupRepository              = (*fakeGroupRepo)(nil)
	_ profile.CredentialMetadataRepository = (*fakeCredRepo)(nil)
)

func makeCredential(name, username, auth string) profile.Credential {
	return profile.Credential{
		ID:                 profile.NewCredentialID(name),
		Name:               name,
		Username:           username,
		Auth:               profile.AuthMode(auth),
		SecretID:           string(credential.NewSecretID()),
		PassphraseSecretID: string(credential.NewSecretID()),
	}
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
	foundPrivate := false
	for _, o := range m.Omits {
		if strings.Contains(strings.ToLower(o), "private") || strings.Contains(strings.ToLower(o), "conversation") {
			foundPrivate = true
			break
		}
	}
	if !foundPrivate {
		t.Error("omits does not mention private content")
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

func TestExportConfiguration_ContainsSecretID_NotMaterial(t *testing.T) {
	cred := makeCredential("work-github", "alice", string(profile.AuthPassword))
	profiles := []profile.SSHProfile{makeProfile("ssh:custom:test:0001", "test-host", "example.com")}
	groups := []profile.ProfileGroup{makeGroup("group-1", "Work")}
	creds := []profile.Credential{cred}

	deps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{profiles: profiles},
		Groups:      &fakeGroupRepo{groups: groups},
		Credentials: &fakeCredRepo{creds: creds},
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
	if len(result.Credentials) != 1 {
		t.Errorf("credentials = %d, want 1", len(result.Credentials))
	}

	exported := result.Credentials[0]
	if exported.SecretID == "" {
		t.Error("SecretID is empty — must be present")
	}
	if exported.PassphraseSecretID == "" {
		t.Error("PassphraseSecretID is empty — must be present")
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if strings.Contains(string(raw), "[REDACTED]") {
		t.Error("JSON contains [REDACTED] — a credential.Secret leaked into the export")
	}
}

func TestExportConfiguration_EmptyRepos(t *testing.T) {
	deps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
	}
	result, err := export.ExportConfiguration(deps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}
	if len(result.Profiles) != 0 || len(result.Groups) != 0 || len(result.Credentials) != 0 {
		t.Error("expected empty result from empty repos")
	}
}

func TestExportConfiguration_NilSettingsProvider(t *testing.T) {
	deps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
		Settings:    nil,
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
	cred := makeCredential("work-github", "alice", string(profile.AuthPassword))
	profiles := []profile.SSHProfile{makeProfile("ssh:custom:test:0001", "test-host", "example.com")}
	groups := []profile.ProfileGroup{makeGroup("group-1", "Work")}
	creds := []profile.Credential{cred}

	configDeps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{profiles: profiles},
		Groups:      &fakeGroupRepo{groups: groups},
		Credentials: &fakeCredRepo{creds: creds},
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
	if decrypted.Config.Credentials[0].SecretID != cred.SecretID {
		t.Errorf("decrypted SecretID = %q, want %q", decrypted.Config.Credentials[0].SecretID, cred.SecretID)
	}
}

func TestPortableEncrypted_NilContentDB(t *testing.T) {
	configDeps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
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
	cred := makeCredential("work-github", "alice", string(profile.AuthPassword))
	configDeps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{creds: []profile.Credential{cred}},
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
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
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
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	deps := export.BackupDeps{
		Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
	}

	result, err := export.Backup(deps)
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
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, "config")
	dataDir := filepath.Join(tmp, "data")
	_ = os.MkdirAll(configDir, 0o700)
	_ = os.MkdirAll(dataDir, 0o700)

	deps := export.BackupDeps{
		Paths: &staticPaths{config: configDir, data: dataDir, cache: filepath.Join(tmp, "cache")},
	}
	result, err := export.Backup(deps)
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
	result, err := export.Backup(deps)
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
	cred := makeCredential("work-github", "alice", string(profile.AuthPassword))
	original := &export.ConfigExport{
		Profiles:    []profile.SSHProfile{makeProfile("ssh:custom:test:0001", "test-host", "example.com")},
		Groups:      []profile.ProfileGroup{makeGroup("group-1", "Work")},
		Credentials: []profile.Credential{cred},
	}

	importDeps := export.ImportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
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
	if result.CredentialsImported != 1 {
		t.Errorf("CredentialsImported = %d, want 1", result.CredentialsImported)
	}

	profiles, _ := importDeps.Profiles.LoadProfiles()
	if len(profiles) != 1 {
		t.Errorf("profiles after import = %d, want 1", len(profiles))
	}
	creds, _ := importDeps.Credentials.LoadCredentials()
	if len(creds) != 1 {
		t.Errorf("credentials after import = %d, want 1", len(creds))
	}
	if creds[0].SecretID != cred.SecretID {
		t.Errorf("imported SecretID = %q, want %q", creds[0].SecretID, cred.SecretID)
	}
}

func TestImportConfiguration_DoesNotResolveSecrets(t *testing.T) {
	cred := profile.Credential{
		ID:                 profile.NewCredentialID("test"),
		Name:               "test",
		Username:           "alice",
		Auth:               profile.AuthPassword,
		SecretID:           string(credential.NewSecretID()),
		PassphraseSecretID: string(credential.NewSecretID()),
	}

	original := &export.ConfigExport{Credentials: []profile.Credential{cred}}

	importDeps := export.ImportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
	}

	result, err := export.ImportConfiguration(importDeps, original)
	if err != nil {
		t.Fatalf("ImportConfiguration: %v", err)
	}

	if len(result.UnresolvedCredentials) == 0 {
		t.Error("UnresolvedCredentials is empty — import must report credentials needing secret mapping")
	}

	creds, _ := importDeps.Credentials.LoadCredentials()
	if len(creds) != 1 {
		t.Fatalf("credentials after import = %d, want 1", len(creds))
	}
	if creds[0].SecretID != cred.SecretID {
		t.Errorf("imported SecretID changed: got %q, want %q", creds[0].SecretID, cred.SecretID)
	}
}

func TestImportConfiguration_FullRoundTrip(t *testing.T) {
	cred := makeCredential("work-github", "alice", string(profile.AuthPassword))
	originalProfile := makeProfile("ssh:custom:test:0001", "test-host", "example.com")
	originalGroup := makeGroup("group-1", "Work")

	exportDeps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{profiles: []profile.SSHProfile{originalProfile}},
		Groups:      &fakeGroupRepo{groups: []profile.ProfileGroup{originalGroup}},
		Credentials: &fakeCredRepo{creds: []profile.Credential{cred}},
	}
	exported, err := export.ExportConfiguration(exportDeps)
	if err != nil {
		t.Fatalf("ExportConfiguration: %v", err)
	}

	importDeps := export.ImportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{},
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
	if result.CredentialsImported != 1 {
		t.Errorf("CredentialsImported = %d, want 1", result.CredentialsImported)
	}

	profiles, _ := importDeps.Profiles.LoadProfiles()
	if profiles[0].Name != originalProfile.Name {
		t.Errorf("profile name = %q, want %q", profiles[0].Name, originalProfile.Name)
	}
	groups, _ := importDeps.Groups.LoadGroups()
	if groups[0].Name != originalGroup.Name {
		t.Errorf("group name = %q, want %q", groups[0].Name, originalGroup.Name)
	}
	creds, _ := importDeps.Credentials.LoadCredentials()
	if creds[0].SecretID != cred.SecretID {
		t.Errorf("SecretID changed: got %q, want %q", creds[0].SecretID, cred.SecretID)
	}
}

// =========================================================================
// Proof: no mode resolves a secret
// =========================================================================

func TestNoModeResolvesASecret(t *testing.T) {
	// credential.Secret fails json.Marshal by design. If any mode
	// inadvertently included a Secret, json.Marshal would fail — this
	// test proves that doesn't happen.

	cred := makeCredential("test", "alice", string(profile.AuthPassword))
	deps := export.ConfigExportDeps{
		Profiles:    &fakeProfileRepo{},
		Groups:      &fakeGroupRepo{},
		Credentials: &fakeCredRepo{creds: []profile.Credential{cred}},
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
