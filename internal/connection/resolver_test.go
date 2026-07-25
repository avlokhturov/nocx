package connection

import (
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
)

// stubProfileStore implements profile.ProfileStore in memory.
type stubProfileStore struct {
	profiles    map[string]profile.SSHProfile
	credentials map[string]profile.Credential
}

func newStubProfileStore() *stubProfileStore {
	return &stubProfileStore{
		profiles:    make(map[string]profile.SSHProfile),
		credentials: make(map[string]profile.Credential),
	}
}

func (s *stubProfileStore) LoadProfiles() ([]profile.SSHProfile, error) {
	out := make([]profile.SSHProfile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p)
	}
	return out, nil
}

func (s *stubProfileStore) SaveProfile(p profile.SSHProfile) error {
	s.profiles[p.ID] = p
	return nil
}

func (s *stubProfileStore) DeleteProfile(id string) error {
	delete(s.profiles, id)
	return nil
}
func (s *stubProfileStore) LoadGroups() ([]profile.ProfileGroup, error) { return nil, nil }
func (s *stubProfileStore) SaveGroup(g profile.ProfileGroup) error      { return nil }
func (s *stubProfileStore) DeleteGroup(id string) error                 { return nil }
func (s *stubProfileStore) LoadCredentials() ([]profile.Credential, error) {
	out := make([]profile.Credential, 0, len(s.credentials))
	for _, c := range s.credentials {
		out = append(out, c)
	}
	return out, nil
}

func (s *stubProfileStore) SaveCredential(c profile.Credential) error {
	s.credentials[c.ID] = c
	return nil
}

func (s *stubProfileStore) DeleteCredential(id string) error {
	delete(s.credentials, id)
	return nil
}

// stubCredentialStore implements credential.CredentialStore.
type stubCredentialStore struct {
	passwords map[string]string
}

func newStubCredentialStore() *stubCredentialStore {
	return &stubCredentialStore{passwords: make(map[string]string)}
}

func (s *stubCredentialStore) LookupPassword(id credential.Identity) (string, error) {
	return s.passwords[id.User], nil
}

func (s *stubCredentialStore) SavePassword(id credential.Identity, password string) error {
	s.passwords[id.User] = password
	return nil
}

func (s *stubCredentialStore) DeletePassword(id credential.Identity) error {
	delete(s.passwords, id.User)
	return nil
}

func (s *stubCredentialStore) HasPassword(id credential.Identity) (bool, error) {
	_, ok := s.passwords[id.User]
	return ok, nil
}

func (s *stubCredentialStore) LookupKeyPassphrase(hash credential.KeyHash) (string, error) {
	return "", nil
}

func (s *stubCredentialStore) SaveKeyPassphrase(hash credential.KeyHash, passphrase string) error {
	return nil
}

func (s *stubCredentialStore) DeleteKeyPassphrase(hash credential.KeyHash) error {
	return nil
}

//nolint:errcheck
func TestResolver_CredentialMode(t *testing.T) {
	ps := newStubProfileStore()
	cs := newStubCredentialStore()

	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:work:abc123",
		Name:     "work-key",
		Username: "deploy",
		Auth:     "publicKey",
		KeyPath:  "/home/user/.ssh/work_rsa",
	})

	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:1", Name: "staging"},
		Options: profile.SSHProfileOptions{
			Host:         "staging.example.com",
			Port:         2222,
			CredentialID: "cred:work:abc123",
		},
	})

	_ = cs.SavePassword(credential.Identity{User: "cred:work:abc123"}, "s3cret")

	r := NewResolver(ps, cs)
	host, cfg, err := r.Resolve("profile:1")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "staging.example.com" {
		t.Errorf("host = %q, want staging.example.com", host)
	}
	if cfg.Port != 2222 {
		t.Errorf("Port = %d, want 2222", cfg.Port)
	}
	if cfg.User != "deploy" {
		t.Errorf("User = %q, want deploy", cfg.User)
	}
	if cfg.AuthMode != "publicKey" {
		t.Errorf("AuthMode = %q, want publicKey", cfg.AuthMode)
	}
	if cfg.KeyFile != "/home/user/.ssh/work_rsa" {
		t.Errorf("KeyFile = %q, want /home/user/.ssh/work_rsa", cfg.KeyFile)
	}

	if cfg.Credentials == nil {
		t.Fatal("Credentials is nil, want wired credential store")
	}
	if cfg.CredIdentity.User != "cred:work:abc123" {
		t.Errorf("CredIdentity.User = %q, want cred:work:abc123", cfg.CredIdentity.User)
	}
}

//nolint:errcheck
func TestResolver_InlineMode(t *testing.T) {
	ps := newStubProfileStore()
	cs := newStubCredentialStore()

	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:inline", Name: "legacy"},
		Options: profile.SSHProfileOptions{
			Host: "legacy.example.com",
			Port: 22,
			User: "admin",
			Auth: "password",
		},
	})

	r := NewResolver(ps, cs)
	host, cfg, err := r.Resolve("profile:inline")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "legacy.example.com" {
		t.Errorf("host = %q, want legacy.example.com", host)
	}
	if cfg.User != "admin" {
		t.Errorf("User = %q, want admin", cfg.User)
	}
	if cfg.AuthMode != "password" {
		t.Errorf("AuthMode = %q, want password", cfg.AuthMode)
	}
	if cfg.Port != 22 {
		t.Errorf("Port = %d, want 22", cfg.Port)
	}
	if cfg.Credentials != nil {
		t.Error("Credentials should be nil in inline mode")
	}
}

//nolint:errcheck
func TestResolver_UnknownProfile(t *testing.T) {
	ps := newStubProfileStore()
	cs := newStubCredentialStore()

	r := NewResolver(ps, cs)
	_, _, err := r.Resolve("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown profile")
	}
}

//nolint:errcheck
func TestResolver_JumpHost(t *testing.T) {
	ps := newStubProfileStore()
	cs := newStubCredentialStore()

	// Jump profile
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:jump:xyz", Name: "jump-cred", Username: "jumpuser", Auth: "publicKey",
		KeyPath: "/home/user/.ssh/jump_rsa",
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:jump", Name: "jump"},
		Options: profile.SSHProfileOptions{Host: "jump.example.com", Port: 22, CredentialID: "cred:jump:xyz"},
	})

	// Target profile
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:tgt:def", Name: "tgt-cred", Username: "tgtuser", Auth: "password",
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:tgt", Name: "target"},
		Options: profile.SSHProfileOptions{
			Host:         "target.internal",
			Port:         2222,
			CredentialID: "cred:tgt:def",
			JumpHost:     "profile:jump",
		},
	})

	_ = cs.SavePassword(credential.Identity{User: "cred:tgt:def"}, "tgt-secret")
	_ = cs.SavePassword(credential.Identity{User: "cred:jump:xyz"}, "jump-secret")

	r := NewResolver(ps, cs)
	host, cfg, err := r.Resolve("profile:tgt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "target.internal" {
		t.Errorf("host = %q, want target.internal", host)
	}

	if cfg.Credentials == nil {
		t.Fatal("Target Credentials is nil")
	}
	if cfg.CredIdentity.User != "cred:tgt:def" {
		t.Errorf("Target CredIdentity = %q", cfg.CredIdentity.User)
	}

	if cfg.JumpCredentials == nil {
		t.Fatal("JumpCredentials is nil")
	}
	if cfg.JumpCredIdentity.User != "cred:jump:xyz" {
		t.Errorf("JumpCredIdentity = %q, want cred:jump:xyz", cfg.JumpCredIdentity.User)
	}

	if cfg.JumpHost != "jump.example.com" {
		t.Errorf("JumpHost = %q, want jump.example.com", cfg.JumpHost)
	}
	if cfg.JumpPort != 22 {
		t.Errorf("JumpPort = %d, want 22", cfg.JumpPort)
	}
	if cfg.JumpUser != "jumpuser" {
		t.Errorf("JumpUser = %q, want jumpuser", cfg.JumpUser)
	}
	if cfg.JumpKeyFile != "/home/user/.ssh/jump_rsa" {
		t.Errorf("JumpKeyFile = %q, want /home/user/.ssh/jump_rsa", cfg.JumpKeyFile)
	}
}

//nolint:errcheck
func TestResolver_JumpHostInlineMode(t *testing.T) {
	ps := newStubProfileStore()
	cs := newStubCredentialStore()

	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:jump2", Name: "jump-inline"},
		Options: profile.SSHProfileOptions{Host: "jump2.example.com", Port: 2222, User: "jumper", Auth: "agent"},
	})

	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:tgt:ghi", Name: "tgt-cred2", Username: "tgtuser2", Auth: "keyboardInteractive",
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:tgt2", Name: "target2"},
		Options: profile.SSHProfileOptions{
			Host:         "target2.internal",
			CredentialID: "cred:tgt:ghi",
			JumpHost:     "profile:jump2",
		},
	})

	r := NewResolver(ps, cs)
	_, cfg, err := r.Resolve("profile:tgt2")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if cfg.JumpHost != "jump2.example.com" {
		t.Errorf("JumpHost = %q, want jump2.example.com", cfg.JumpHost)
	}
	if cfg.JumpUser != "jumper" {
		t.Errorf("JumpUser = %q, want jumper", cfg.JumpUser)
	}
	if cfg.JumpAuthMode != "agent" {
		t.Errorf("JumpAuthMode = %q, want agent", cfg.JumpAuthMode)
	}
	if cfg.JumpCredentials != nil {
		t.Error("JumpCredentials should be nil for inline jump")
	}
}
