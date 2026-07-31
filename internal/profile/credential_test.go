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


