// Package contentkey owns the ContentDB key's lifecycle (nocx-rtg0.9,
// ADR-0018 §3).
//
// The one non-negotiable property: auto-seal must never make history
// unreadable. The resolution is lifecycle, not crypto — the key is read ONCE
// at startup and held by the store for the life of the process, so a later
// vault seal is irrelevant. That requires the read to bypass the vault's
// user-secret gates (Create/Get refuse sealed and uninitialized states), so
// the key is stored and read through the PROVIDER seam directly — the same
// providers every other secret uses, chosen the way everything else chooses
// them (the vault's default provider, with the setup rule as the unset
// fallback), so a machine with no Secret Service gets the file provider
// instead of an error.
//
// The reference (a deterministic sec:v1:<provider>:… id, the osKeyID shape)
// is persisted in the settings document, like every other secret reference.
// The provider slot is the source of truth: if a Put landed but the
// reference never persisted, the next startup finds the slot and repairs the
// reference instead of minting a new key — a settings-write failure must
// never rotate the key and strand an existing database.
package contentkey

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/settings"
	"github.com/shady2k/nocx/internal/vault"
)

// ErrKeyLost reports a persisted reference whose material is gone. The key
// is cryptographically unrecoverable (ADR-0018 §5) and MUST NOT be re-minted
// — a new key would make the existing content.db unreadable while the UI
// claimed history worked.
var ErrKeyLost = errors.New("content key: stored reference exists but its material is gone")

// KeyPolicy is the vault surface contentkey needs: default-provider routing
// and the system-key reference grammar. Implemented by *vault.Vault — the
// reference syntax stays owned by the vault (internal/vault/id.go).
type KeyPolicy interface {
	DefaultProvider() vault.ProviderID
	ContentKeyID(p vault.ProviderID) (credential.SecretID, error)
	ProviderOf(id credential.SecretID) (vault.ProviderID, error)
}

// ProviderRegistry is the provider seam. Implemented by *vault.Registry.
type ProviderRegistry interface {
	Get(id vault.ProviderID) (vault.Provider, bool)
	Writable(id vault.ProviderID) (vault.WritableProvider, bool)
}

// RefStore persists the reference in the settings document.
// Implemented by *settings.Registry.
type RefStore interface {
	SecretRef(s *settings.Secret) (credential.SecretID, bool)
	SetSecretRef(s *settings.Secret, id credential.SecretID) error
}

// Config is the dependency set for the key lifecycle.
type Config struct {
	Policy   KeyPolicy
	Registry ProviderRegistry
	RefStore RefStore
	Logger   log.Logger
}

// LoadOrCreate returns the 32-byte ContentDB key, minting it on first run
// through the provider seam. Called once at startup; the caller holds the
// bytes for the life of the process.
func LoadOrCreate(ctx context.Context, cfg Config) ([]byte, error) {
	if cfg.Logger == nil {
		cfg.Logger = log.NewSlogAdapter(nil)
	}
	ref, ok := cfg.RefStore.SecretRef(settings.ContentDBKey)
	if !ok {
		return create(ctx, cfg)
	}
	return read(ctx, cfg, ref)
}

// create mints the key on first run. The provider slot is probed first: a
// Put that landed without its reference (settings write failed) must be
// repaired, not overwritten — key rotation would strand the existing
// database.
func create(ctx context.Context, cfg Config) ([]byte, error) {
	p := cfg.Policy.DefaultProvider()
	if p == "" {
		p = setupRule(ctx, cfg.Registry)
	}
	id, err := cfg.Policy.ContentKeyID(p)
	if err != nil {
		return nil, err
	}

	// Slot probe: crash-recovery for Put-without-ref.
	sec, getErr := providerGet(ctx, cfg, id)
	switch {
	case getErr == nil:
		key, ok := secretBytes(sec)
		if !ok || len(key) != 32 {
			return nil, fmt.Errorf("content key: provider slot %q holds unusable material (len %d)", id, len(key))
		}
		if err := cfg.RefStore.SetSecretRef(settings.ContentDBKey, id); err != nil {
			return nil, fmt.Errorf("content key: persist reference: %w", err)
		}
		cfg.Logger.Info("content key: reused existing provider slot, repaired missing reference")
		return key, nil
	case !errors.Is(getErr, vault.ErrSecretNotFound):
		return nil, fmt.Errorf("content key: probe provider slot: %w", getErr)
	}

	w, ok := cfg.Registry.Writable(p)
	if !ok {
		return nil, fmt.Errorf("content key: provider %q is not writable", p)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("content key: generate: %w", err)
	}
	if err := w.Put(ctx, id, credential.NewSecretBytes(key)); err != nil {
		return nil, fmt.Errorf("content key: store at %q: %w", p, err)
	}
	if err := cfg.RefStore.SetSecretRef(settings.ContentDBKey, id); err != nil {
		// The key IS stored; only the pointer failed. The next startup's
		// slot probe repairs it. This session keeps the key it holds.
		cfg.Logger.Warn("content key stored but reference not persisted; will repair on next startup", "error", err)
	}
	return key, nil
}

// read loads a persisted reference's material through its named provider.
func read(ctx context.Context, cfg Config, ref credential.SecretID) ([]byte, error) {
	p, err := cfg.Policy.ProviderOf(ref)
	if err != nil {
		return nil, fmt.Errorf("content key: malformed persisted reference: %w", err)
	}
	sec, err := providerGet(ctx, cfg, ref)
	if err != nil {
		if errors.Is(err, vault.ErrSecretNotFound) {
			return nil, ErrKeyLost
		}
		return nil, fmt.Errorf("content key: read from %q: %w", p, err)
	}
	key, ok := secretBytes(sec)
	if !ok || len(key) != 32 {
		return nil, fmt.Errorf("content key: reference %q holds %d bytes, want 32", ref, len(key))
	}
	return key, nil
}

// providerGet reads a secret through the raw provider seam — no vault seal
// gate — so the startup read works on a sealed vault for providers that do
// not lock (the system provider). The file provider requires the vault to be
// unsealed (its material is encrypted under the root key); the resulting
// failure is the caller's no-history fallback.
func providerGet(ctx context.Context, cfg Config, id credential.SecretID) (credential.Secret, error) {
	p, err := cfg.Policy.ProviderOf(id)
	if err != nil {
		return credential.Secret{}, err
	}
	prov, ok := cfg.Registry.Get(p)
	if !ok {
		return credential.Secret{}, fmt.Errorf("%w: %s", vault.ErrProviderUnavailable, p)
	}
	return prov.Get(ctx, id)
}

// setupRule mirrors the vault's own choice when no default is set: the
// system provider when it is writable and ready, else the file provider.
// A machine with no Secret Service gets the other provider instead of an
// error — the owner's correction verbatim.
func setupRule(ctx context.Context, reg ProviderRegistry) vault.ProviderID {
	for _, p := range []vault.ProviderID{vault.ProviderSystem, vault.ProviderFile} {
		if w, ok := reg.Writable(p); ok && w.Status(ctx).Ready {
			return p
		}
	}
	return ""
}

// secretBytes extracts the plaintext through Use. Returns ok=false when Use
// itself failed.
func secretBytes(s credential.Secret) (key []byte, ok bool) {
	var out []byte
	err := s.Use(func(b []byte) error {
		out = append(out, b...)
		return nil
	})
	return out, err == nil
}
