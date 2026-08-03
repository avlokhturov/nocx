package contentkey

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/vault"
)

// ── fakes ────────────────────────────────────────────────────────────────

type fakeProvider struct {
	id       vault.ProviderID
	ready    bool
	writable bool
	secrets  map[credential.SecretID][]byte
	gets     int
	puts     int
}

func (p *fakeProvider) ID() vault.ProviderID { return p.id }
func (p *fakeProvider) Status(context.Context) vault.Status {
	return vault.Status{Ready: p.ready}
}

func (p *fakeProvider) Get(_ context.Context, id credential.SecretID) (credential.Secret, error) {
	p.gets++
	b, ok := p.secrets[id]
	if !ok {
		return credential.Secret{}, vault.ErrSecretNotFound
	}
	return credential.NewSecretBytes(b), nil
}

func (p *fakeProvider) Put(_ context.Context, id credential.SecretID, s credential.Secret) error {
	p.puts++
	var b []byte
	if err := s.Use(func(x []byte) error {
		b = append(b, x...)
		return nil
	}); err != nil {
		return err
	}
	p.secrets[id] = b
	return nil
}

func (p *fakeProvider) Delete(context.Context, credential.SecretID) error { return nil }

type fakeRegistry struct {
	providers map[vault.ProviderID]vault.Provider
}

func (r *fakeRegistry) Get(id vault.ProviderID) (vault.Provider, bool) {
	p, ok := r.providers[id]
	return p, ok
}

func (r *fakeRegistry) Writable(id vault.ProviderID) (vault.WritableProvider, bool) {
	p, ok := r.providers[id]
	w, writable := p.(vault.WritableProvider)
	return w, ok && writable
}

// testConfig builds a Config over a temp dir. sys is the system provider;
// pass nil for a registry without one. ready overrides the fake's own flag
// for the SystemReady injection — the composition root's probe result is
// independent of what the provider would report.
func testConfig(t *testing.T, sys *fakeProvider, ready bool) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o700); err != nil {
		t.Fatalf("mkdir config: %v", err)
	}
	providers := map[vault.ProviderID]vault.Provider{}
	if sys != nil {
		providers[vault.ProviderSystem] = sys
	}
	return Config{
		Registry:    &fakeRegistry{providers: providers},
		KeyID:       vault.ContentKeyID,
		SystemReady: ready,
		DBPath:      filepath.Join(dir, "content.db"),
		SaltPath:    filepath.Join(dir, "config", "contentkey.salt"),
		MachineID:   func() (string, error) { return "machine-identity", nil },
		UserID:      func() (string, error) { return "42", nil },
		Logger:      log.NewSlogAdapter(nil),
	}, dir
}

func saltExists(t *testing.T, cfg Config) bool {
	t.Helper()
	_, err := os.Stat(cfg.SaltPath)
	if err == nil {
		return true
	}
	if os.IsNotExist(err) {
		return false
	}
	t.Fatalf("stat salt: %v", err)
	return false
}

// ── derived branch (no OS keystore) ───────────────────────────────────────

// First run on a host with no OS keystore: the salt is minted in the config
// directory, mode 0600, and the key is derived from it — the vault and its
// seal are never touched.
func TestLoadOrCreate_DerivedFirstRun(t *testing.T) {
	cfg, dir := testConfig(t, nil, false)
	key, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("key len = %d, want 32", len(key))
	}
	if !saltExists(t, cfg) {
		t.Fatal("salt was not created")
	}
	salt, err := os.ReadFile(cfg.SaltPath)
	if err != nil {
		t.Fatalf("read salt: %v", err)
	}
	if len(salt) != saltLen {
		t.Fatalf("salt len = %d, want %d", len(salt), saltLen)
	}
	info, err := os.Stat(cfg.SaltPath)
	if err != nil {
		t.Fatalf("stat salt: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("salt mode = %o, want 600", info.Mode().Perm())
	}
	// The salt lives in the config dir, never beside content.db.
	if filepath.Dir(cfg.SaltPath) == filepath.Dir(cfg.DBPath) {
		t.Fatal("salt sits beside content.db — a data-dir copy would open it")
	}
	_ = dir
}

// A restart derives the SAME key: the salt is authoritative and the key is
// a pure function of it, so a restart never rotates the key.
func TestLoadOrCreate_DerivedRestartSameKey(t *testing.T) {
	cfg, _ := testConfig(t, nil, false)
	key1, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("first LoadOrCreate: %v", err)
	}
	key2, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if string(key1) != string(key2) {
		t.Fatal("restart rotated the derived key")
	}
}

// The salt is authoritative over a keystore that appeared later: minting
// into the keystore would rotate the key under the existing database, so the
// keystore is not even probed.
func TestLoadOrCreate_DerivedSaltAuthoritativeOverKeystore(t *testing.T) {
	cfg, _ := testConfig(t, nil, false)
	key1, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("first LoadOrCreate: %v", err)
	}
	// Now a keystore exists and even holds a different key.
	sys := &fakeProvider{
		id:       vault.ProviderSystem,
		ready:    true,
		writable: true,
		secrets:  map[credential.SecretID][]byte{},
	}
	cfg.Registry = &fakeRegistry{providers: map[vault.ProviderID]vault.Provider{vault.ProviderSystem: sys}}
	cfg.SystemReady = true

	key2, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate with keystore present: %v", err)
	}
	if string(key1) != string(key2) {
		t.Fatal("keystore appearance rotated the derived key")
	}
	if sys.gets != 0 {
		t.Fatalf("keystore was probed (%d gets) although the salt is authoritative", sys.gets)
	}
}

// The derivation is pinned: a fixed salt and identity produce a fixed key.
// Changing the HKDF info string or the framing silently strands every
// existing database, so the golden value is a deliberate regression lock.
func TestDerive_GoldenVector(t *testing.T) {
	salt := make([]byte, saltLen)
	for i := range salt {
		salt[i] = byte(i)
	}
	cfg := Config{
		MachineID: func() (string, error) { return "machine-identity", nil },
		UserID:    func() (string, error) { return "42", nil },
	}
	key, err := deriveKeyWithSalt(cfg, salt)
	if err != nil {
		t.Fatalf("deriveKeyWithSalt: %v", err)
	}
	const want = "ec5733d19c4501e3e5e639bf6dab5bb9970827dbdd325326fd7fabac9cf3dc89"
	if got := hexEncode(key); got != want {
		t.Fatalf("derived key = %s, want %s (the derivation formula changed — existing databases will not open)", got, want)
	}
}

// A machine that cannot name itself must not leave a salt behind: the next
// start would derive and fail again, only with a salt that now exists.
func TestLoadOrCreate_IdentityFailureMintsNoSalt(t *testing.T) {
	cfg, _ := testConfig(t, nil, false)
	cfg.MachineID = func() (string, error) { return "", errors.New("no machine-id") }
	_, err := LoadOrCreate(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected an error, got a key")
	}
	if saltExists(t, cfg) {
		t.Fatal("a salt was minted although the machine cannot name itself")
	}
}

// A corrupt salt file (wrong length) is an error, never a silent re-mint.
func TestLoadOrCreate_DerivedSaltCorrupt(t *testing.T) {
	cfg, _ := testConfig(t, nil, false)
	if err := os.MkdirAll(filepath.Dir(cfg.SaltPath), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(cfg.SaltPath, []byte("short"), 0o600); err != nil {
		t.Fatalf("write salt: %v", err)
	}
	if _, err := LoadOrCreate(context.Background(), cfg); err == nil {
		t.Fatal("expected an error for a corrupt salt, got a key")
	}
}

// ── keystore branch (OS keystore present) ─────────────────────────────────

// First run with an OS keystore: the key is minted into the system
// provider's derived slot, exactly as before the amendment.
func TestLoadOrCreate_KeystoreFirstRun(t *testing.T) {
	sys := &fakeProvider{
		id:       vault.ProviderSystem,
		ready:    true,
		writable: true,
		secrets:  map[credential.SecretID][]byte{},
	}
	cfg, _ := testConfig(t, sys, true)
	key, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("key len = %d, want 32", len(key))
	}
	if sys.puts != 1 {
		t.Fatalf("puts = %d, want 1", sys.puts)
	}
	if saltExists(t, cfg) {
		t.Fatal("a salt was minted although the keystore is the key's home")
	}
	// The slot holds exactly the key handed out.
	if got := sys.secrets[mustContentKeyID(t, vault.ProviderSystem)]; string(got) != string(key) {
		t.Fatal("keystore slot does not hold the returned key")
	}
}

// A restart reads the same key back from the slot — never a rotation.
func TestLoadOrCreate_KeystoreRestart(t *testing.T) {
	sys := &fakeProvider{
		id:       vault.ProviderSystem,
		ready:    true,
		writable: true,
		secrets:  map[credential.SecretID][]byte{},
	}
	cfg, _ := testConfig(t, sys, true)
	key1, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("first LoadOrCreate: %v", err)
	}
	key2, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if string(key1) != string(key2) {
		t.Fatal("restart rotated the keystore key")
	}
	if sys.puts != 1 {
		t.Fatalf("puts = %d, want 1 (a restart must not mint)", sys.puts)
	}
}

// An empty slot beside an existing database is a LOST key, never a re-mint:
// a fresh key would strand the database while the UI claimed history worked.
func TestLoadOrCreate_KeystoreKeyLost(t *testing.T) {
	sys := &fakeProvider{
		id:       vault.ProviderSystem,
		ready:    true,
		writable: true,
		secrets:  map[credential.SecretID][]byte{},
	}
	cfg, _ := testConfig(t, sys, true)
	if err := os.WriteFile(cfg.DBPath, []byte("exists"), 0o600); err != nil {
		t.Fatalf("write db marker: %v", err)
	}
	if _, err := LoadOrCreate(context.Background(), cfg); !errors.Is(err, ErrKeyLost) {
		t.Fatalf("err = %v, want ErrKeyLost", err)
	}
	if sys.puts != 0 {
		t.Fatalf("puts = %d, want 0 (a lost key must never be re-minted)", sys.puts)
	}
}

// The keystore provider is present but not writable: an error, never a
// fallback that strands the database with a second key.
func TestLoadOrCreate_KeystoreNotWritable(t *testing.T) {
	cfg, _ := testConfig(t, nil, true)
	cfg.Registry = &fakeRegistry{providers: map[vault.ProviderID]vault.Provider{
		vault.ProviderSystem: &readOnlyProvider{secrets: map[credential.SecretID][]byte{}},
	}}
	if _, err := LoadOrCreate(context.Background(), cfg); err == nil {
		t.Fatal("expected an error for a read-only keystore, got a key")
	}
}

// A slot holding non-32-byte material is an error, never a silently wrong key.
func TestLoadOrCreate_KeystoreUnusableMaterial(t *testing.T) {
	sys := &fakeProvider{
		id:    vault.ProviderSystem,
		ready: true,
		secrets: map[credential.SecretID][]byte{
			mustContentKeyID(t, vault.ProviderSystem): []byte("too short"),
		},
	}
	cfg, _ := testConfig(t, sys, true)
	if _, err := LoadOrCreate(context.Background(), cfg); err == nil {
		t.Fatal("expected an error for unusable slot material, got a key")
	}
}

// A provider that errors on read propagates the error — no fallback re-mint.
func TestLoadOrCreate_KeystoreReadError(t *testing.T) {
	sys := &brokenProvider{}
	cfg := Config{
		Registry:    &fakeRegistry{providers: map[vault.ProviderID]vault.Provider{vault.ProviderSystem: sys}},
		KeyID:       vault.ContentKeyID,
		SystemReady: true,
		DBPath:      filepath.Join(t.TempDir(), "content.db"),
		SaltPath:    filepath.Join(t.TempDir(), "config", "contentkey.salt"),
		Logger:      log.NewSlogAdapter(nil),
	}
	if _, err := LoadOrCreate(context.Background(), cfg); err == nil {
		t.Fatal("expected the provider error, got a key")
	}
}

// ── lost key (neither branch can reconstruct) ─────────────────────────────

// No salt, no keystore, database exists: the key is unrecoverable and must
// never be re-minted.
func TestLoadOrCreate_KeyLostNoKeystoreNoSalt(t *testing.T) {
	cfg, _ := testConfig(t, nil, false)
	if err := os.WriteFile(cfg.DBPath, []byte("exists"), 0o600); err != nil {
		t.Fatalf("write db marker: %v", err)
	}
	if _, err := LoadOrCreate(context.Background(), cfg); !errors.Is(err, ErrKeyLost) {
		t.Fatalf("err = %v, want ErrKeyLost", err)
	}
	if saltExists(t, cfg) {
		t.Fatal("a salt was minted although the database exists — the key is lost")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

// brokenProvider fails every read.
type brokenProvider struct{}

func (p *brokenProvider) ID() vault.ProviderID { return vault.ProviderSystem }
func (p *brokenProvider) Status(context.Context) vault.Status {
	return vault.Status{Ready: true}
}

func (p *brokenProvider) Get(context.Context, credential.SecretID) (credential.Secret, error) {
	return credential.Secret{}, errors.New("keystore exploded")
}

func mustContentKeyID(t *testing.T, p vault.ProviderID) credential.SecretID {
	t.Helper()
	id, err := vault.ContentKeyID(p)
	if err != nil {
		t.Fatalf("ContentKeyID: %v", err)
	}
	return id
}

// readOnlyProvider satisfies vault.Provider but NOT vault.WritableProvider —
// the read-only keystore case, where creation must fail rather than fall back.
type readOnlyProvider struct {
	secrets map[credential.SecretID][]byte
}

func (p *readOnlyProvider) ID() vault.ProviderID { return vault.ProviderSystem }
func (p *readOnlyProvider) Status(context.Context) vault.Status {
	return vault.Status{Ready: true}
}

func (p *readOnlyProvider) Get(_ context.Context, id credential.SecretID) (credential.Secret, error) {
	b, ok := p.secrets[id]
	if !ok {
		return credential.Secret{}, vault.ErrSecretNotFound
	}
	return credential.NewSecretBytes(b), nil
}

func hexEncode(b []byte) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, hexDigits[c>>4], hexDigits[c&0xf])
	}
	return string(out)
}

// A host with no identity of its own — a container, and our own `go test`
// container is one — still gets durable history. The minting path is tested
// directly rather than through machineIDOrMinted, because that one reads the
// REAL host: on a developer machine /etc/machine-id exists and nothing is
// minted, so a test routed through it would assert on the host it happens to
// run on. That is the same environment-dependence this whole fallback exists
// to remove.
//
// The property that matters most is stability: an id that changed between
// starts would derive a different key and strand the database exactly as a
// lost salt does.
func TestMintedMachineID_IsStableAcrossStartsAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "machine.id")

	first, err := loadOrMintMachineID(path)
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	if first == "" {
		t.Fatal("minted an empty machine id")
	}
	second, err := loadOrMintMachineID(path)
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if second != first {
		t.Fatalf("id changed between starts: %q then %q — the database would be stranded", first, second)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat minted id: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("machine.id mode = %o, want 600", perm)
	}
}

// The whole point of minting: the derived key is usable on a host that has
// no identity to borrow, and it is the SAME key on the next start.
func TestDerivedKey_IsStableOnAHostWithNoMachineID(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{
		SaltPath:  filepath.Join(dir, "contentkey.salt"),
		MachineID: func() (string, error) { return loadOrMintMachineID(filepath.Join(dir, "machine.id")) },
		UserID:    func() (string, error) { return "1000", nil },
	}
	salt := make([]byte, saltLen)
	for i := range salt {
		salt[i] = byte(i)
	}
	k1, err := deriveKeyWithSalt(cfg, salt)
	if err != nil {
		t.Fatalf("first derive: %v", err)
	}
	k2, err := deriveKeyWithSalt(cfg, salt)
	if err != nil {
		t.Fatalf("second derive: %v", err)
	}
	if !bytes.Equal(k1, k2) {
		t.Fatal("derived key changed between starts on a host with no machine-id")
	}
	if len(k1) != 32 {
		t.Fatalf("key length = %d, want 32", len(k1))
	}
}
