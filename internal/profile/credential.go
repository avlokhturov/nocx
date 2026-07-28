package profile

import (
	"errors"
	"strings"
)

// Credential is a reusable authentication identity. It holds identity only —
// never a host. Which endpoints a credential may be spent on is computed from
// the saved profiles that reference it — but NOT yet. Host and Port stay here
// through wave 1 because checkBinding (ssh_config.go:105) refuses a connection
// whose BoundHost is empty and the resolver fills it from this field. They are
// deleted in wave 2, in the same commit range that makes computed authorization
// live. This move is a file move, not a semantic change.
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

	// Host/Port: see the note above. Renderer-owned while they exist.
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`

	// SecretID is the opaque reference to the stored password.
	SecretID string `json:"secretId,omitempty"`
	// PassphraseSecretID is the opaque reference to the stored key passphrase.
	PassphraseSecretID string `json:"passphraseSecretId,omitempty"`
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
	Host     *string // removed in wave 2 with the field
	Port     *int    // removed in wave 2 with the field
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
	if p.Host != nil {
		c.Host = *p.Host
	}
	if p.Port != nil {
		c.Port = *p.Port
	}
	return c
}

// NewCredentialID generates a credential id: "cred:<slug>:<uuid>".
func NewCredentialID(name string) string {
	return "cred:" + slugify(name) + ":" + newUUID()
}

// Validate reports whether the credential may be stored. The host check is
// unchanged from profile.go and stays until wave 2 removes the field with the
// binding it feeds; the two identity checks are new, and they are what remains
// once the host check goes.
func (c Credential) Validate() error {
	if strings.TrimSpace(c.Name) == "" {
		return ErrCredentialNameRequired
	}
	if strings.TrimSpace(c.Username) == "" {
		return ErrCredentialUsernameRequired
	}
	if strings.TrimSpace(c.Host) == "" {
		return ErrCredentialHostRequired
	}
	return nil
}

// ErrCredentialHostRequired is nocx-mon's policy, moved here verbatim. It goes
// away in wave 2 together with Credential.Host, when computed authorization
// replaces the binding it enforces — not before, because checkBinding refuses
// an empty BoundHost and the resolver has nothing else to fill it from.
var ErrCredentialHostRequired = errors.New("credential must be bound to a host")

// ErrCredentialNameRequired and ErrCredentialUsernameRequired are the identity
// completeness checks. They are additive: the host check above still runs.
var (
	ErrCredentialNameRequired     = errors.New("credential name is required")
	ErrCredentialUsernameRequired = errors.New("credential username is required")
)
