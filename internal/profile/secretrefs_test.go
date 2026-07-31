package profile

import "testing"

// A credential holding a reference in every record-level field. The point of
// the fixture is that a reset must find all of them: a sweep that clears only
// one field leaves a store that still claims to hold secrets that are gone.
func credentialWithReferencesEverywhere() Credential {
	return Credential{
		ID:       "cred:everywhere:1",
		Name:     "everywhere",
		Username: "u",
		Auth:     AuthPassword,
		// Record-level fields.
		SecretID:            "sec:v1:file:aaaa",
		PassphraseSecretID:  "sec:v1:file:bbbb",
		KeyMaterialSecretID: "sec:v1:file:cccc",
	}
}

func TestCountSecretReferences_CountsEveryPlaceAReferenceLives(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(credentialWithReferencesEverywhere()); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	impact, err := s.CountSecretReferences()
	if err != nil {
		t.Fatalf("CountSecretReferences: %v", err)
	}
	if impact.SecretCount != 3 {
		t.Errorf("SecretCount = %d, want 3", impact.SecretCount)
	}
	if impact.CredentialCount != 1 {
		t.Errorf("CredentialCount = %d, want 1", impact.CredentialCount)
	}
}

// Distinct secrets, not distinct fields. One secret shared by two record-level
// fields is one thing the user loses, and telling them "2 saved passwords"
// when there is one overstates the damage in a confirmation they are reading
// to decide.
func TestCountSecretReferences_CountsASharedSecretOnce(t *testing.T) {
	s := newTestStore(t)
	shared := Credential{
		ID: "cred:shared:1", Name: "shared", Username: "u", Auth: AuthPassword,
		SecretID:           "sec:v1:file:same",
		PassphraseSecretID: "sec:v1:file:same",
	}
	if err := s.CreateCredential(shared); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	impact, err := s.CountSecretReferences()
	if err != nil {
		t.Fatalf("CountSecretReferences: %v", err)
	}
	if impact.SecretCount != 1 {
		t.Errorf("SecretCount = %d, want 1", impact.SecretCount)
	}
}
// A credential with no stored material must not be counted as affected — the
// confirmation would name connections that lose nothing.
func TestCountSecretReferences_IgnoresCredentialsHoldingNothing(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(Credential{
		ID: "cred:agent:1", Name: "agent", Username: "u", Auth: AuthAgent,
	}); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	impact, err := s.CountSecretReferences()
	if err != nil {
		t.Fatalf("CountSecretReferences: %v", err)
	}
	if impact.SecretCount != 0 || impact.CredentialCount != 0 {
		t.Errorf("impact = %+v, want zero", impact)
	}
}

func TestCountSecretReferences_CountsProfilesUsingAffectedCredentials(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(credentialWithReferencesEverywhere()); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	if err := s.CreateCredential(Credential{
		ID: "cred:agent:1", Name: "agent", Username: "u", Auth: AuthAgent,
	}); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	profileUsing := func(id, name, credID string) SSHProfile {
		return SSHProfile{
			Base:    Base{ID: id, Type: "ssh", Name: name},
			Options: StoredSSHProfileOptions{Host: "h", CredentialID: credID},
		}
	}
	for _, p := range []SSHProfile{
		profileUsing("p1", "one", "cred:everywhere:1"),
		profileUsing("p2", "two", "cred:everywhere:1"),
		// Uses the credential that stores nothing: unaffected.
		profileUsing("p3", "three", "cred:agent:1"),
	} {
		if err := s.CreateProfile(p); err != nil {
			t.Fatalf("CreateProfile %s: %v", p.ID, err)
		}
	}

	impact, err := s.CountSecretReferences()
	if err != nil {
		t.Fatalf("CountSecretReferences: %v", err)
	}
	if impact.ProfileCount != 2 {
		t.Errorf("ProfileCount = %d, want 2 — only profiles that lose something", impact.ProfileCount)
	}
}

// The operation the reset performs. Every reference goes; nothing else about
// the credential does — the user keeps their connections, their usernames and
// their key paths, and only stops claiming to hold secrets that no longer
// exist.
func TestClearAllSecretReferences_ClearsEveryPlaceAndKeepsTheRest(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(credentialWithReferencesEverywhere()); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	impact, err := s.ClearAllSecretReferences()
	if err != nil {
		t.Fatalf("ClearAllSecretReferences: %v", err)
	}
	if impact.SecretCount != 3 {
		t.Errorf("reported SecretCount = %d, want 3", impact.SecretCount)
	}

	creds, err := s.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("credential count = %d, want 1 — clearing references must not delete records", len(creds))
	}
	c := creds[0]

	if c.SecretID != "" || c.PassphraseSecretID != "" || c.KeyMaterialSecretID != "" {
		t.Errorf("record-level references survived: %+v", c)
	}
	// The identity of the credential is untouched.
	if c.Name != "everywhere" || c.Username != "u" {
		t.Errorf("clearing references changed the credential itself: %+v", c)
	}
}

// The reset is re-run after being interrupted, so this must be safe to call
// twice. The second call reports nothing cleared, which is what the UI needs
// in order not to claim it destroyed something again.
func TestClearAllSecretReferences_IsIdempotent(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateCredential(credentialWithReferencesEverywhere()); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	if _, err := s.ClearAllSecretReferences(); err != nil {
		t.Fatalf("first clear: %v", err)
	}

	impact, err := s.ClearAllSecretReferences()
	if err != nil {
		t.Fatalf("second clear: %v", err)
	}
	if impact.SecretCount != 0 {
		t.Errorf("second clear reported SecretCount = %d, want 0", impact.SecretCount)
	}
}

func TestClearAllSecretReferences_OnAnEmptyStore(t *testing.T) {
	s := newTestStore(t)
	impact, err := s.ClearAllSecretReferences()
	if err != nil {
		t.Fatalf("ClearAllSecretReferences: %v", err)
	}
	if impact.SecretCount != 0 || impact.CredentialCount != 0 || impact.ProfileCount != 0 {
		t.Errorf("impact = %+v, want zero", impact)
	}
}
