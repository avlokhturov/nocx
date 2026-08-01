package contentkey

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/vault"
)

// ── fakes ────────────────────────────────────────────────────────────────

type fakePolicy struct {
	defaultProvider vault.ProviderID
	ids             map[vault.ProviderID]credential.SecretID
	providerOf      func(credential.SecretID) (vault.ProviderID, error)
}

func (f *fakePolicy) DefaultProvider() vault.ProviderID { return f.defaultProvider }
func (f *fakePolicy) ContentKeyID(p vault.ProviderID) (credential.SecretID, error) {
	id, ok := f.ids[p]
	if !ok {
		return "", errors.New("unknown provider " + string(p))
	}
	return id, nil
}

func (f *fakePolicy) ProviderOf(id credential.SecretID) (vault.ProviderID, error) {
	if f.providerOf != nil {
		return f.providerOf(id)
	}
	for p, pid := range f.ids {
		if pid == id {
			return p, nil
		}
	}
	return "", errors.New("unknown reference")
}

type fakeProvider struct {
	id       vault.ProviderID
	ready    bool
	secrets  map[credential.SecretID][]byte
	getErr   error
	putErr   error
	putCalls int
}

func (p *fakeProvider) ID() vault.ProviderID { return p.id }
func (p *fakeProvider) Status(context.Context) vault.Status {
	return vault.Status{Ready: p.ready}
}

func (p *fakeProvider) Get(_ context.Context, id credential.SecretID) (credential.Secret, error) {
	if p.getErr != nil {
		return credential.Secret{}, p.getErr
	}
	b, ok := p.secrets[id]
	if !ok {
		return credential.Secret{}, vault.ErrSecretNotFound
	}
	return credential.NewSecretBytes(b), nil
}

func (p *fakeProvider) Put(_ context.Context, id credential.SecretID, s credential.Secret) error {
	p.putCalls++
	if p.putErr != nil {
		return p.putErr
	}
	var buf []byte
	_ = s.Use(func(b []byte) error {
		buf = append(buf, b...)
		return nil
	})
	if p.secrets == nil {
		p.secrets = make(map[credential.SecretID][]byte)
	}
	p.secrets[id] = buf
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
	if !ok {
		return nil, false
	}
	w, ok := p.(vault.WritableProvider)
	return w, ok
}

func (r *fakeRegistry) List() []vault.Provider {
	out := make([]vault.Provider, 0, len(r.providers))
	for _, p := range r.providers {
		out = append(out, p)
	}
	return out
}

func testConfig(dbPath string) (Config, *fakePolicy, *fakeRegistry) {
	policy := &fakePolicy{
		defaultProvider: vault.ProviderSystem,
		ids: map[vault.ProviderID]credential.SecretID{
			vault.ProviderSystem: "sec:v1:system:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			vault.ProviderFile:   "sec:v1:file:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
	}
	sys := &fakeProvider{id: vault.ProviderSystem, ready: true}
	file := &fakeProvider{id: vault.ProviderFile, ready: true}
	reg := &fakeRegistry{providers: map[vault.ProviderID]vault.Provider{
		vault.ProviderSystem: sys,
		vault.ProviderFile:   file,
	}}
	return Config{
		Policy:   policy,
		Registry: reg,
		DBPath:   dbPath,
		Logger:   log.NewSlogAdapter(nil),
	}, policy, reg
}

// ── find or create ───────────────────────────────────────────────────────

// First run (no database, empty slots): mint once into the default
// provider's derived slot.
func TestLoadOrCreate_MintsOnFirstRun(t *testing.T) {
	dir := t.TempDir()
	cfg, _, reg := testConfig(filepath.Join(dir, "content.db"))
	ctx := context.Background()

	key, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("key = %d bytes, want 32", len(key))
	}
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing")
	}
	if prov.putCalls != 1 {
		t.Fatalf("Put calls = %d, want 1", prov.putCalls)
	}
}

// Second run: the derived slot holds the key, so the SAME key comes back —
// a restart never rotates the key.
func TestLoadOrCreate_ReadsDerivedSlot(t *testing.T) {
	dir := t.TempDir()
	cfg, _, _ := testConfig(filepath.Join(dir, "content.db"))
	ctx := context.Background()
	first, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if string(second) != string(first) {
		t.Fatal("key changed across restarts — history would be unreadable")
	}
}

// A default-provider change must not strand the key: the derived slot of the
// ORIGINAL provider is still probed, so the same key comes back.
func TestLoadOrCreate_FindsKeyAfterDefaultProviderChange(t *testing.T) {
	dir := t.TempDir()
	cfg, policy, _ := testConfig(filepath.Join(dir, "content.db"))
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}

	// The user switches the default provider; the key stays in the system
	// slot (references are immutable — the provider is in the derivation).
	policy.defaultProvider = vault.ProviderFile
	second, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("after provider change: %v", err)
	}
	// The file provider must NOT have minted a new key, and the key returned
	// is the one the system slot already held.
	fileProv, fileOK := cfg.Registry.(*fakeRegistry).providers[vault.ProviderFile].(*fakeProvider)
	if !fileOK {
		t.Fatal("file provider missing")
	}
	if fileProv.putCalls != 0 {
		t.Fatal("provider change minted a new key — the old history is stranded")
	}
	first, _ := LoadOrCreate(ctx, cfg)
	if string(second) != string(first) {
		t.Fatal("key changed after a default-provider change")
	}
}

// ── failure paths ────────────────────────────────────────────────────────

// No provider at all → error, never a silently empty key.
func TestLoadOrCreate_NoProvider(t *testing.T) {
	dir := t.TempDir()
	cfg, policy, reg := testConfig(filepath.Join(dir, "content.db"))
	policy.defaultProvider = ""
	reg.providers = map[vault.ProviderID]vault.Provider{}

	_, err := LoadOrCreate(context.Background(), cfg)
	if err == nil {
		t.Fatal("no provider available but LoadOrCreate succeeded")
	}
}

// A provider that errors on read propagates the error — no fallback re-mint.
func TestLoadOrCreate_ProviderReadError(t *testing.T) {
	dir := t.TempDir()
	cfg, _, reg := testConfig(filepath.Join(dir, "content.db"))
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}
	sysProv, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing")
	}
	sysProv.getErr = errors.New("keychain unreachable")

	_, err := LoadOrCreate(ctx, cfg)
	if err == nil || !strings.Contains(err.Error(), "keychain unreachable") {
		t.Fatalf("read error = %v, want the provider's error", err)
	}
}

// Database exists but no slot holds the key → ErrKeyLost, and no re-mint:
// a new key would silently strand the database.
func TestLoadOrCreate_KeyLost(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "content.db")
	if err := os.WriteFile(dbPath, []byte("existing database"), 0o600); err != nil {
		t.Fatalf("write db: %v", err)
	}
	cfg, _, _ := testConfig(dbPath)

	_, err := LoadOrCreate(context.Background(), cfg)
	if !errors.Is(err, ErrKeyLost) {
		t.Fatalf("err = %v, want ErrKeyLost", err)
	}
	// No re-mint: no provider slot was written.
	sysProv, provOK := cfg.Registry.(*fakeRegistry).providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing")
	}
	if sysProv.putCalls != 0 {
		t.Fatalf("Put called %d times despite a lost key — re-mint would rotate it", sysProv.putCalls)
	}
}

// The key is the wrong length → error, and nothing is re-created.
func TestLoadOrCreate_WrongLength(t *testing.T) {
	dir := t.TempDir()
	cfg, _, reg := testConfig(filepath.Join(dir, "content.db"))
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}
	ref := credential.SecretID("sec:v1:system:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing")
	}
	prov.secrets[ref] = []byte("too short")

	_, err := LoadOrCreate(ctx, cfg)
	if err == nil || !strings.Contains(err.Error(), "unusable material") {
		t.Fatalf("err = %v, want a wrong-length error", err)
	}
}

// Put failure surfaces the provider's error.
func TestLoadOrCreate_PutError(t *testing.T) {
	dir := t.TempDir()
	cfg, _, reg := testConfig(filepath.Join(dir, "content.db"))
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing")
	}
	prov.putErr = errors.New("keychain denied")

	_, err := LoadOrCreate(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "keychain denied") {
		t.Fatalf("err = %v, want the put error", err)
	}
}

// ── provider choice ──────────────────────────────────────────────────────

// No default (uninitialized vault): the setup rule — system when ready,
// else file — so a machine with no Secret Service gets the other provider
// instead of an error.
func TestLoadOrCreate_NoDefaultUsesSetupRule(t *testing.T) {
	dir := t.TempDir()
	cfg, policy, reg := testConfig(filepath.Join(dir, "content.db"))
	policy.defaultProvider = ""

	sysProv, sysOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !sysOK {
		t.Fatal("system provider missing")
	}
	sysProv.ready = false
	if _, err := LoadOrCreate(context.Background(), cfg); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	fileProv, fileOK := reg.providers[vault.ProviderFile].(*fakeProvider)
	if !fileOK {
		t.Fatal("file provider missing")
	}
	if fileProv.putCalls != 1 {
		t.Fatal("setup rule did not fall back to the file provider")
	}
}
