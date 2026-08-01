package contentkey

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/settings"
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
		return "", fmt.Errorf("unknown provider %q", p)
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

// fakeProvider is a writable provider for the registry.
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

type fakeRefStore struct {
	refs     map[string]credential.SecretID
	setErr   error
	setCalls int
}

func (s *fakeRefStore) SecretRef(k *settings.Secret) (credential.SecretID, bool) {
	id, ok := s.refs[k.Key()]
	return id, ok
}

func (s *fakeRefStore) SetSecretRef(k *settings.Secret, id credential.SecretID) error {
	s.setCalls++
	if s.setErr != nil {
		return s.setErr
	}
	if s.refs == nil {
		s.refs = make(map[string]credential.SecretID)
	}
	s.refs[k.Key()] = id
	return nil
}

func testConfig() (Config, *fakePolicy, *fakeRegistry, *fakeRefStore) {
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
	refs := &fakeRefStore{}
	return Config{Policy: policy, Registry: reg, RefStore: refs, Logger: log.NewSlogAdapter(nil)}, policy, reg, refs
}

// ── first run: mint once, persist the ref ────────────────────────────────

func TestLoadOrCreate_MintsAndPersistsRef(t *testing.T) {
	cfg, _, reg, refs := testConfig()
	ctx := context.Background()

	key, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("key = %d bytes, want 32", len(key))
	}
	ref, ok := refs.SecretRef(settings.ContentDBKey)
	if !ok {
		t.Fatal("no reference persisted after first run")
	}
	// The material landed in the default provider's slot.
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing from registry")
	}
	got, ok := prov.secrets[ref]
	if !ok || len(got) != 32 {
		t.Fatalf("provider slot missing or wrong length: %v, %d", ok, len(got))
	}
}

// Second run (reference present): the SAME key comes back — restart never
// rotates the key.
func TestLoadOrCreate_ReadsPersistedKey(t *testing.T) {
	cfg, _, _, _ := testConfig()
	ctx := context.Background()
	first, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	// Simulate a restart: the provider still holds the slot, the ref is set.
	second, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if string(second) != string(first) {
		t.Fatal("key changed across restarts — history would be unreadable")
	}
}

// ── failure paths ────────────────────────────────────────────────────────

// No provider at all: default unset and nothing writable → error, never a
// silently empty key.
func TestLoadOrCreate_NoProvider(t *testing.T) {
	cfg, policy, reg, _ := testConfig()
	policy.defaultProvider = ""
	reg.providers = map[vault.ProviderID]vault.Provider{} // nothing writable

	_, err := LoadOrCreate(context.Background(), cfg)
	if err == nil {
		t.Fatal("no provider available but LoadOrCreate succeeded")
	}
}

// The provider errors on read → error propagates, no fallback re-mint.
func TestLoadOrCreate_ProviderReadError(t *testing.T) {
	cfg, _, reg, _ := testConfig()
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}
	sysProv, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing from registry")
	}
	sysProv.getErr = errors.New("keychain unreachable")

	_, err := LoadOrCreate(ctx, cfg)
	if err == nil || !strings.Contains(err.Error(), "keychain unreachable") {
		t.Fatalf("read error = %v, want the provider's error", err)
	}
}

// Reference exists but material is gone → ErrKeyLost, and no re-mint: a new
// key would silently strand the existing database.
func TestLoadOrCreate_KeyLost(t *testing.T) {
	cfg, _, _, refs := testConfig()
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}
	// Wipe the provider slot behind the persisted ref.
	prov, provOK := cfg.Registry.(*fakeRegistry).providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing from registry")
	}
	prov.secrets = nil

	_, err := LoadOrCreate(ctx, cfg)
	if !errors.Is(err, ErrKeyLost) {
		t.Fatalf("err = %v, want ErrKeyLost", err)
	}
	// No re-mint: the ref was not replaced, the slot stays empty.
	if _, ok := refs.SecretRef(settings.ContentDBKey); !ok {
		t.Fatal("the reference was dropped — re-mint would rotate the key")
	}
	if refs.setCalls != 1 {
		t.Fatalf("SetSecretRef called %d times, want 1 (no re-mint)", refs.setCalls)
	}
}

// The key is the wrong length → error, and nothing is re-created.
func TestLoadOrCreate_WrongLength(t *testing.T) {
	cfg, _, reg, _ := testConfig()
	ctx := context.Background()
	if _, err := LoadOrCreate(ctx, cfg); err != nil {
		t.Fatalf("first: %v", err)
	}
	ref := credential.SecretID("sec:v1:system:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing from registry")
	}
	prov.secrets[ref] = []byte("too short")

	_, err := LoadOrCreate(ctx, cfg)
	if err == nil || !strings.Contains(err.Error(), "want 32") {
		t.Fatalf("err = %v, want a wrong-length error", err)
	}
}

// A malformed persisted reference is rejected by the vault-owned parser.
func TestLoadOrCreate_MalformedRef(t *testing.T) {
	cfg, _, _, _ := testConfig()
	refStore, refOK := cfg.RefStore.(*fakeRefStore)
	if !refOK {
		t.Fatal("unexpected ref store type")
	}
	refStore.refs = map[string]credential.SecretID{
		settings.ContentDBKey.Key(): "not-a-reference",
	}
	_, err := LoadOrCreate(context.Background(), cfg)
	if err == nil {
		t.Fatal("malformed persisted reference accepted")
	}
}

// ── crash recovery: Put landed, ref never persisted ─────────────────────

// A settings-write failure after a successful Put must not rotate the key:
// the next startup finds the slot and repairs the reference.
func TestLoadOrCreate_PutWithoutRefIsRepaired(t *testing.T) {
	cfg, _, reg, refs := testConfig()
	ctx := context.Background()

	// First run with a failing ref store: the key IS stored, the ref is not.
	refs.setErr = errors.New("settings write failed")
	key1, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	// Next startup: ref store healthy again. The slot probe must find the
	// stored key, persist the ref, and return the SAME key.
	refs.setErr = nil
	key2, err := LoadOrCreate(ctx, cfg)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if string(key1) != string(key2) {
		t.Fatal("key rotated across a ref-persist failure — the existing database is stranded")
	}
	ref, ok := refs.SecretRef(settings.ContentDBKey)
	if !ok {
		t.Fatal("reference not repaired")
	}
	prov, provOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !provOK {
		t.Fatal("system provider missing from registry")
	}
	if prov.putCalls != 1 {
		t.Fatalf("provider Put called %d times, want 1 (no re-mint)", prov.putCalls)
	}
	_ = ref
}

// ── provider choice ──────────────────────────────────────────────────────

// The default provider is used when set — the way every other secret's
// provider is chosen.
func TestLoadOrCreate_UsesDefaultProvider(t *testing.T) {
	cfg, policy, reg, _ := testConfig()
	policy.defaultProvider = vault.ProviderFile

	_, err := LoadOrCreate(context.Background(), cfg)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	fileProv, fileOK := reg.providers[vault.ProviderFile].(*fakeProvider)
	if !fileOK {
		t.Fatal("file provider missing from registry")
	}
	if fileProv.putCalls != 1 {
		t.Fatalf("file provider Put calls = %d, want 1 (default provider holds the key)", fileProv.putCalls)
	}
	sysProv, sysOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !sysOK {
		t.Fatal("system provider missing from registry")
	}
	if sysProv.putCalls != 0 {
		t.Fatalf("system provider Put calls = %d, want 0", sysProv.putCalls)
	}
}

// No default (uninitialized vault): the setup rule — system when ready,
// else file — so a machine with no Secret Service gets the other provider
// instead of an error.
func TestLoadOrCreate_NoDefaultUsesSetupRule(t *testing.T) {
	cfg, policy, reg, _ := testConfig()
	policy.defaultProvider = ""

	// System not ready → file.
	sysProv, sysOK := reg.providers[vault.ProviderSystem].(*fakeProvider)
	if !sysOK {
		t.Fatal("system provider missing from registry")
	}
	sysProv.ready = false
	if _, err := LoadOrCreate(context.Background(), cfg); err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	fileProv, fileOK := reg.providers[vault.ProviderFile].(*fakeProvider)
	if !fileOK {
		t.Fatal("file provider missing from registry")
	}
	if fileProv.putCalls != 1 {
		t.Fatal("setup rule did not fall back to the file provider")
	}
}
