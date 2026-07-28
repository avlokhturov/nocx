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
	c := Credential{ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword, SecretID: "sec:1", Host: "10.0.0.1"}
	if err := s.CreateCredential(c); err != nil {
		t.Fatalf("first create: %v", err)
	}

	dup := Credential{ID: "cred:a:1", Name: "impostor", Username: "u2", Auth: AuthAgent, Host: "10.0.0.1"}
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
		ID: "cred:a:1", Name: "a", Username: "u", Auth: AuthPassword, SecretID: "sec:1", Host: "10.0.0.1",
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
