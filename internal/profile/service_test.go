package profile

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newTestService(t *testing.T) (*ProfileService, string) {
	t.Helper()
	dir := t.TempDir()
	storePath := filepath.Join(dir, "p.json")
	store := NewJSONStore(storePath)
	return NewProfileService(store), storePath
}

func svc(t *testing.T) *ProfileService {
	t.Helper()
	s, _ := newTestService(t)
	return s
}

func makeTestProfile(id, name, host string) SSHProfile {
	return SSHProfile{
		Base: Base{ID: id, Type: "ssh", Name: name},
		Options: StoredSSHProfileOptions{
			Host: host,
			Port: Ptr(22),
			User: Ptr("testuser"),
		},
	}
}

func makeTestCred(id, name, username, auth string) Credential {
	return Credential{
		ID:       id,
		Name:     name,
		Username: username,
		Auth:     AuthMode(auth),
	}
}

func makeTestGroup(id, name string, defaults *ProfileDefaults) ProfileGroup {
	return ProfileGroup{ID: id, Name: name, Defaults: defaults}
}

// ---------------------------------------------------------------------------
// SaveProfile
// ---------------------------------------------------------------------------

func TestServiceSaveProfile_CreatesNew(t *testing.T) {
	s := svc(t)
	p := makeTestProfile("ssh:custom:test:1", "test", "example.com")
	if err := s.SaveProfile(p); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 1 || all.Profiles[0].ID != "ssh:custom:test:1" {
		t.Fatalf("expected 1 profile, got %d", len(all.Profiles))
	}
}

func TestServiceSaveProfile_UpdatesExisting(t *testing.T) {
	s := svc(t)
	p := makeTestProfile("ssh:custom:test:1", "original", "example.com")
	if err := s.SaveProfile(p); err != nil {
		t.Fatalf("first SaveProfile: %v", err)
	}
	p.Name = "renamed"
	if err := s.SaveProfile(p); err != nil {
		t.Fatalf("second SaveProfile: %v", err)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 1 || all.Profiles[0].Name != "renamed" {
		t.Fatalf("profile not updated, got Name=%q", all.Profiles[0].Name)
	}
}

func TestServiceSaveProfile_RejectsEmptyHost(t *testing.T) {
	s := svc(t)
	p := SSHProfile{
		Base:    Base{ID: "ssh:custom:test:1", Type: "ssh", Name: "test"},
		Options: StoredSSHProfileOptions{},
	}
	err := s.SaveProfile(p)
	if err == nil || !contains(err.Error(), "host is required") {
		t.Fatalf("expected host required error, got %v", err)
	}
}

func TestServiceSaveProfile_RejectsEmptyID(t *testing.T) {
	s := svc(t)
	p := makeTestProfile("", "test", "example.com")
	err := s.SaveProfile(p)
	if !errors.Is(err, ErrProfileIDRequired) {
		t.Fatalf("expected ErrProfileIDRequired, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// SaveGroup
// ---------------------------------------------------------------------------

func TestServiceSaveGroup_CreatesNew(t *testing.T) {
	s := svc(t)
	g := makeTestGroup("g1", "Prod", nil)
	if err := s.SaveGroup(g); err != nil {
		t.Fatalf("SaveGroup: %v", err)
	}
	all, _ := s.store.LoadAll()
	if len(all.Groups) != 1 || all.Groups[0].ID != "g1" {
		t.Fatalf("expected 1 group, got %d", len(all.Groups))
	}
}

func TestServiceSaveGroup_RejectsUnknownDefaultKeys(t *testing.T) {
	s := svc(t)
	d, err := DecodeDefaults(map[string]any{"typoField": "value"})
	if err != nil {
		t.Fatalf("DecodeDefaults: %v", err)
	}
	g := ProfileGroup{ID: "g1", Name: "Bad", Defaults: &d}
	err = s.SaveGroup(g)
	if err == nil || !contains(err.Error(), "unknown") {
		t.Fatalf("expected unknown keys error, got %v", err)
	}
}

func TestServiceSaveGroup_ValidatesTree(t *testing.T) {
	s := svc(t)
	if err := s.SaveGroup(makeTestGroup("g1", "Parent", nil)); err != nil {
		t.Fatalf("create parent: %v", err)
	}
	child := makeTestGroup("g2", "Child", nil)
	child.ParentGroupID = "g1"
	if err := s.SaveGroup(child); err != nil {
		t.Fatalf("create child: %v", err)
	}
	// Create cycle: g1 -> g2 -> g1 by updating g1's parent to g2.
	cycle := makeTestGroup("g1", "Cycling", nil)
	cycle.ParentGroupID = "g2"
	err := s.SaveGroup(cycle)
	if err == nil {
		t.Fatal("expected cycle error, got nil")
	}
}

// ---------------------------------------------------------------------------
// SaveCredential — collision policy
// ---------------------------------------------------------------------------

func TestServiceSaveCredential_CreatesNew(t *testing.T) {
	s := svc(t)
	c := makeTestCred("cred:a:1", "a", "alice", "password")
	if err := s.SaveCredential(c); err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}
	all, _ := s.store.LoadAll()
	if len(all.Credentials) != 1 || all.Credentials[0].ID != "cred:a:1" {
		t.Fatalf("expected 1 credential, got %d", len(all.Credentials))
	}
}

func TestServiceSaveCredential_RefusesOverwrite(t *testing.T) {
	s := svc(t)
	c := makeTestCred("cred:a:1", "a", "alice", "password")
	if err := s.SaveCredential(c); err != nil {
		t.Fatalf("first SaveCredential: %v", err)
	}
	err := s.SaveCredential(c)
	if !errors.Is(err, ErrCredentialExists) {
		t.Fatalf("expected ErrCredentialExists, got %v", err)
	}
	all, _ := s.store.LoadAll()
	if len(all.Credentials) != 1 {
		t.Fatalf("credential count changed after refused overwrite: %d", len(all.Credentials))
	}
}

func TestServiceSaveCredential_ValidatesFields(t *testing.T) {
	s := svc(t)
	c := Credential{ID: "cred:a:1", Username: "alice", Auth: AuthPassword}
	err := s.SaveCredential(c)
	if !errors.Is(err, ErrCredentialNameRequired) {
		t.Fatalf("expected ErrCredentialNameRequired, got %v", err)
	}
	c = Credential{ID: "cred:a:1", Name: "a", Auth: AuthPassword}
	err = s.SaveCredential(c)
	if !errors.Is(err, ErrCredentialUsernameRequired) {
		t.Fatalf("expected ErrCredentialUsernameRequired, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// AtomicImport — basic success
// ---------------------------------------------------------------------------

func TestAtomicImport_FullSuccess(t *testing.T) {
	s := svc(t)
	profiles := []SSHProfile{
		makeTestProfile("ssh:custom:p1:1", "web", "web.example.com"),
		makeTestProfile("ssh:custom:p2:1", "db", "db.example.com"),
	}
	groups := []ProfileGroup{makeTestGroup("g1", "Prod", nil)}
	creds := []Credential{makeTestCred("cred:a:1", "prod-pass", "deploy", "password")}

	result := s.AtomicImport(profiles, groups, creds)
	if len(result.ImportErrors) > 0 {
		t.Fatalf("unexpected errors: %v", result.ImportErrors)
	}
	if result.ProfilesImported != 2 {
		t.Errorf("ProfilesImported = %d, want 2", result.ProfilesImported)
	}
	if result.GroupsImported != 1 {
		t.Errorf("GroupsImported = %d, want 1", result.GroupsImported)
	}
	if result.CredentialsImported != 1 {
		t.Errorf("CredentialsImported = %d, want 1", result.CredentialsImported)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 2 || len(all.Groups) != 1 || len(all.Credentials) != 1 {
		t.Fatalf("store state: profiles=%d groups=%d creds=%d",
			len(all.Profiles), len(all.Groups), len(all.Credentials))
	}
}

// ---------------------------------------------------------------------------
// AtomicImport — collision policy
// ---------------------------------------------------------------------------

func TestAtomicImport_ProfileOverwrite(t *testing.T) {
	s := svc(t)
	p1 := makeTestProfile("ssh:custom:p1:1", "original", "original.example.com")
	if err := s.SaveProfile(p1); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	result := s.AtomicImport(
		[]SSHProfile{makeTestProfile("ssh:custom:p1:1", "overwritten", "new.example.com")},
		nil, nil,
	)
	if len(result.ImportErrors) > 0 {
		t.Fatalf("import errors: %v", result.ImportErrors)
	}
	if result.ProfilesImported != 1 {
		t.Errorf("ProfilesImported = %d, want 1", result.ProfilesImported)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 1 || all.Profiles[0].Name != "overwritten" {
		t.Errorf("profile not overwritten, got Name=%q", all.Profiles[0].Name)
	}
}

func TestAtomicImport_GroupOverwrite(t *testing.T) {
	s := svc(t)
	g1 := makeTestGroup("g1", "Original", nil)
	if err := s.SaveGroup(g1); err != nil {
		t.Fatalf("SaveGroup: %v", err)
	}
	result := s.AtomicImport(
		nil,
		[]ProfileGroup{makeTestGroup("g1", "Overwritten", nil)},
		nil,
	)
	if len(result.ImportErrors) > 0 {
		t.Fatalf("import errors: %v", result.ImportErrors)
	}
	all, _ := s.store.LoadAll()
	if len(all.Groups) != 1 || all.Groups[0].Name != "Overwritten" {
		t.Errorf("group not overwritten, got Name=%q", all.Groups[0].Name)
	}
}

func TestAtomicImport_CredentialOverwriteRefused(t *testing.T) {
	s := svc(t)
	c1 := makeTestCred("cred:a:1", "original", "alice", "password")
	if err := s.SaveCredential(c1); err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}
	result := s.AtomicImport(
		nil, nil,
		[]Credential{makeTestCred("cred:a:1", "impostor", "bob", "password")},
	)
	if result.CredentialsRefused != 1 {
		t.Errorf("CredentialsRefused = %d, want 1", result.CredentialsRefused)
	}
	if len(result.ImportErrors) == 0 {
		t.Fatal("expected import errors, got none")
	}
	all, _ := s.store.LoadAll()
	if len(all.Credentials) != 1 || all.Credentials[0].Name != "original" {
		t.Errorf("credential was modified despite refusal; got Name=%q", all.Credentials[0].Name)
	}
}

// ---------------------------------------------------------------------------
// AtomicImport — imported profile naming existing local credential
// ---------------------------------------------------------------------------

func TestAtomicImport_ProfileReferencingExistingCredentialMarkedForReview(t *testing.T) {
	s := svc(t)
	localCred := makeTestCred("cred:local:1", "local-pass", "deploy", "password")
	if err := s.SaveCredential(localCred); err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}
	importedProfile := makeTestProfile("ssh:custom:p1:1", "web", "web.example.com")
	importedProfile.Options.CredentialID = "cred:local:1"

	result := s.AtomicImport([]SSHProfile{importedProfile}, nil, nil)
	if len(result.ImportErrors) > 0 {
		t.Fatalf("import errors: %v", result.ImportErrors)
	}
	if result.ProfilesMarkedReview != 1 {
		t.Errorf("ProfilesMarkedReview = %d, want 1", result.ProfilesMarkedReview)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 1 || !all.Profiles[0].NeedsReview {
		t.Errorf("profile not marked for review, NeedsReview=%v", all.Profiles[0].NeedsReview)
	}
}

func TestAtomicImport_NewCredentialNotMarkedForReview(t *testing.T) {
	s := svc(t)
	prof := makeTestProfile("ssh:custom:p1:1", "web", "web.example.com")
	prof.Options.CredentialID = "cred:new:1"
	cred := makeTestCred("cred:new:1", "new-pass", "deploy", "password")

	result := s.AtomicImport([]SSHProfile{prof}, nil, []Credential{cred})
	if len(result.ImportErrors) > 0 {
		t.Fatalf("import errors: %v", result.ImportErrors)
	}
	if result.ProfilesMarkedReview != 0 {
		t.Errorf("ProfilesMarkedReview = %d, want 0", result.ProfilesMarkedReview)
	}
	all, _ := s.store.LoadAll()
	if len(all.Profiles) != 1 || all.Profiles[0].NeedsReview {
		t.Errorf("profile should NOT be marked for review, NeedsReview=%v", all.Profiles[0].NeedsReview)
	}
}

// ---------------------------------------------------------------------------
// Transactional import — partial failure leaves store unchanged
// ---------------------------------------------------------------------------

func TestAtomicImport_Transactional_LastRecordFailure(t *testing.T) {
	s, storePath := newTestService(t)

	// Read raw file before import.
	// #nosec G304 -- t.TempDir() path, never user input
	preRaw, err := os.ReadFile(storePath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read before: %v", err)
	}
	if os.IsNotExist(err) {
		preRaw = []byte{}
	}

	profiles := []SSHProfile{
		makeTestProfile("ssh:custom:p1:1", "web", "web.example.com"),
		makeTestProfile("ssh:custom:p2:1", "db", "db.example.com"),
	}
	groups := []ProfileGroup{makeTestGroup("g1", "Prod", nil)}
	// Invalid credential — missing Username.
	creds := []Credential{
		{ID: "cred:bad:1", Name: "bad", Auth: AuthPassword},
	}

	result := s.AtomicImport(profiles, groups, creds)
	if len(result.ImportErrors) == 0 {
		t.Fatal("expected import errors for invalid credential, got none")
	}
	if result.CredentialsImported != 0 {
		t.Errorf("CredentialsImported = %d, want 0", result.CredentialsImported)
	}

	// Read raw file after import.
	// #nosec G304 -- t.TempDir() path, never user input
	postRaw, err := os.ReadFile(storePath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read after: %v", err)
	}
	if os.IsNotExist(err) {
		postRaw = []byte{}
	}

	if !bytes.Equal(preRaw, postRaw) {
		t.Error("store file changed byte-for-byte after failed import")
	}
}

func TestAtomicImport_Transactional_CredentialCollision(t *testing.T) {
	s, storePath := newTestService(t)

	// Pre-populate a credential.
	existing := makeTestCred("cred:keep:1", "keep-me", "alice", "password")
	if err := s.SaveCredential(existing); err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}

	// #nosec G304 -- t.TempDir() path, never user input
	preRaw, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatalf("read before: %v", err)
	}

	// Import with credential collision — should fail entirely.
	result := s.AtomicImport(
		[]SSHProfile{makeTestProfile("ssh:custom:p1:1", "web", "web.example.com")},
		nil,
		[]Credential{makeTestCred("cred:keep:1", "impostor", "mallory", "password")},
	)
	if result.CredentialsRefused != 1 {
		t.Errorf("CredentialsRefused = %d, want 1", result.CredentialsRefused)
	}

	// #nosec G304 -- t.TempDir() path, never user input
	postRaw, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !bytes.Equal(preRaw, postRaw) {
		t.Error("store file changed byte-for-byte after failed import")
	}

	all, _ := s.store.LoadAll()
	if len(all.Credentials) != 1 || all.Credentials[0].Name != "keep-me" {
		t.Errorf("existing credential modified: got Name=%q", all.Credentials[0].Name)
	}
}

// ---------------------------------------------------------------------------
// ClearReviewFlag
// ---------------------------------------------------------------------------

func TestClearReviewFlag_ClearsFlag(t *testing.T) {
	s := svc(t)
	p := makeTestProfile("ssh:custom:p1:1", "web", "web.example.com")
	p.NeedsReview = true
	if err := s.SaveProfile(p); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	updated, err := s.ClearReviewFlag("ssh:custom:p1:1")
	if err != nil {
		t.Fatalf("ClearReviewFlag: %v", err)
	}
	if updated.NeedsReview {
		t.Error("NeedsReview still true after clearing")
	}
	all, _ := s.store.LoadAll()
	if all.Profiles[0].NeedsReview {
		t.Error("NeedsReview still true on stored profile after clearing")
	}
}

func TestClearReviewFlag_RejectsNonexistent(t *testing.T) {
	s := svc(t)
	_, err := s.ClearReviewFlag("ssh:custom:nope:1")
	if !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("expected ErrProfileNotFound, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func contains(s, substr string) bool {
	if len(s) < len(substr) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
