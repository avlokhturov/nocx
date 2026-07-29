package ssh

import (
	"context"
	"errors"
	"net"
)

// ProbeOutcome is a closed-enum outcome for an SSH credential probe.
// The Go type holds only the five defined values; a sixth kind cannot be
// expressed at compile time.
type ProbeOutcome string

const (
	OutcomeAccepted         ProbeOutcome = "accepted"
	OutcomeRejected         ProbeOutcome = "rejected"
	OutcomeUnreachable      ProbeOutcome = "unreachable"
	OutcomeHostKeyProblem   ProbeOutcome = "host-key-problem"
	OutcomeNeedsInteractive ProbeOutcome = "needs-interactive"
)

// ClassifyProbeError maps an SSH probe error to a typed outcome, a
// human-readable detail string, and an error that is non-nil only when
// the error is unclassifiable (never collapsed into "rejected").
func ClassifyProbeError(err error) (outcome ProbeOutcome, detail string, classificationErr error) {
	if err == nil {
		return OutcomeAccepted, "ok", nil
	}

	// Host key issues — checked before auth.
	var unknownKey *ErrUnknownHostKey
	if errors.As(err, &unknownKey) {
		return OutcomeHostKeyProblem, unknownKey.Error(), nil
	}
	var keyMismatch *ErrHostKeyMismatch
	if errors.As(err, &keyMismatch) {
		return OutcomeHostKeyProblem, keyMismatch.Error(), nil
	}

	// Auth rejected (wrong password, bad key).
	var authErr *ErrAuthFailed
	if errors.As(err, &authErr) {
		return OutcomeRejected, authErr.Error(), nil
	}

	// Encrypted key — needs passphrase (interactive).
	var encKey *ErrEncryptedKey
	if errors.As(err, &encKey) {
		return OutcomeNeedsInteractive, encKey.Error(), nil
	}

	// Network reachability.
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return OutcomeUnreachable, netErr.Error(), nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return OutcomeUnreachable, err.Error(), nil
	}

	// Unclassifiable — return as error, never map to rejected.
	return "", "", err
}
