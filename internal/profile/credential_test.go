package profile

import "testing"

func TestCredentialWithPatch_PreservesUnsetFields(t *testing.T) {
	stored := Credential{
		ID:                 "cred:prod-ops:abc",
		Name:               "prod-ops",
		Username:           "ops",
		Auth:               AuthPassword,
		SecretID:           "sec:1111",
		PassphraseSecretID: "sec:2222",
	}

	name := "prod-ops-renamed"
	got := stored.WithPatch(CredentialPatch{Name: &name})

	if got.Name != "prod-ops-renamed" {
		t.Errorf("Name = %q, want prod-ops-renamed", got.Name)
	}
	if got.Username != "ops" {
		t.Errorf("Username = %q, want ops — an unset patch field must not clear it", got.Username)
	}
	if got.SecretID != "sec:1111" {
		t.Errorf("SecretID = %q, want sec:1111 — backend-owned and not patchable", got.SecretID)
	}
	if got.PassphraseSecretID != "sec:2222" {
		t.Errorf("PassphraseSecretID = %q, want sec:2222", got.PassphraseSecretID)
	}
	if got.ID != "cred:prod-ops:abc" {
		t.Errorf("ID = %q, want the stored ID — a patch never renames the record", got.ID)
	}
}

func TestCredentialWithPatch_PresentAndEmptyClears(t *testing.T) {
	stored := Credential{ID: "cred:x:1", Name: "x", Username: "u", Auth: AuthPublicKey, KeyPath: "/k"}

	empty := ""
	got := stored.WithPatch(CredentialPatch{KeyPath: &empty})

	if got.KeyPath != "" {
		t.Errorf("KeyPath = %q, want empty — a present-but-empty patch field clears", got.KeyPath)
	}
	if got.Username != "u" {
		t.Errorf("Username = %q, want u", got.Username)
	}
}

func TestCredentialCurrent_NoVersionsReadsAsOneVersion(t *testing.T) {
	// A credential with no Versions list: SecretID on the record, no versions.
	c := Credential{ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword, SecretID: "sec:1"}

	v, ok := c.Current()
	if !ok {
		t.Fatal("a credential with no versions must read as one current version")
	}
	if v.PasswordSecretID != "sec:1" {
		t.Errorf("PasswordSecretID = %q, want sec:1", v.PasswordSecretID)
	}
}

func TestCredentialVersions_CurrentSelectsByID(t *testing.T) {
	c := Credential{
		ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword,
		Versions: []CredentialVersion{
			{ID: "v7", PasswordSecretID: "sec:7"},
			{ID: "v8", PasswordSecretID: "sec:8"},
		},
		CurrentVersionID:   "v7",
		CandidateVersionID: "v8",
	}

	v, ok := c.Current()
	if !ok || v.ID != "v7" {
		t.Fatalf("Current() = %+v, %v; want v7", v, ok)
	}
	if got, ok := c.Version("v8"); !ok || got.PasswordSecretID != "sec:8" {
		t.Fatalf("Version(v8) = %+v, %v", got, ok)
	}
}

func TestCredentialVersion_ValidateAuthMethod(t *testing.T) {
	tests := []struct {
		version CredentialVersion
		wantErr bool
	}{
		{CredentialVersion{ID: "v1", Auth: AuthPassword, PasswordSecretID: "sec:1"}, false},
		{CredentialVersion{ID: "v1", Auth: AuthPassword, PasswordSecretID: "sec:1", KeyFingerprint: "fp"}, true},
		{CredentialVersion{ID: "v1", Auth: AuthPublicKey, KeyFingerprint: "fp"}, false},
		{CredentialVersion{ID: "v1", Auth: AuthPublicKey, KeyFingerprint: "fp", PassphraseSecretID: "sec:2"}, false},
		{CredentialVersion{ID: "v1", Auth: AuthAgent}, false},
		{CredentialVersion{ID: "v1", Auth: AuthAgent, PasswordSecretID: "sec:1"}, true},
		{CredentialVersion{ID: "v1", Auth: AuthKeyboardInteractive, PasswordSecretID: "sec:1"}, false},
		{CredentialVersion{ID: "v1", Auth: AuthKeyboardInteractive, KeyFingerprint: "fp"}, true},
	}

	for _, tt := range tests {
		err := tt.version.ValidateVersion()
		if tt.wantErr && err == nil {
			t.Errorf("ValidateVersion(%+v) = nil, want error", tt.version)
		}
		if !tt.wantErr && err != nil {
			t.Errorf("ValidateVersion(%+v) = %v, want nil", tt.version, err)
		}
	}
}
