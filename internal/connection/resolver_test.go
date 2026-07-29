package connection

import (
	"errors"
	"fmt"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
)

// stubProfileStore implements both profile.ProfileRepository and
// profile.CredentialMetadataRepository in memory, for tests that
// need both.
type stubProfileStore struct {
	profiles    map[string]profile.SSHProfile
	groups      map[string]profile.ProfileGroup
	credentials map[string]profile.Credential
}

func newStubProfileStore() *stubProfileStore {
	return &stubProfileStore{
		profiles:    make(map[string]profile.SSHProfile),
		groups:      make(map[string]profile.ProfileGroup),
		credentials: make(map[string]profile.Credential),
	}
}

// --- profile.ProfileRepository ---

func (s *stubProfileStore) LoadProfiles() ([]profile.SSHProfile, error) {
	out := make([]profile.SSHProfile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p)
	}
	return out, nil
}

func (s *stubProfileStore) CreateProfile(p profile.SSHProfile) error {
	if _, ok := s.profiles[p.ID]; ok {
		return profile.ErrProfileExists
	}
	s.profiles[p.ID] = p
	return nil
}

func (s *stubProfileStore) UpdateProfile(p profile.SSHProfile) error {
	if _, ok := s.profiles[p.ID]; !ok {
		return profile.ErrProfileNotFound
	}
	s.profiles[p.ID] = p
	return nil
}

func (s *stubProfileStore) DeleteProfile(id string) error {
	delete(s.profiles, id)
	return nil
}

// --- profile.CredentialMetadataRepository ---

func (s *stubProfileStore) LoadCredentials() ([]profile.Credential, error) {
	out := make([]profile.Credential, 0, len(s.credentials))
	for _, c := range s.credentials {
		out = append(out, c)
	}
	return out, nil
}

// SaveCredential is no longer part of CredentialMetadataRepository — it was the
// upsert that made create and update indistinguishable. It survives here as a
// test-local helper because the resolver fixtures below only ever need "put this
// credential in the store", not the create/update distinction the interface now
// draws.
func (s *stubProfileStore) SaveCredential(c profile.Credential) error {
	s.credentials[c.ID] = c
	return nil
}

// SaveProfile is a test-local helper like SaveCredential — the interface
// now uses CreateProfile/UpdateProfile, but test fixtures want "put this
// in the store" without worrying about existence.
func (s *stubProfileStore) SaveProfile(p profile.SSHProfile) error {
	s.profiles[p.ID] = p
	return nil
}

// SaveGroup is a test-local helper for the same reason.
func (s *stubProfileStore) SaveGroup(g profile.ProfileGroup) error {
	s.groups[g.ID] = g
	return nil
}

// LoadGroups / CreateGroup / UpdateGroup / DeleteGroup are needed for
// the stub to satisfy profile.GroupRepository where required.
func (s *stubProfileStore) LoadGroups() ([]profile.ProfileGroup, error) {
	out := make([]profile.ProfileGroup, 0, len(s.groups))
	for _, g := range s.groups {
		out = append(out, g)
	}
	return out, nil
}

func (s *stubProfileStore) CreateGroup(g profile.ProfileGroup) error {
	if _, ok := s.groups[g.ID]; ok {
		return profile.ErrGroupExists
	}
	s.groups[g.ID] = g
	return nil
}

func (s *stubProfileStore) UpdateGroup(g profile.ProfileGroup) error {
	if _, ok := s.groups[g.ID]; !ok {
		return profile.ErrGroupNotFound
	}
	s.groups[g.ID] = g
	return nil
}

func (s *stubProfileStore) DeleteGroup(id string) error {
	delete(s.groups, id)
	return nil
}

func (s *stubProfileStore) CreateCredential(c profile.Credential) error {
	if _, ok := s.credentials[c.ID]; ok {
		return profile.ErrCredentialExists
	}
	s.credentials[c.ID] = c
	return nil
}

func (s *stubProfileStore) UpdateCredential(id string, p profile.CredentialPatch) (profile.Credential, error) {
	existing, ok := s.credentials[id]
	if !ok {
		return profile.Credential{}, profile.ErrCredentialNotFound
	}
	merged := existing.WithPatch(p)
	s.credentials[id] = merged
	return merged, nil
}

func (s *stubProfileStore) UpdateCurrentVersionRefs(id, passwordSecretID, passphraseSecretID string) error {
	existing, ok := s.credentials[id]
	if !ok {
		return profile.ErrCredentialNotFound
	}
	if len(existing.Versions) == 0 {
		existing.SecretID = passwordSecretID
		existing.PassphraseSecretID = passphraseSecretID
	} else {
		for j := range existing.Versions {
			if existing.Versions[j].ID == existing.CurrentVersionID {
				existing.Versions[j].PasswordSecretID = passwordSecretID
				existing.Versions[j].PassphraseSecretID = passphraseSecretID
				break
			}
		}
	}
	s.credentials[id] = existing
	return nil
}

func (s *stubProfileStore) AppendCredentialVersion(id, passwordSecretID, passphraseSecretID string) error {
	existing, ok := s.credentials[id]
	if !ok {
		return profile.ErrCredentialNotFound
	}
	if len(existing.Versions) == 0 {
		existing.Versions = []profile.CredentialVersion{
			{
				ID:                 "v1",
				PasswordSecretID:   existing.SecretID,
				PassphraseSecretID: existing.PassphraseSecretID,
			},
		}
		existing.CurrentVersionID = "v1"
		existing.SecretID = ""
		existing.PassphraseSecretID = ""
	}
	nextID := fmt.Sprintf("v%d", len(existing.Versions)+1)
	existing.Versions = append(existing.Versions, profile.CredentialVersion{
		ID:                 nextID,
		PasswordSecretID:   passwordSecretID,
		PassphraseSecretID: passphraseSecretID,
	})
	existing.CurrentVersionID = nextID
	s.credentials[id] = existing
	return nil
}

func (s *stubProfileStore) SetCandidateVersion(id, passwordSecretID, passphraseSecretID string) error {
	existing, ok := s.credentials[id]
	if !ok {
		return profile.ErrCredentialNotFound
	}
	if existing.CandidateVersionID != "" {
		return profile.ErrCandidateExists
	}
	if len(existing.Versions) == 0 {
		existing.Versions = []profile.CredentialVersion{
			{
				ID:                 "v1",
				PasswordSecretID:   existing.SecretID,
				PassphraseSecretID: existing.PassphraseSecretID,
			},
		}
		existing.CurrentVersionID = "v1"
		existing.SecretID = ""
		existing.PassphraseSecretID = ""
	}
	nextID := fmt.Sprintf("v%d", len(existing.Versions)+1)
	newVersion := profile.CredentialVersion{
		ID:                 nextID,
		PasswordSecretID:   passwordSecretID,
		PassphraseSecretID: passphraseSecretID,
	}
	if err := newVersion.ValidateVersion(); err != nil {
		return err
	}
	existing.Versions = append(existing.Versions, newVersion)
	existing.CandidateVersionID = nextID
	s.credentials[id] = existing
	return nil
}

func (s *stubProfileStore) ClearCandidateVersion(id string) error {
	existing, ok := s.credentials[id]
	if !ok {
		return profile.ErrCredentialNotFound
	}
	if existing.CandidateVersionID == "" {
		return nil // idempotent
	}
	remaining := make([]profile.CredentialVersion, 0, len(existing.Versions)-1)
	for _, v := range existing.Versions {
		if v.ID != existing.CandidateVersionID {
			remaining = append(remaining, v)
		}
	}
	existing.Versions = remaining
	existing.CandidateVersionID = ""
	s.credentials[id] = existing
	return nil
}

func (s *stubProfileStore) DeleteCredential(id string) error {
	delete(s.credentials, id)
	return nil
}

// stubSecretStore implements credential.SecretStore in memory.
type stubSecretStore struct {
	secrets map[credential.SecretID]credential.Secret
}

func newStubSecretStore() *stubSecretStore {
	return &stubSecretStore{secrets: make(map[credential.SecretID]credential.Secret)}
}

func (s *stubSecretStore) Get(id credential.SecretID) (credential.Secret, error) {
	val, ok := s.secrets[id]
	if !ok {
		return credential.Secret{}, nil
	}
	return val, nil
}

func (s *stubSecretStore) Set(id credential.SecretID, value credential.Secret) error {
	s.secrets[id] = value
	return nil
}

func (s *stubSecretStore) Delete(id credential.SecretID) error {
	delete(s.secrets, id)
	return nil
}

func (s *stubSecretStore) Exists(id credential.SecretID) (bool, error) {
	_, ok := s.secrets[id]
	return ok, nil
}

//nolint:errcheck
func TestResolver_CredentialMode(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	pwID := credential.NewSecretID()
	_ = ss.Set(pwID, credential.NewSecret("s3cret"))

	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:work:abc123",
		Name:     "work-key",
		Username: "deploy",
		Auth:     "publicKey",
		KeyPath:  "/home/user/.ssh/work_rsa",
		SecretID: string(pwID),
	})

	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:1", Name: "staging"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "staging.example.com",
			Port:         profile.Ptr(2222),
			CredentialID: "cred:work:abc123",
		},
	})

	r := NewResolver(ps, ps, ps, ss)
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

	if cfg.Secrets == nil {
		t.Fatal("Secrets is nil, want wired secret store")
	}
	if cfg.SecretID != pwID {
		t.Errorf("SecretID = %q, want %q", cfg.SecretID, pwID)
	}
}

//nolint:errcheck
func TestResolver_InlineMode(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:inline", Name: "legacy"},
		Options: profile.StoredSSHProfileOptions{
			Host: "legacy.example.com",
			Port: profile.Ptr(22),
			User: profile.Ptr("admin"),
			Auth: profile.Ptr(profile.AuthMode("password")),
		},
	})

	r := NewResolver(ps, ps, ps, ss)
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
	if cfg.Secrets != nil {
		t.Error("Secrets should be nil in inline mode")
	}
}

//nolint:errcheck
func TestResolver_UnknownProfile(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	r := NewResolver(ps, ps, ps, ss)
	_, _, err := r.Resolve("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown profile")
	}
}

//nolint:errcheck
func TestResolver_JumpHost(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	// Jump profile
	jumpPWID := credential.NewSecretID()
	_ = ss.Set(jumpPWID, credential.NewSecret("jump-secret"))
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:jump:xyz", Name: "jump-cred", Username: "jumpuser", Auth: "publicKey",
		KeyPath:  "/home/user/.ssh/jump_rsa",
		SecretID: string(jumpPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:jump", Name: "jump"},
		Options: profile.StoredSSHProfileOptions{Host: "jump.example.com", Port: profile.Ptr(22), CredentialID: "cred:jump:xyz"},
	})

	// Target profile
	tgtPWID := credential.NewSecretID()
	_ = ss.Set(tgtPWID, credential.NewSecret("tgt-secret"))
	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:tgt:def",
		Name:     "tgt-cred",
		Username: "tgtuser",
		Auth:     "password",
		SecretID: string(tgtPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:tgt", Name: "target"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "target.internal",
			Port:         profile.Ptr(2222),
			CredentialID: "cred:tgt:def",
			JumpHost:     profile.Ptr("profile:jump"),
		},
	})

	r := NewResolver(ps, ps, ps, ss)
	host, cfg, err := r.Resolve("profile:tgt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "target.internal" {
		t.Errorf("host = %q, want target.internal", host)
	}

	if cfg.Secrets == nil {
		t.Fatal("Target Secrets is nil")
	}
	if cfg.SecretID != tgtPWID {
		t.Errorf("Target SecretID = %q, want %q", cfg.SecretID, tgtPWID)
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
	if cfg.JumpSecrets == nil {
		t.Error("JumpSecrets is nil")
	}
	if cfg.JumpSecretID != jumpPWID {
		t.Errorf("JumpSecretID = %q, want %q", cfg.JumpSecretID, jumpPWID)
	}
}

//nolint:errcheck
func TestResolver_JumpHostInlineMode(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	// Jump profile (inline, no credential)
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:jump-inline", Name: "jump"},
		Options: profile.StoredSSHProfileOptions{
			Host: "jump.inline.com",
			Port: profile.Ptr(22),
			User: profile.Ptr("jumper"),
			Auth: profile.Ptr(profile.AuthMode("publicKey")),
		},
	})

	// Target profile
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:tgt2", Name: "target"},
		Options: profile.StoredSSHProfileOptions{
			Host:     "target.inline",
			Port:     profile.Ptr(3333),
			JumpHost: profile.Ptr("profile:jump-inline"),
		},
	})

	r := NewResolver(ps, ps, ps, ss)
	host, cfg, err := r.Resolve("profile:tgt2")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "target.inline" {
		t.Errorf("host = %q, want target.inline", host)
	}
	if cfg.JumpHost != "jump.inline.com" {
		t.Errorf("JumpHost = %q, want jump.inline.com", cfg.JumpHost)
	}
	if cfg.Secrets != nil {
		t.Error("Secrets should be nil for target without credential")
	}
}

//nolint:errcheck
func TestResolver_CarriesTargetBinding(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	pwID := credential.NewSecretID()
	_ = ss.Set(pwID, credential.NewSecret("pw"))
	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:bound:aaa",
		Name:     "bound-cred",
		Username: "u",
		Auth:     "password",
		SecretID: string(pwID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:bound", Name: "bound"},
		Options: profile.StoredSSHProfileOptions{Host: "bound.example.com", Port: profile.Ptr(2222), CredentialID: "cred:bound:aaa"},
	})

	r := NewResolver(ps, ps, ps, ss)
	_, cfg, err := r.Resolve("profile:bound")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if cfg.AuthorizedEndpoint != "bound.example.com:2222" {
		t.Errorf("AuthorizedEndpoint = %q, want bound.example.com:2222", cfg.AuthorizedEndpoint)
	}
}

// TestResolver_UnboundCredentialSurfacesEmpty pin that a credential with no
// Host/Port fields still produces an AuthorizedEndpoint from its profile.
func TestResolver_LinkedCredentialSurfacesAuthorizedEndpoint(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	pwID := credential.NewSecretID()
	_ = ss.Set(pwID, credential.NewSecret("pw"))
	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:unbound:bbb",
		Name:     "unbound",
		Username: "u",
		Auth:     "password",
		SecretID: string(pwID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:unbound", Name: "unbound"},
		Options: profile.StoredSSHProfileOptions{Host: "any.example.com", Port: profile.Ptr(22), CredentialID: "cred:unbound:bbb"},
	})

	r := NewResolver(ps, ps, ps, ss)
	_, cfg, err := r.Resolve("profile:unbound")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if cfg.AuthorizedEndpoint == "" {
		t.Error("AuthorizedEndpoint = empty, want endpoint from profile (credential is linked)")
	}
	if cfg.AuthorizedEndpoint != "any.example.com:22" {
		t.Errorf("AuthorizedEndpoint = %q, want any.example.com:22 (from profile host:port)", cfg.AuthorizedEndpoint)
	}
}

func TestResolver_CarriesJumpBinding(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	// Jump credential with binding
	jumpPWID := credential.NewSecretID()
	_ = ss.Set(jumpPWID, credential.NewSecret("jpw"))
	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:jumpbound:ccc",
		Name:     "jump-bound",
		Username: "ju",
		Auth:     "password",
		SecretID: string(jumpPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:jumpb", Name: "jumpb"},
		Options: profile.StoredSSHProfileOptions{Host: "jump-bound.example.com", Port: profile.Ptr(2222), CredentialID: "cred:jumpbound:ccc"},
	})

	// Target
	tgtPWID := credential.NewSecretID()
	_ = ss.Set(tgtPWID, credential.NewSecret("tpw"))
	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:tgtbound:ddd",
		Name:     "tgt-bound",
		Username: "tu",
		Auth:     "password",
		SecretID: string(tgtPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:tgtb", Name: "tgtb"},
		Options: profile.StoredSSHProfileOptions{Host: "tgt-bound.example.com", Port: profile.Ptr(3333), CredentialID: "cred:tgtbound:ddd", JumpHost: profile.Ptr("profile:jumpb")},
	})

	r := NewResolver(ps, ps, ps, ss)
	_, cfg, err := r.Resolve("profile:tgtb")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if cfg.AuthorizedEndpoint != "tgt-bound.example.com:3333" {
		t.Errorf("AuthorizedEndpoint = %q, want tgt-bound.example.com:3333", cfg.AuthorizedEndpoint)
	}
	if cfg.JumpAuthorizedEndpoint != "jump-bound.example.com:2222" {
		t.Errorf("JumpAuthorizedEndpoint = %q, want jump-bound.example.com:2222", cfg.JumpAuthorizedEndpoint)
	}
}

// TestResolve_UsesCurrentVersionSecret pins the contract between the credential
// version model and the connection pool. poolKeyFor (ssh_dial.go:38) keys on
// cfg.SecretID, so publishing the SELECTED version's reference is what makes
// moving `current` produce a different pool key — with no change anywhere in
// internal/ssh. Asserting it here is what stops a later refactor from quietly
// publishing the record-level SecretID again and re-pooling two versions
// together.
//
//nolint:errcheck
func TestResolve_UsesCurrentVersionSecret(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	cred := profile.Credential{
		ID: "cred:ops:1", Name: "ops", Username: "ops", Auth: profile.AuthPassword,
		Versions: []profile.CredentialVersion{
			{ID: "v7", PasswordSecretID: "sec:7"},
			{ID: "v8", PasswordSecretID: "sec:8"},
		},
		CurrentVersionID: "v7",
	}
	_ = ps.SaveCredential(cred)

	prof := profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:custom:web-1:1", Type: "ssh", Name: "web-1"},
		Options: profile.StoredSSHProfileOptions{Host: "10.0.0.1", Port: profile.Ptr(22), CredentialID: cred.ID},
	}
	_ = ps.SaveProfile(prof)

	r := NewResolver(ps, ps, ps, ss)

	_, cfg, err := r.Resolve(prof.ID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if string(cfg.SecretID) != "sec:7" {
		t.Fatalf("SecretID = %q, want sec:7 (the current version)", cfg.SecretID)
	}
	first := cfg.SecretID

	// Move current to v8 and resolve again.
	cred.CurrentVersionID = "v8"
	_ = ps.SaveCredential(cred)

	_, cfg2, err := r.Resolve(prof.ID)
	if err != nil {
		t.Fatalf("Resolve after promotion: %v", err)
	}
	if string(cfg2.SecretID) != "sec:8" {
		t.Fatalf("SecretID = %q, want sec:8", cfg2.SecretID)
	}
	if cfg2.SecretID == first {
		t.Fatal("promoting a version left the SecretID unchanged; the pool would reuse the old transport")
	}
}

// TestResolver_MultiHopJump verifies that a target behind two bastions
// carries the full recursive JumpConfig chain through to the ConnectConfig.
func TestResolver_MultiHopJump(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	// Inner bastion (closest to client) - jumps through no one
	innerPWID := credential.NewSecretID()
	_ = ss.Set(innerPWID, credential.NewSecret("inner-secret"))
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:inner:1", Name: "inner-cred", Username: "inneruser", Auth: "password",
		SecretID: string(innerPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:inner", Name: "inner-bastion"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "inner.corp.net",
			Port:         profile.Ptr(2201),
			CredentialID: "cred:inner:1",
		},
	})

	// Outer bastion (closest to target) - jumps through inner
	outerPWID := credential.NewSecretID()
	_ = ss.Set(outerPWID, credential.NewSecret("outer-secret"))
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:outer:1", Name: "outer-cred", Username: "outeruser", Auth: "publicKey",
		KeyPath:  "/home/user/.ssh/outer_rsa",
		SecretID: string(outerPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:outer", Name: "outer-bastion"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "outer.corp.net",
			Port:         profile.Ptr(2200),
			CredentialID: "cred:outer:1",
			JumpHost:     profile.Ptr("profile:inner"),
		},
	})

	// Target profile - jumps through outer
	tgtPWID := credential.NewSecretID()
	_ = ss.Set(tgtPWID, credential.NewSecret("tgt-secret"))
	_ = ps.SaveCredential(profile.Credential{
		ID: "cred:tgt:1", Name: "tgt-cred", Username: "tgtuser", Auth: "password",
		SecretID: string(tgtPWID),
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:tgt", Name: "target"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "target.internal",
			Port:         profile.Ptr(2222),
			CredentialID: "cred:tgt:1",
			JumpHost:     profile.Ptr("profile:outer"),
		},
	})

	r := NewResolver(ps, ps, ps, ss)
	host, cfg, err := r.Resolve("profile:tgt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if host != "target.internal" {
		t.Errorf("host = %q, want target.internal", host)
	}
	if cfg.SecretID != tgtPWID {
		t.Errorf("Target SecretID = %q, want %q", cfg.SecretID, tgtPWID)
	}

	// First hop: outer bastion
	if cfg.JumpHost != "outer.corp.net" {
		t.Errorf("JumpHost = %q, want outer.corp.net", cfg.JumpHost)
	}
	if cfg.JumpConfig == nil {
		t.Fatal("JumpConfig is nil, want outer bastion config")
	}
	if cfg.JumpConfig.Port != 2200 {
		t.Errorf("JumpConfig.Port = %d, want 2200", cfg.JumpConfig.Port)
	}
	if cfg.JumpConfig.User != "outeruser" {
		t.Errorf("JumpConfig.User = %q, want outeruser", cfg.JumpConfig.User)
	}
	if cfg.JumpConfig.SecretID != outerPWID {
		t.Errorf("JumpConfig.SecretID = %q, want %q", cfg.JumpConfig.SecretID, outerPWID)
	}

	// Second hop: inner bastion (outer's jump)
	if cfg.JumpConfig.JumpHost != "inner.corp.net" {
		t.Errorf("JumpConfig.JumpHost = %q, want inner.corp.net", cfg.JumpConfig.JumpHost)
	}
	if cfg.JumpConfig.JumpConfig == nil {
		t.Fatal("JumpConfig.JumpConfig is nil, want inner bastion config")
	}
	if cfg.JumpConfig.JumpConfig.SecretID != innerPWID {
		t.Errorf("JumpConfig.JumpConfig.SecretID = %q, want %q", cfg.JumpConfig.JumpConfig.SecretID, innerPWID)
	}
	if cfg.JumpConfig.JumpConfig.JumpConfig != nil {
		t.Errorf("JumpConfig.JumpConfig.JumpConfig should be nil (no more hops), got %v", cfg.JumpConfig.JumpConfig.JumpConfig)
	}
}

// TestResolver_MultiHopCycleDetected verifies that a multi-hop chain with a
// cycle is rejected at resolve time.
func TestResolver_MultiHopCycleDetected(t *testing.T) {
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	// Two profiles that reference each other in a cycle
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:a", Name: "a"},
		Options: profile.StoredSSHProfileOptions{
			Host:     "host-a.net",
			JumpHost: profile.Ptr("profile:b"),
		},
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base: profile.Base{ID: "profile:b", Name: "b"},
		Options: profile.StoredSSHProfileOptions{
			Host:     "host-b.net",
			JumpHost: profile.Ptr("profile:a"),
		},
	})

	r := NewResolver(ps, ps, ps, ss)
	_, _, err := r.Resolve("profile:a")
	if err == nil {
		t.Fatal("expected cycle detection error, got nil")
	}
}

// --- ResolveWithVersion: what it must refuse -------------------------------
//
// These assert the absence of a fallback. The rollout probe authenticates with
// a staged candidate; if the resolver quietly substituted the current version
// when the candidate was missing, a probe would spend a second password against
// the same host and the operator would see a success that proves nothing.

// rotationFixture builds a profile whose credential has a current and a
// candidate version, each with its own password secret.
func rotationFixture(t *testing.T) (*stubProfileStore, *stubSecretStore, credential.SecretID, credential.SecretID) {
	t.Helper()
	ps := newStubProfileStore()
	ss := newStubSecretStore()

	curID := credential.NewSecretID()
	candID := credential.NewSecretID()
	if err := ss.Set(curID, credential.NewSecret("current-pw")); err != nil {
		t.Fatalf("set current: %v", err)
	}
	if err := ss.Set(candID, credential.NewSecret("candidate-pw")); err != nil {
		t.Fatalf("set candidate: %v", err)
	}

	_ = ps.SaveCredential(profile.Credential{
		ID:       "cred:rot:aaa",
		Name:     "rot",
		Username: "ru",
		Auth:     "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", Auth: "password", PasswordSecretID: string(curID)},
			{ID: "v2", Auth: "password", PasswordSecretID: string(candID)},
		},
		CurrentVersionID:   "v1",
		CandidateVersionID: "v2",
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:rot", Name: "rot"},
		Options: profile.StoredSSHProfileOptions{Host: "rot.example.com", CredentialID: "cred:rot:aaa"},
	})
	return ps, ss, curID, candID
}

func TestResolveWithVersion_UsesTheNamedVersion(t *testing.T) {
	ps, ss, _, candID := rotationFixture(t)

	_, cfg, err := NewResolver(ps, ps, ps, ss).ResolveWithVersion("profile:rot", "cred:rot:aaa", "v2")
	if err != nil {
		t.Fatalf("ResolveWithVersion: %v", err)
	}
	if cfg.SecretID != candID {
		t.Errorf("SecretID = %q, want the candidate %q", cfg.SecretID, candID)
	}
	if cfg.CredentialVersionID != "v2" {
		t.Errorf("CredentialVersionID = %q, want v2", cfg.CredentialVersionID)
	}
}

func TestResolveWithVersion_MissingVersionDoesNotFallBack(t *testing.T) {
	ps, ss, curID, _ := rotationFixture(t)

	_, cfg, err := NewResolver(ps, ps, ps, ss).ResolveWithVersion("profile:rot", "cred:rot:aaa", "v99")
	if !errors.Is(err, ErrVersionNotFound) {
		t.Fatalf("err = %v, want ErrVersionNotFound", err)
	}
	if cfg != nil {
		t.Fatalf("cfg = %+v, want nil — a config carrying %q would be the silent retry this forbids", cfg, curID)
	}
}

func TestResolveWithVersion_WrongCredentialIsRefused(t *testing.T) {
	ps, ss, _, _ := rotationFixture(t)

	_, cfg, err := NewResolver(ps, ps, ps, ss).ResolveWithVersion("profile:rot", "cred:someone-else:zzz", "v2")
	if !errors.Is(err, ErrCredentialMismatch) {
		t.Fatalf("err = %v, want ErrCredentialMismatch", err)
	}
	if cfg != nil {
		t.Fatalf("cfg = %+v, want nil", cfg)
	}
}

func TestResolveWithVersion_LeavesTheBastionOnItsCurrentVersion(t *testing.T) {
	ps, ss, _, candID := rotationFixture(t)

	// A bastion with its own credential, one version, in front of the target.
	jumpID := credential.NewSecretID()
	if err := ss.Set(jumpID, credential.NewSecret("jump-pw")); err != nil {
		t.Fatalf("set jump: %v", err)
	}
	_ = ps.SaveCredential(profile.Credential{
		ID:               "cred:bastion:bbb",
		Name:             "bastion",
		Username:         "bu",
		Auth:             "password",
		Versions:         []profile.CredentialVersion{{ID: "b1", Auth: "password", PasswordSecretID: string(jumpID)}},
		CurrentVersionID: "b1",
	})
	_ = ps.SaveProfile(profile.SSHProfile{
		Base:    profile.Base{ID: "profile:bastion", Name: "bastion"},
		Options: profile.StoredSSHProfileOptions{Host: "bastion.example.com", CredentialID: "cred:bastion:bbb"},
	})
	tgt := ps.profiles["profile:rot"]
	tgt.Options.JumpHost = profile.Ptr("profile:bastion")
	_ = ps.SaveProfile(tgt)

	_, cfg, err := NewResolver(ps, ps, ps, ss).ResolveWithVersion("profile:rot", "cred:rot:aaa", "v2")
	if err != nil {
		t.Fatalf("ResolveWithVersion: %v", err)
	}
	if cfg.SecretID != candID {
		t.Errorf("target SecretID = %q, want the candidate %q", cfg.SecretID, candID)
	}
	if cfg.JumpSecretID != jumpID {
		t.Errorf("JumpSecretID = %q, want the bastion's own %q — rotating one credential must not touch the bastion", cfg.JumpSecretID, jumpID)
	}
}
