package ssh

import (
	"errors"
	"fmt"
)

// Domain error markers for the SSH package. Each wraps a distinguishable
// type the UI layer can switch on to surface the right user-facing action
// (e.g. "unknown host — add to known_hosts?", "wrong key — try another?").

// ErrAuthFailed is returned when none of the supplied auth methods succeeded.
type ErrAuthFailed struct {
	User string
	Host string
	Err  error
}

func (e *ErrAuthFailed) Error() string {
	return fmt.Sprintf("ssh authentication failed for %s@%s: %v", e.User, e.Host, e.Err)
}

func (e *ErrAuthFailed) Unwrap() error { return e.Err }

// ErrHostKeyMismatch is returned when the host key presented by the remote
// does not match the one recorded in known_hosts.
type ErrHostKeyMismatch struct {
	Addr        string
	Fingerprint string
	Expected    string
}

func (e *ErrHostKeyMismatch) Error() string {
	return fmt.Sprintf("host key mismatch for %s: got %s, expected %s",
		e.Addr, e.Fingerprint, e.Expected)
}

// ErrUnknownHostKey is returned when the remote host is not present in
// known_hosts at all. The UI should prompt the user to accept and add it.
type ErrUnknownHostKey struct {
	Addr        string
	KeyAlgo     string
	Fingerprint string
}

func (e *ErrUnknownHostKey) Error() string {
	return fmt.Sprintf("unknown host key for %s: %s %s",
		e.Addr, e.KeyAlgo, e.Fingerprint)
}

// ErrEncryptedKey is returned when a private key requires a passphrase.
type ErrEncryptedKey struct {
	Path string
}

func (e *ErrEncryptedKey) Error() string {
	return fmt.Sprintf("private key %s is encrypted and requires a passphrase (not supported)", e.Path)
}

// Sentinel errors used internally.
var (
	errNoAuthMethods = errors.New("no usable auth methods")
)

// ErrCredentialNotBound is returned when a linked credential carries no
// bound host. "Any host" is the credential-redirection hole (nocx-mon/PR11-T5):
// an authenticated renderer can point a victim credential at a host it
// controls and have the backend submit the password there. Refused at
// connect time, before any dial. The UI should prompt the user to bind the
// credential to its intended target.
type ErrCredentialNotBound struct {
	CredentialID string
}

func (e *ErrCredentialNotBound) Error() string {
	if e.CredentialID == "" {
		return "credential is not bound to a host — refusing to submit it"
	}
	return fmt.Sprintf("credential %s is not bound to a host — refusing to submit it", e.CredentialID)
}

// ErrCredentialBindingMismatch is returned when a linked credential's bound
// host (and port, when set) does not match the resolved target. Matching uses
// the resolved hostname and effective port after ~/.ssh/config merge — never
// the alias the renderer chose, which an attacker can remap via HostName.
type ErrCredentialBindingMismatch struct {
	CredentialID string
	BoundHost    string
	BoundPort    int
	ResolvedHost string
	ResolvedPort int
	Jump         bool
}

func (e *ErrCredentialBindingMismatch) Error() string {
	hop := "target"
	if e.Jump {
		hop = "jump host"
	}
	return fmt.Sprintf("credential %s is bound to %s:%d but the %s resolves to %s:%d — refusing to submit it",
		e.CredentialID, e.BoundHost, e.BoundPort, hop, e.ResolvedHost, e.ResolvedPort)
}

// ErrDisconnected is returned when an operation is attempted on a channel
// whose underlying SSH connection has been closed. It is distinguishable
// from a transient network error — this channel is permanently dead.
// Callers can check for it with errors.As.
type ErrDisconnected struct{}

func (e *ErrDisconnected) Error() string {
	return "ssh channel disconnected"
}
