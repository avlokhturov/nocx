package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"time"

	"github.com/shady2k/nocx/internal/ssh"
)

// ---------------------------------------------------------------------------
// ProbeOutcome — closed-enum wire contract (nocx-uxs5.3)
// ---------------------------------------------------------------------------

// ProbeOutcome is a closed-enum outcome for a single-profile credential
// probe. The Go type holds only the five defined values; a sixth kind
// cannot be expressed at compile time. Wave 8 builds rotation on these
// string constants.
type ProbeOutcome string

const (
	OutcomeAccepted         ProbeOutcome = "accepted"
	OutcomeRejected         ProbeOutcome = "rejected"
	OutcomeUnreachable      ProbeOutcome = "unreachable"
	OutcomeHostKeyProblem   ProbeOutcome = "host-key-problem"
	OutcomeNeedsInteractive ProbeOutcome = "needs-interactive"
)

// ---------------------------------------------------------------------------
// Prober — narrow interface for credential validation
// ---------------------------------------------------------------------------

// Prober performs a forced-fresh credential probe for a resolved profile.
//
// host is the dial-target hostname from the resolver; cfg is the resolved
// ConnectConfig — the probe must use exactly the parameters Connect would
// (same user, port, timeout, secret references, authorized endpoint).
//
// The single implementation wraps ssh.RealClient.ProbeConfig.
// Defined here (consumer package) per the repo's DI convention.
type Prober interface {
	// Probe validates credentials without recording the observed
	// host-key fingerprint. Prefer ProbeWithResult when the caller
	// needs the fingerprint for storage or identity matching.
	Probe(ctx context.Context, host string, cfg *ssh.ConnectConfig) error

	// ProbeWithResult is identical to Probe but also returns the
	// host-key fingerprint observed during the SSH handshake.
	// The fingerprint is empty when the handshake fails before host
	// key verification (e.g. unreachable host).
	ProbeWithResult(ctx context.Context, host string, cfg *ssh.ConnectConfig) (fingerprint string, err error)
}

// WithProber attaches a Prober for the connections.test JSON-RPC method.
// When not wired, the handler returns a JSON-RPC error — the probe handler
// does not create clients itself.
func WithProber(p Prober) WSServerOption {
	return func(s *WSServer) { s.prober = p }
}

// ---------------------------------------------------------------------------
// connections.test — JSON-RPC types
// ---------------------------------------------------------------------------

// connectionsTestParams is the payload of the "connections.test" RPC call.
type connectionsTestParams struct {
	ProfileID string `json:"profileId"`
}

// connectionsTestResult carries the typed probe outcome and a human-readable
// detail string suitable for the UI to surface.
type connectionsTestResult struct {
	Outcome ProbeOutcome `json:"outcome"`
	Detail  string       `json:"detail,omitempty"`
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// handleConnectionsTest probes one saved profile and returns a typed outcome.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"connections.test","params":{"profileId":"ssh:p1:1"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"outcome":"accepted"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"outcome":"rejected","detail":"authentication failed for user@host"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"outcome":"unreachable","detail":"dial tcp host:22: connect: connection refused"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"outcome":"host-key-problem","detail":"unknown host key"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"outcome":"needs-interactive","detail":"private key requires passphrase"}}
func (s *WSServer) handleConnectionsTest(wconn *wsConn, req jsonrpcRequest) {
	var params connectionsTestParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if params.ProfileID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: profileId required"))
		return
	}
	if !s.resolverOK {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Probing not available (no profile resolver wired)"))
		return
	}
	if s.prober == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Probing not available (no prober wired)"))
		return
	}

	host, connectCfg, err := s.resolver.Resolve(params.ProfileID)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Resolve failed: "+err.Error()))
		return
	}

	// Probe uses the same resolved parameters Connect would.
	fingerprint, err := s.prober.ProbeWithResult(context.Background(), host, connectCfg)
	result := classifyProbeError(err)

	// Record the probe result in the store for operational evidence.
	// All classified outcomes (accepted, rejected, unreachable, host-key
	// problem, needs-interactive) are stored; unclassifiable errors skip
	// the store because they represent a probe bug, not a valid outcome.
	if result.err == nil && s.probeResultStore != nil {
		s.storeProbeResult(host, connectCfg, fingerprint, result.outcome, result.detail)
	}

	if result.err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, result.err.Error()))
		return
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(connectionsTestResult{
		Outcome: result.outcome,
		Detail:  result.detail,
	})))
}

// storeProbeResult builds a ProbeResultRecord from the probe output and
// stores it. All classified outcomes are recorded.
func (s *WSServer) storeProbeResult(host string, cfg *ssh.ConnectConfig, fingerprint string, outcome ProbeOutcome, detail string) {
	port := 22
	if cfg.Port > 0 {
		port = cfg.Port
	}
	endpoint := net.JoinHostPort(host, strconv.Itoa(port))

	authPolicy := cfg.AuthMode
	if authPolicy == "" {
		authPolicy = "auto"
	}

	s.probeResultStore.Store(ProbeResultRecord{
		Identity: ProbeResultIdentity{
			Endpoint:           endpoint,
			HostKeyFingerprint: fingerprint,
			CredentialVersion:  cfg.CredentialVersionID,
			Username:           cfg.User,
			AuthPolicy:         authPolicy,
			Timestamp:          time.Now(),
		},
		Outcome: outcome,
		Detail:  detail,
	})
}

// probeResult is the internal classified outcome.
type probeResult struct {
	outcome ProbeOutcome
	detail  string
	err     error // non-nil only for unclassifiable errors → RPC error
}

// classifyProbeError maps an SSH probe error to a typed outcome.
// Unclassifiable errors are returned as a wrapped error for the RPC
// error path — they are never collapsed into "rejected".
func classifyProbeError(err error) probeResult {
	if err == nil {
		return probeResult{outcome: OutcomeAccepted, detail: "ok"}
	}

	// Host key issues — checked before auth.
	var unknownKey *ssh.ErrUnknownHostKey
	if errors.As(err, &unknownKey) {
		return probeResult{
			outcome: OutcomeHostKeyProblem,
			detail:  unknownKey.Error(),
		}
	}
	var keyMismatch *ssh.ErrHostKeyMismatch
	if errors.As(err, &keyMismatch) {
		return probeResult{
			outcome: OutcomeHostKeyProblem,
			detail:  keyMismatch.Error(),
		}
	}

	// Auth rejected (wrong password, bad key).
	var authErr *ssh.ErrAuthFailed
	if errors.As(err, &authErr) {
		return probeResult{
			outcome: OutcomeRejected,
			detail:  authErr.Error(),
		}
	}

	// Encrypted key — needs passphrase (interactive).
	var encKey *ssh.ErrEncryptedKey
	if errors.As(err, &encKey) {
		return probeResult{
			outcome: OutcomeNeedsInteractive,
			detail:  encKey.Error(),
		}
	}

	// Network reachability.
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return probeResult{
			outcome: OutcomeUnreachable,
			detail:  netErr.Error(),
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return probeResult{
			outcome: OutcomeUnreachable,
			detail:  err.Error(),
		}
	}

	// Unclassifiable — return as RPC error, never map to rejected.
	return probeResult{err: err}
}
