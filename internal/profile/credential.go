package profile

import (
	"errors"
	"strings"
)

// Credential is a reusable authentication identity. It holds identity only —
// never a host. Which endpoints a credential may be spent on is computed from
// the saved profiles that reference it.
//
// Secrets live in the credential.SecretStore behind opaque references
// (ADR-0011 §2). SecretID and PassphraseSecretID are BACKEND-OWNED: they are
// stripped from every response and rejected on every request, so the renderer
// can neither read nor write them. That is why updates take a CredentialPatch
// rather than a whole record — a round trip through a renderer that was never
// shown these fields must not be able to blank them.
type Credential struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Username string   `json:"username"`
	Auth     AuthMode `json:"auth"`
	KeyPath  string   `json:"keyPath,omitempty"`

	// SecretID is the opaque reference to the stored password.
	SecretID string `json:"secretId,omitempty"`
	// PassphraseSecretID is the opaque reference to the stored key passphrase.
	PassphraseSecretID string `json:"passphraseSecretId,omitempty"`
	// KeyMaterialSecretID is the opaque reference to the stored private key
	// material. Mutually exclusive with KeyPath: storing key material clears
	// KeyPath, and setting KeyPath deletes stored key material.
	KeyMaterialSecretID string `json:"keyMaterialSecretId,omitempty"`

	// HasKeyMaterial is a computed response field: true when the credential
	// carries stored key material. Set only in list/create/update responses;
	// never persisted.
	HasKeyMaterial bool `json:"hasKeyMaterial"`
	// KeyFingerprint is a computed response field: the SHA256 fingerprint of
	// the credential's stored key. Set only in list/create/update responses;
	// never persisted.
	KeyFingerprint string `json:"keyFingerprint"`
}

// CredentialPatch is a sparse update. A nil field means "not mentioned, leave
// it alone"; a non-nil field means "set it to this", including to the zero
// value. Presence is the signal, never emptiness — the same rule the group
// defaults merge needs in wave 2, established here on the smaller aggregate.
//
// There is deliberately no SecretID field: secret references move only through
// credentials.savePassword and its siblings, which mint their own IDs.
type CredentialPatch struct {
	Name     *string
	Username *string
	Auth     *AuthMode
	KeyPath  *string
}

// WithPatch returns c with the patch applied. Fields the patch does not mention
// — and every backend-owned field, which the patch cannot mention — are carried
// over unchanged.
func (c Credential) WithPatch(p CredentialPatch) Credential {
	if p.Name != nil {
		c.Name = *p.Name
	}
	if p.Username != nil {
		c.Username = *p.Username
	}
	if p.Auth != nil {
		c.Auth = *p.Auth
	}
	if p.KeyPath != nil {
		c.KeyPath = *p.KeyPath
	}
	return c
}

// NewCredentialID generates a credential id: "cred:<slug>:<uuid>".
func NewCredentialID(name string) string {
	return "cred:" + slugify(name) + ":" + newUUID()
}

// Validate reports whether the credential may be stored.
func (c Credential) Validate() error {
	if strings.TrimSpace(c.ID) == "" {
		return errors.New("credential id is required")
	}
	if strings.TrimSpace(c.Name) == "" {
		return ErrCredentialNameRequired
	}
	return nil
}

var ErrCredentialNameRequired = errors.New("credential name is required")
