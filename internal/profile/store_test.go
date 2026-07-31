package profile

import (
	"errors"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *JSONStore {
	t.Helper()
	return NewJSONStore(filepath.Join(t.TempDir(), "p.json"))
}

func TestCreateCredential_RejectsDuplicateID(t *testing.T) {
	s := newTestStore(t)
	c := Credential{ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword, SecretID: "sec:1"}
	if err := s.CreateCredential(c); err != nil {
		t.Fatalf("first create: %v", err)
	}

	dup := Credential{ID: "cred:a:1", Name: "impostor", Username: "u2", Auth: AuthAgent}
	if err := s.CreateCredential(dup); !errors.Is(err, ErrCredentialExists) {
		t.Fatalf("second create err = %v, want ErrCredentialExists", err)
	}

	got, err := s.LoadCredentials()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(got) != 1 || got[0].Name != "a" || got[0].SecretID != "sec:1" {
		t.Fatalf("a refused create must not modify the stored record, got %+v", got)
	}
}

func TestCreateCredential_RejectsEmptyID(t *testing.T) {
	s := newTestStore(t)
	err := s.CreateCredential(Credential{Name: "a", Username: "u"})
	if !errors.Is(err, ErrCredentialIDRequired) {
		t.Fatalf("err = %v, want ErrCredentialIDRequired", err)
	}
}

func TestUpdateCredential_RejectsMissingID(t *testing.T) {
	s := newTestStore(t)
	_, err := s.UpdateCredential("cred:nope:1", CredentialPatch{})
	if !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("err = %v, want ErrCredentialNotFound", err)
	}
	got, _ := s.LoadCredentials()
	if len(got) != 0 {
		t.Fatalf("a refused update must create nothing, got %d", len(got))
	}
}

func TestUpdateCredential_MergesAndKeepsSecretID(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword, SecretID: "sec:1",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	name := "renamed"
	got, err := s.UpdateCredential("cred:a:1", CredentialPatch{Name: &name})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Name != "renamed" {
		t.Errorf("Name = %q, want renamed", got.Name)
	}
	if got.SecretID != "sec:1" {
		t.Errorf("SecretID = %q, want sec:1", got.SecretID)
	}
}

func TestApplyGroups_MultiGroupUpdate(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateGroup(ProfileGroup{ID: "g1", Name: "Root"}); err != nil {
		t.Fatalf("create g1: %v", err)
	}
	if err := s.CreateGroup(ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"}); err != nil {
		t.Fatalf("create g2: %v", err)
	}
	if err := s.CreateGroup(ProfileGroup{ID: "g3", Name: "Grandchild", ParentGroupID: "g2"}); err != nil {
		t.Fatalf("create g3: %v", err)
	}

	// Apply two changes atomically: reparent g2 to root, reparent g3 to g1.
	// The old handleGroupApply would need two sequential calls; the second
	// call's validation would not see the first call's change to g2's
	// ParentGroupID, so the tree state viewed by the second validation would
	// differ from what is written.
	err := s.ApplyGroups([]ProfileGroup{
		{ID: "g2", Name: "Child", ParentGroupID: ""},
		{ID: "g3", Name: "Grandchild", ParentGroupID: "g1"},
	})
	if err != nil {
		t.Fatalf("ApplyGroups: %v", err)
	}

	groups, err := s.LoadGroups()
	if err != nil {
		t.Fatalf("LoadGroups: %v", err)
	}

	if len(groups) != 3 {
		t.Fatalf("got %d groups, want 3", len(groups))
	}

	// Assert by ID, not position.
	for _, g := range groups {
		switch g.ID {
		case "g1":
			if g.ParentGroupID != "" || g.Name != "Root" {
				t.Errorf("g1 = %+v, want Root with no parent", g)
			}
		case "g2":
			if g.ParentGroupID != "" {
				t.Errorf("g2 ParentGroupID = %q, want empty (reparented to root)", g.ParentGroupID)
			}
		case "g3":
			if g.ParentGroupID != "g1" {
				t.Errorf("g3 ParentGroupID = %q, want g1 (reparented under g1)", g.ParentGroupID)
			}
		}
	}
}

func TestApplyGroups_RejectsCycle(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateGroup(ProfileGroup{ID: "g1", Name: "Root"}); err != nil {
		t.Fatalf("create g1: %v", err)
	}
	if err := s.CreateGroup(ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"}); err != nil {
		t.Fatalf("create g2: %v", err)
	}

	// Apply two changes that together form a cycle: g1 -> g2, g2 -> g1.
	// With the old sequential pattern (LoadGroups → validate → UpdateGroup),
	// g1 would be updated first, then g2 would fail validation — leaving the
	// store in an inconsistent state (g1 reparented, g2 unchanged).
	// ApplyGroups must reject both under one lock.
	err := s.ApplyGroups([]ProfileGroup{
		{ID: "g1", Name: "Root", ParentGroupID: "g2"},
		{ID: "g2", Name: "Child", ParentGroupID: "g1"},
	})
	if err == nil {
		t.Fatal("expected cycle error, got nil")
	}

	// Store must be unchanged: g1 root, g2 child of g1. Assert by ID, not
	// position — LoadGroups makes no ordering guarantee.
	groups, err := s.LoadGroups()
	if err != nil {
		t.Fatalf("LoadGroups: %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("got %d groups, want 2", len(groups))
	}
	for _, g := range groups {
		switch g.ID {
		case "g1":
			if g.ParentGroupID != "" {
				t.Errorf("g1 ParentGroupID = %q after rejected cycle, want empty", g.ParentGroupID)
			}
		case "g2":
			if g.ParentGroupID != "g1" {
				t.Errorf("g2 ParentGroupID = %q after rejected cycle, want g1", g.ParentGroupID)
			}
		}
	}
}

func TestApplyGroups_RejectsUnknownGroup(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateGroup(ProfileGroup{ID: "g1", Name: "Root"}); err != nil {
		t.Fatalf("create g1: %v", err)
	}

	err := s.ApplyGroups([]ProfileGroup{
		{ID: "g1", Name: "Still Root"},
		{ID: "g2", Name: "Phantom"},
	})
	if !errors.Is(err, ErrGroupNotFound) {
		t.Fatalf("err = %v, want ErrGroupNotFound", err)
	}

	// g1 must be unchanged.
	groups, err := s.LoadGroups()
	if err != nil {
		t.Fatalf("LoadGroups: %v", err)
	}
	if len(groups) != 1 || groups[0].Name != "Root" {
		t.Fatalf("g1 mutated after rejected unknown group: %+v", groups[0])
	}
}

func TestApplyGroups_EmptySlice(t *testing.T) {
	s := newTestStore(t)
	if err := s.ApplyGroups(nil); err != nil {
		t.Fatalf("nil slice: %v", err)
	}
	if err := s.ApplyGroups([]ProfileGroup{}); err != nil {
		t.Fatalf("empty slice: %v", err)
	}
}

// ---------------------------------------------------------------------------
// PromoteVersion
// ---------------------------------------------------------------------------

func TestPromoteVersion_NoVersionsError(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:                 "cred:test:1",
		Name:               "test",
		Username:           "u",
		Auth:               AuthPassword,
		SecretID:           "sec:old",
		CandidateVersionID: "v2", // no Versions list
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err := s.PromoteVersion("cred:test:1")
	if err == nil {
		t.Fatal("PromoteVersion: expected error for credential with no versions, got nil")
	}
}

func TestPromoteVersion_NoCandidateError(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:       "cred:test:2",
		Name:     "test",
		Username: "u",
		Auth:     AuthPassword,
		Versions: []CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
		},
		CurrentVersionID: "v1",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err := s.PromoteVersion("cred:test:2")
	if err == nil {
		t.Fatal("PromoteVersion: expected error for no candidate, got nil")
	}
}

func TestPromoteVersion_Success(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:       "cred:test:3",
		Name:     "test",
		Username: "u",
		Auth:     AuthPassword,
		Versions: []CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
			{ID: "v2", PasswordSecretID: "sec:2"},
		},
		CurrentVersionID:   "v1",
		CandidateVersionID: "v2",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	cred, err := s.PromoteVersion("cred:test:3")
	if err != nil {
		t.Fatalf("PromoteVersion: %v", err)
	}
	if cred.CurrentVersionID != "v2" {
		t.Errorf("CurrentVersionID = %q, want v2", cred.CurrentVersionID)
	}
	if cred.CandidateVersionID != "" {
		t.Errorf("CandidateVersionID = %q, want empty", cred.CandidateVersionID)
	}
}

func TestPromoteVersion_PreviousVersionSelectableByPin(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:       "cred:test:4",
		Name:     "test",
		Username: "u",
		Auth:     AuthPassword,
		Versions: []CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
			{ID: "v2", PasswordSecretID: "sec:2"},
		},
		CurrentVersionID:   "v1",
		CandidateVersionID: "v2",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Promote v2 to current.
	cred, err := s.PromoteVersion("cred:test:4")
	if err != nil {
		t.Fatalf("PromoteVersion: %v", err)
	}
	if cred.CurrentVersionID != "v2" {
		t.Fatalf("CurrentVersionID = %q, want v2", cred.CurrentVersionID)
	}

	// v1 should still be in the version list and selectable.
	v, ok := cred.Version("v1")
	if !ok {
		t.Fatal("v1 not found after promotion")
	}
	if v.PasswordSecretID != "sec:1" {
		t.Errorf("v1 PasswordSecretID = %q, want sec:1", v.PasswordSecretID)
	}
}

// ClearSecretReferences is the metadata-first half of deleting a secret
// (ADR-0011 §4): every reference to the secret — record-level and in every
// version, password, passphrase and key material — is removed in ONE write,
// so nothing keeps pointing at a store entry that is about to be gone. A
// single write matters: a loop of per-field setters could fail halfway,
// leaving some references cleared and the deletion aborted.
func TestClearSecretReferences_ClearsEveryFieldInOneWrite(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:                  "cred:clear:1",
		Name:                "clear",
		Username:            "u",
		Auth:                AuthPublicKey,
		SecretID:            "sec:record-password",
		PassphraseSecretID:  "sec:record-passphrase",
		KeyMaterialSecretID: "sec:record-key",
		Versions: []CredentialVersion{
			{
				ID:                  "v1",
				PasswordSecretID:    "sec:v1-password",
				PassphraseSecretID:  "sec:v1-passphrase",
				KeyMaterialSecretID: "sec:v1-key",
				KeyFingerprint:      "SHA256:abcd",
			},
			{
				ID:                  "v2",
				PasswordSecretID:    "sec:v2-password",
				PassphraseSecretID:  "sec:v2-passphrase",
				KeyMaterialSecretID: "sec:v2-key",
				KeyFingerprint:      "SHA256:efgh",
			},
		},
		CurrentVersionID: "v2",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := s.ClearSecretReferences("sec:v2-passphrase"); err != nil {
		t.Fatalf("ClearSecretReferences: %v", err)
	}

	creds, err := s.LoadCredentials()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("credentials = %d, want 1 — clearing a reference must not delete the credential", len(creds))
	}
	got := creds[0]
	if got.SecretID != "sec:record-password" ||
		got.PassphraseSecretID != "sec:record-passphrase" ||
		got.KeyMaterialSecretID != "sec:record-key" {
		t.Errorf("record-level refs changed: %+v", got)
	}
	if got.Versions[0].PasswordSecretID != "sec:v1-password" ||
		got.Versions[0].PassphraseSecretID != "sec:v1-passphrase" ||
		got.Versions[0].KeyMaterialSecretID != "sec:v1-key" {
		t.Errorf("v1 refs changed: %+v", got.Versions[0])
	}
	if got.Versions[1].PasswordSecretID != "sec:v2-password" {
		t.Errorf("v2 password ref changed: %q", got.Versions[1].PasswordSecretID)
	}
	if got.Versions[1].PassphraseSecretID != "" {
		t.Errorf("v2 passphrase ref = %q, want cleared", got.Versions[1].PassphraseSecretID)
	}
	if got.Versions[1].KeyMaterialSecretID != "sec:v2-key" {
		t.Errorf("v2 key ref changed: %q", got.Versions[1].KeyMaterialSecretID)
	}
}

// Clearing a key-material reference also clears that version's fingerprint:
// the two describe the same material, and deleteKeyMaterialForCredential
// already clears them together — the bulk clear must not leave a fingerprint
// claiming a key the version no longer holds.
func TestClearSecretReferences_KeyMaterialClearsFingerprint(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID:       "cred:clear:2",
		Name:     "clear2",
		Username: "u",
		Auth:     AuthPublicKey,
		Versions: []CredentialVersion{
			{ID: "v1", KeyMaterialSecretID: "sec:key", KeyFingerprint: "SHA256:abcd"},
		},
		CurrentVersionID: "v1",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := s.ClearSecretReferences("sec:key"); err != nil {
		t.Fatalf("ClearSecretReferences: %v", err)
	}

	creds, err := s.LoadCredentials()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := creds[0].Versions[0]; got.KeyMaterialSecretID != "" || got.KeyFingerprint != "" {
		t.Errorf("after clear: key ref = %q, fingerprint = %q — both must be empty", got.KeyMaterialSecretID, got.KeyFingerprint)
	}
}

// Deleting a secret nothing references is a no-op write: the store stays
// intact and the call succeeds.
func TestClearSecretReferences_NoReferenceIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID: "cred:clear:3", Name: "clear3", Username: "u", Auth: AuthPassword,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := s.ClearSecretReferences("sec:never-stored"); err != nil {
		t.Fatalf("ClearSecretReferences(absent): %v", err)
	}
	creds, err := s.LoadCredentials()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("credentials = %d, want 1", len(creds))
	}
}
