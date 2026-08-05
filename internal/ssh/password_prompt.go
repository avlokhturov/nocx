package ssh

import (
	"context"

	gossh "golang.org/x/crypto/ssh"
)

// PasswordRequest names which connection and account a password is being
// asked for. Every password prompt must name the password it is asking
// about (nocx-s8jn) — a bare "enter password" box is how the wrong
// password ends up in the wrong connection.
type PasswordRequest struct {
	// Connection is the saved profile's display name; empty for
	// direct-host opens, which do not raise prompts.
	Connection string
	User       string
	Host       string
	// Reason says why the password is being asked: no password is stored
	// for the connection, or the stored one was rejected. Display text,
	// never a code.
	Reason string
}

// PasswordAnswer is the renderer's answer to a PasswordRequest.
type PasswordAnswer struct {
	// Password is the value to use for THIS connection's auth attempt.
	Password string
	// Remember asks the caller to store the answer as a vault secret the
	// profile references (ADR-0017), so the next open is silent. The
	// caller — the connection layer — decides how and where it stores;
	// this package only ever uses Password for the auth attempt.
	Remember bool
}

// ConnectionPasswordRequester asks the user for a connection password. The
// same shape as the vault unlock requester (backend asks a renderer and
// blocks for the answer, AD-8: behind an interface, wired at the one
// composition root), so the ssh package never imports transport. The
// connection resolver implements it: it adapts the transport's wire ask
// and does the remember (vault secret + profile reference).
type ConnectionPasswordRequester interface {
	RequestConnectionPassword(ctx context.Context, req PasswordRequest) (PasswordAnswer, error)
}

// promptPasswordMethod builds the prompt-password rung: a live password
// callback that asks the renderer when the server challenges. It is the
// LAST password rung — the saved-password rung, when one is stored,
// precedes it, so the server's rejection of stored material is what
// reaches the prompt (tabby's model: the ladder always ends with the
// prompt rung, so a password-capable connection never ends empty and there
// is no need for a "the ladder came out empty" fallback).
//
// When cfg.PasswordRequester is nil (direct-host opens, tests, nothing
// wired) the rung carries no method and behaves exactly as it did before:
// the probe reports it as needing interaction (ErrEncryptedKey) and the
// connect path simply has nothing to offer.
func (rc *RealClient) promptPasswordMethod(ctx context.Context, cfg *ConnectConfig, resolved *resolvedConfig, storedBeforePrompt bool) gossh.AuthMethod {
	if cfg.PasswordRequester == nil {
		return nil
	}
	return gossh.PasswordCallback(rc.promptPasswordCallback(ctx, cfg, resolved, storedBeforePrompt))
}

// promptPasswordCallback returns the raw callback the prompt rung wraps. It
// is separate from promptPasswordMethod only so tests can invoke it without
// a live SSH handshake; the callback's contract is the same either way.
func (rc *RealClient) promptPasswordCallback(ctx context.Context, cfg *ConnectConfig, resolved *resolvedConfig, storedBeforePrompt bool) func() (string, error) {
	return func() (string, error) {
		reason := "no password is stored for this connection"
		if storedBeforePrompt {
			reason = "the stored password was rejected"
		}
		ans, err := cfg.PasswordRequester.RequestConnectionPassword(ctx, PasswordRequest{
			Connection: cfg.ConnectionName,
			User:       resolved.user,
			Host:       resolved.hostName,
			Reason:     reason,
		})
		if err != nil {
			return "", err
		}
		return ans.Password, nil
	}
}

// hasStoredPasswordRung reports whether the chain already carries a stored
// password before the prompt rung. When it does, a prompt that fires means
// the server rejected the stored material; otherwise it means nothing was
// stored.
func hasStoredPasswordRung(chain []authChainEntry) bool {
	for _, e := range chain {
		if e.kind == kindSavedPassword {
			return true
		}
	}
	return false
}
