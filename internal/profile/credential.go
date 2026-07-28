package profile

import (
	"errors"
	"fmt"
	"strings"
	"time"
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

	// Versions holds the history of secret material for this credential.
	// A record written before versions existed has no Versions list and a
	// bare SecretID; Current() synthesises one current version from those
	// fields, so existing stores load with no migration step.
	Versions []CredentialVersion `json:"versions,omitempty"`

	// CurrentVersionID names the version a normal connection uses.
	// The resolver publishes its secret references onto the config.
	CurrentVersionID string `json:"currentVersionId,omitempty"`

	// CandidateVersionID names a version being staged for rollout.
	// Unused until wave 8 — carried here so the model exists, not built on.
	CandidateVersionID string `json:"candidateVersionId,omitempty"`
}

// CredentialVersion is one generation of a credential's secret material. It is
// typed per auth method: a generic "version with a SecretID" would be
// password-shaped and would break on the first key rotation.
type CredentialVersion struct {
	ID string `json:"id"`

	// Auth is the credential's auth mode at the time this version was created.
	// Used to validate version consistency against the credential's auth type.
	Auth AuthMode `json:"auth,omitempty"`

	// PasswordSecretID is the keychain reference for the password.
	PasswordSecretID string `json:"passwordSecretId,omitempty"`
	// PassphraseSecretID is the keychain reference for the key passphrase.
	PassphraseSecretID string `json:"passphraseSecretId,omitempty"`

	// KeyFingerprint is the SHA256 of the credential's public key, recorded
	// by the backend when a key is saved. It is the identity of a key version.
	KeyFingerprint string `json:"keyFingerprint,omitempty"`

	// Created records when this version was created.
	Created time.Time `json:"created,omitempty"`
}

const legacyVersionID = "v1"

// Current returns the version a normal connection uses. A record written before
// versions existed has no list and a bare SecretID; it reads as a single
// current version, so an existing store loads with no migration step and no
// window in which a password is unreachable.
func (c Credential) Current() (CredentialVersion, bool) {
	if len(c.Versions) == 0 {
		return CredentialVersion{ID: legacyVersionID, PasswordSecretID: c.SecretID, PassphraseSecretID: c.PassphraseSecretID}, true
	}
	if c.CurrentVersionID == "" {
		return CredentialVersion{}, false
	}
	return c.Version(c.CurrentVersionID)
}

// Version returns the version with the given ID, or false if not found.
func (c Credential) Version(id string) (CredentialVersion, bool) {
	for _, v := range c.Versions {
		if v.ID == id {
			return v, true
		}
	}
	return CredentialVersion{}, false
}

// ValidateVersion reports whether the version's fields are consistent with its
// auth method. A password version must not carry KeyFingerprint; an agent
// version must carry neither password nor key fields.
func (v CredentialVersion) ValidateVersion() error {
	switch v.Auth {
	case AuthPassword, AuthKeyboardInteractive:
		if v.KeyFingerprint != "" {
			return errors.New("password/keyboard-interactive credential version carries a key fingerprint")
		}
	case AuthPublicKey:
		// Public key versions may have a key fingerprint and/or passphrase.
	case AuthAgent:
		if v.PasswordSecretID != "" || v.KeyFingerprint != "" {
			return errors.New("agent credential version carries keys or passwords")
		}
	}
	return nil
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
	if strings.TrimSpace(c.Username) == "" {
		return ErrCredentialUsernameRequired
	}
	for _, v := range c.Versions {
		if err := v.ValidateVersion(); err != nil {
			return fmt.Errorf("credential %q version %q: %w", c.Name, v.ID, err)
		}
	}
	return nil
}

// ErrCredentialNameRequired and ErrCredentialUsernameRequired are the identity
// completeness checks.
var (
	ErrCredentialNameRequired     = errors.New("credential name is required")
	ErrCredentialUsernameRequired = errors.New("credential username is required")
)
