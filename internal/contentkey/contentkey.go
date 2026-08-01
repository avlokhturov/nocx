// Package contentkey owns the ContentDB key's lifecycle (nocx-rtg0.9,
// ADR-0018 §3).
//
// The reference is DERIVED, never persisted. settings.json is a portable
// document — it syncs between machines, is backed up, gets copied — and a
// sec:v1:<provider>:<id> reference points at a provider slot on THIS
// machine: carried elsewhere it points at nothing. So at startup the id is
// recomputed (the osKeyID shape), the provider's slot is asked, and the key
// is found or created. The provider slot is the source of truth.
//
// Two consequences. The read goes through the raw provider Get (no vault
// seal gate), so the key is read ONCE at startup and held for the process —
// a vault auto-seal can never make history unreadable. And the database's
// existence is the "was history ever created" marker: when no slot holds a
// key but content.db exists, the key is LOST and must never be re-minted (a
// new key would strand the existing database while the UI claimed history
// worked).
package contentkey

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/vault"
)

// ErrKeyLost reports that the database exists but no provider slot holds its
// key. The key is cryptographically unrecoverable (ADR-0018 §5) and MUST NOT
// be re-minted.
var ErrKeyLost = errors.New("content key: database exists but its key is gone from every provider slot")

// KeyPolicy is the vault surface contentkey needs: default-provider routing
// and the deterministic system-key reference. Implemented by *vault.Vault —
// the reference grammar stays owned by the vault (internal/vault/id.go).
type KeyPolicy interface {
	DefaultProvider() vault.ProviderID
	ContentKeyID(p vault.ProviderID) (credential.SecretID, error)
	ProviderOf(id credential.SecretID) (vault.ProviderID, error)
}

// ProviderRegistry is the provider seam. Implemented by *vault.Registry.
type ProviderRegistry interface {
	Get(id vault.ProviderID) (vault.Provider, bool)
	Writable(id vault.ProviderID) (vault.WritableProvider, bool)
	List() []vault.Provider
}

// Config is the dependency set for the key lifecycle.
type Config struct {
	Policy   KeyPolicy
	Registry ProviderRegistry
	// DBPath is the content.db path. Its existence distinguishes first run
	// (create the key) from a lost key (never re-mint). The database lives
	// in the DATA directory beside the key's slot — never in the portable
	// config directory.
	DBPath string
	Logger log.Logger
}

// LoadOrCreate returns the 32-byte ContentDB key. Called once at startup;
// the caller holds the bytes for the life of the process.
func LoadOrCreate(ctx context.Context, cfg Config) ([]byte, error) {
	if cfg.Logger == nil {
		cfg.Logger = log.NewSlogAdapter(nil)
	}

	// Find the key in any provider's derived slot. The default provider (or
	// the setup rule when unset) is asked first; the others follow, so a
	// default-provider change never strands the key — the reference is
	// immutable and its provider is encoded in the derivation.
	for _, p := range providerOrder(ctx, cfg) {
		id, err := cfg.Policy.ContentKeyID(p)
		if err != nil {
			return nil, err
		}
		sec, err := providerGet(ctx, cfg, id)
		switch {
		case err == nil:
			key, ok := secretBytes(sec)
			if !ok || len(key) != 32 {
				return nil, fmt.Errorf("content key: slot %q holds unusable material (len %d)", id, len(key))
			}
			return key, nil
		case !errors.Is(err, vault.ErrSecretNotFound):
			return nil, fmt.Errorf("content key: probe %q: %w", p, err)
		}
	}

	// No slot holds a key. If the database exists, the key is LOST — re-
	// minting would rotate it and strand the database. If not, first run.
	if _, err := os.Stat(cfg.DBPath); err == nil {
		return nil, ErrKeyLost
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("content key: stat database: %w", err)
	}
	return create(ctx, cfg)
}

// create mints the key at the first provider in the order (the default, or
// the setup rule when unset) and stores it in its derived slot.
func create(ctx context.Context, cfg Config) ([]byte, error) {
	order := providerOrder(ctx, cfg)
	if len(order) == 0 {
		return nil, errors.New("content key: no provider available")
	}
	p := order[0]
	w, ok := cfg.Registry.Writable(p)
	if !ok {
		return nil, fmt.Errorf("content key: provider %q is not writable", p)
	}
	id, err := cfg.Policy.ContentKeyID(p)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("content key: generate: %w", err)
	}
	if err := w.Put(ctx, id, credential.NewSecretBytes(key)); err != nil {
		return nil, fmt.Errorf("content key: store at %q: %w", p, err)
	}
	cfg.Logger.Info("content key minted", "provider", p)
	return key, nil
}

// providerOrder is the deterministic probe order: the default provider (or
// the setup rule when the vault has none), then every other REGISTERED
// provider — read-only ones included, because a key stored before a
// provider lost its write capability must still be discoverable. The
// registry is bounded (system + file at the composition root), so this is
// at most two probes. Writability is checked only on the creation
// candidate, never on the recovery set.
func providerOrder(ctx context.Context, cfg Config) []vault.ProviderID {
	var order []vault.ProviderID
	if p := cfg.Policy.DefaultProvider(); p != "" {
		order = append(order, p)
	} else if p := setupRule(ctx, cfg.Registry); p != "" {
		order = append(order, p)
	}
	for _, prov := range cfg.Registry.List() {
		order = append(order, prov.ID())
	}
	return dedupe(order)
}

func dedupe(in []vault.ProviderID) []vault.ProviderID {
	out := make([]vault.ProviderID, 0, len(in))
	seen := map[vault.ProviderID]bool{}
	for _, p := range in {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
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
