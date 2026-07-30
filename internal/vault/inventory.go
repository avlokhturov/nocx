package vault

import (
	"context"
	"fmt"
	"sort"

	"github.com/shady2k/nocx/internal/credential"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// InventoryEntry is one item in the vault.inventory response.
type InventoryEntry struct {
	Kind      string `json:"kind"`      // "password" | "key-passphrase"
	Label     string `json:"label"`     // derived description (never user-invented)
	Provider  string `json:"provider"`  // provider tag from the secret reference
	OwnerID   string `json:"ownerId"`   // credential ID that owns this secret
	UsedBy    int    `json:"usedBy"`    // how many profiles reference the credential
	Reachable bool   `json:"reachable"` // whether the provider reports Status().Ready
}

// CredentialInventory contains the metadata needed to derive inventory entries
// for one credential. This is a plain-data projection — no profile package types.
type CredentialInventory struct {
	ID                 string
	Username           string
	AuthMode           string // "password", "publicKey", "agent", etc.
	SecretID           string // legacy bare reference
	PassphraseSecretID string // legacy bare reference
	Versions           []CredentialVersionInventory
	UsageCount         int
	// For single-use passwords, the effective host and port of the sole profile.
	SingleHost string
	SinglePort int
}

// CredentialVersionInventory projects the version metadata the label needs.
type CredentialVersionInventory struct {
	PasswordSecretID   string
	PassphraseSecretID string
	KeyFingerprint     string
}

// secretRef is an internal representation of a unique secret reference found
// during traversal of all credential versions.
type secretRef struct {
	ref            credential.SecretID
	kind           string // "password" | "key-passphrase"
	keyFingerprint string // non-empty only for "key-passphrase"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ProviderOf extracts the provider tag from a secret reference. This is the
// only public API for reference parsing — no consumer branches on the prefix
// (AD-8, spec §4.1).
func ProviderOf(id credential.SecretID) (ProviderID, error) {
	return parseID(id)
}

// ProviderStatus returns the provider tag and reachability for a secret
// reference. When the provider tag is not registered, ready is false and err
// is nil — the caller treats the entry as unreachable rather than failing
// the whole call.
func (v *Vault) ProviderStatus(ctx context.Context, id credential.SecretID) (provider ProviderID, ready bool, reason Reason, err error) {
	p, err := parseID(id)
	if err != nil {
		return "", false, "", fmt.Errorf("provider status: %w", err)
	}
	prov, ok := v.reg.Get(p)
	if !ok {
		return p, false, ReasonUnknownProvider, nil
	}
	status := prov.Status(ctx)
	return p, status.Ready, status.Reason, nil
}

// BuildInventory assembles the full inventory from credential metadata. It
// traverses every credential's versions (and legacy bare fields) to collect
// unique secret references, maps each to its provider, checks reachability,
// and derives the label — all within the vault package where reference
// parsing is private.
//
// An unregistered provider tag does not fail the call: the entry reports
// reachable=false and the caller continues.
//
// Returns ErrVaultSealed when the vault is sealed. Returns
// ErrVaultUninitialized when the vault has not been set up.
func (v *Vault) BuildInventory(ctx context.Context, inputs []CredentialInventory) ([]InventoryEntry, error) {
	v.mu.Lock()
	state := v.stateLocked()
	v.mu.Unlock()

	switch state {
	case StateUninitialized:
		return nil, ErrVaultUninitialized
	case StateSealed:
		return nil, ErrVaultSealed
	}

	var entries []InventoryEntry

	for _, cred := range inputs {
		refs := collectRefs(cred)

		for _, sr := range refs {
			providerID, err := parseID(sr.ref)
			if err != nil {
				// Malformed reference — skip this entry, don't fail the whole call.
				continue
			}

			// Check reachability
			prov, provOK := v.reg.Get(providerID)
			reachable := false
			if provOK {
				status := prov.Status(ctx)
				reachable = status.Ready
			}

			label := deriveLabel(sr, cred)

			entries = append(entries, InventoryEntry{
				Kind:      sr.kind,
				Label:     label,
				Provider:  string(providerID),
				OwnerID:   cred.ID,
				UsedBy:    cred.UsageCount,
				Reachable: reachable,
			})
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].OwnerID < entries[j].OwnerID
	})

	return entries, nil
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// collectRefs gathers unique secret references from a credential's versions
// AND its legacy bare fields (which may coexist during migration). Unconditional
// collection of both sources followed by deduplication ensures no secret is
// missed when a credential transitions from the legacy format.
func collectRefs(cred CredentialInventory) []secretRef {
	seen := make(map[credential.SecretID]bool)
	var refs []secretRef

	// Legacy bare top-level fields.
	if cred.SecretID != "" {
		id := credential.SecretID(cred.SecretID)
		if !seen[id] {
			seen[id] = true
			refs = append(refs, secretRef{ref: id, kind: "password"})
		}
	}
	if cred.PassphraseSecretID != "" {
		id := credential.SecretID(cred.PassphraseSecretID)
		if !seen[id] {
			seen[id] = true
			refs = append(refs, secretRef{ref: id, kind: "key-passphrase"})
		}
	}

	// Version-level fields.
	for _, v := range cred.Versions {
		if v.PasswordSecretID != "" {
			id := credential.SecretID(v.PasswordSecretID)
			if !seen[id] {
				seen[id] = true
				refs = append(refs, secretRef{ref: id, kind: "password"})
			}
		}
		if v.PassphraseSecretID != "" {
			id := credential.SecretID(v.PassphraseSecretID)
			if !seen[id] {
				seen[id] = true
				refs = append(refs, secretRef{
					ref:            id,
					kind:           "key-passphrase",
					keyFingerprint: v.KeyFingerprint,
				})
			}
		}
	}

	return refs
}

// deriveLabel produces the user-facing label for a secret entry.
//
// Rules:
//   - password used by one profile → "SSH password for {user}@{host}:{port}"
//   - password used by several    → "SSH password for {user}"
//   - key passphrase              → "Passphrase for key SHA256:{first 8 of fingerprint}…"
func deriveLabel(sr secretRef, cred CredentialInventory) string {
	switch sr.kind {
	case "password":
		if cred.UsageCount == 1 && cred.SingleHost != "" {
			return fmt.Sprintf("SSH password for %s@%s:%d", cred.Username, cred.SingleHost, cred.SinglePort)
		}
		return fmt.Sprintf("SSH password for %s", cred.Username)

	case "key-passphrase":
		fp := sr.keyFingerprint
		if len(fp) > 8 {
			fp = fp[:8]
		}
		return fmt.Sprintf("Passphrase for key SHA256:%s…", fp)

	default:
		return "Unknown secret"
	}
}
