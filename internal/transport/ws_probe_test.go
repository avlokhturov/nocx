package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
)

// ---------------------------------------------------------------------------
// classifyProbeError unit tests
// ---------------------------------------------------------------------------

func TestClassifyProbeError_Nil(t *testing.T) {
	r := classifyProbeError(nil)
	if r.outcome != OutcomeAccepted {
		t.Errorf("expected accepted, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
	if r.detail == "" {
		t.Error("expected non-empty detail for accepted")
	}
}

func TestClassifyProbeError_ErrAuthFailed(t *testing.T) {
	inner := errors.New("ssh: unable to authenticate")
	authErr := &ssh.ErrAuthFailed{User: "alice", Host: "host.example.com", Err: inner}
	r := classifyProbeError(authErr)
	if r.outcome != OutcomeRejected {
		t.Errorf("expected rejected, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

func TestClassifyProbeError_ErrUnknownHostKey(t *testing.T) {
	hkErr := &ssh.ErrUnknownHostKey{Addr: "1.2.3.4:22", KeyAlgo: "ssh-ed25519", Fingerprint: "SHA256:abc"}
	r := classifyProbeError(hkErr)
	if r.outcome != OutcomeHostKeyProblem {
		t.Errorf("expected host-key-problem, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

func TestClassifyProbeError_ErrHostKeyMismatch(t *testing.T) {
	hkErr := &ssh.ErrHostKeyMismatch{Addr: "1.2.3.4:22", Fingerprint: "abc", Expected: "def"}
	r := classifyProbeError(hkErr)
	if r.outcome != OutcomeHostKeyProblem {
		t.Errorf("expected host-key-problem, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

func TestClassifyProbeError_ErrEncryptedKey(t *testing.T) {
	encErr := &ssh.ErrEncryptedKey{Path: "/home/user/.ssh/id_rsa"}
	r := classifyProbeError(encErr)
	if r.outcome != OutcomeNeedsInteractive {
		t.Errorf("expected needs-interactive, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

func TestClassifyProbeError_NetOpError(t *testing.T) {
	netErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	r := classifyProbeError(netErr)
	if r.outcome != OutcomeUnreachable {
		t.Errorf("expected unreachable, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

func TestClassifyProbeError_ContextDeadline(t *testing.T) {
	err := context.DeadlineExceeded
	r := classifyProbeError(err)
	if r.outcome != OutcomeUnreachable {
		t.Errorf("expected unreachable for deadline, got %s", r.outcome)
	}
}

func TestClassifyProbeError_ContextCancelled(t *testing.T) {
	err := context.Canceled
	r := classifyProbeError(err)
	if r.outcome != OutcomeUnreachable {
		t.Errorf("expected unreachable for cancel, got %s", r.outcome)
	}
}

func TestClassifyProbeError_Unclassifiable(t *testing.T) {
	err := errors.New("something unexpected")
	r := classifyProbeError(err)
	if r.outcome != "" {
		t.Errorf("expected empty outcome, got %s", r.outcome)
	}
	if r.err == nil {
		t.Error("expected non-nil err for unclassifiable")
	}
}

func TestClassifyProbeError_UnclassifiableWrappedAuth(t *testing.T) {
	// An ErrAuthFailed wrapped with %w must be recoverable via errors.As.
	inner := &ssh.ErrAuthFailed{User: "alice", Host: "host.example.com", Err: errors.New("bad auth")}
	wrapped := fmt.Errorf("probe config: %w", inner)
	r := classifyProbeError(wrapped)
	if r.outcome != OutcomeRejected {
		t.Errorf("expected rejected, got %s", r.outcome)
	}
	if r.err != nil {
		t.Errorf("expected nil err, got %v", r.err)
	}
}

// ---------------------------------------------------------------------------
// Fake prober and resolver for handler tests
// ---------------------------------------------------------------------------

// fakeProber implements Prober for tests.
type fakeProber struct {
	probeFn func(ctx context.Context, host string, cfg *ssh.ConnectConfig) error
}

func (f *fakeProber) Probe(ctx context.Context, host string, cfg *ssh.ConnectConfig) error {
	return f.probeFn(ctx, host, cfg)
}

// fakeResolver implements ProfileResolver for tests.
type fakeResolver struct {
	resolveFn func(profileID string) (host string, cfg *ssh.ConnectConfig, err error)
}

func (f *fakeResolver) Resolve(profileID string) (string, *ssh.ConnectConfig, error) {
	return f.resolveFn(profileID)
}

// ---------------------------------------------------------------------------
// Handler integration tests
// ---------------------------------------------------------------------------

func TestConnectionsTest_Accepted(t *testing.T) {
	srv := newProbeTestServer(t, nil, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Result connectionsTestResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Result.Outcome != OutcomeAccepted {
		t.Errorf("expected accepted, got %s", result.Result.Outcome)
	}
}

func TestConnectionsTest_Rejected(t *testing.T) {
	probeErr := &ssh.ErrAuthFailed{User: "test", Host: "host.example.com", Err: errors.New("bad password")}
	srv := newProbeTestServer(t, probeErr, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Result connectionsTestResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Result.Outcome != OutcomeRejected {
		t.Errorf("expected rejected, got %s", result.Result.Outcome)
	}
}

func TestConnectionsTest_Unreachable(t *testing.T) {
	probeErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	srv := newProbeTestServer(t, probeErr, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Result connectionsTestResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Result.Outcome != OutcomeUnreachable {
		t.Errorf("expected unreachable, got %s", result.Result.Outcome)
	}
}

func TestConnectionsTest_HostKeyProblem(t *testing.T) {
	probeErr := &ssh.ErrUnknownHostKey{Addr: "host.example.com:22", KeyAlgo: "ssh-ed25519", Fingerprint: "SHA256:abc"}
	srv := newProbeTestServer(t, probeErr, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Result connectionsTestResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Result.Outcome != OutcomeHostKeyProblem {
		t.Errorf("expected host-key-problem, got %s", result.Result.Outcome)
	}
}

func TestConnectionsTest_NeedsInteractive(t *testing.T) {
	probeErr := &ssh.ErrEncryptedKey{Path: "/home/user/.ssh/id_rsa"}
	srv := newProbeTestServer(t, probeErr, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Result connectionsTestResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Result.Outcome != OutcomeNeedsInteractive {
		t.Errorf("expected needs-interactive, got %s", result.Result.Outcome)
	}
}

func TestConnectionsTest_MissingProfileID(t *testing.T) {
	srv := newProbeTestServer(t, nil, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{})

	var result struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Error.Code != -32602 {
		t.Errorf("expected code -32602, got %d", result.Error.Code)
	}
}

func TestConnectionsTest_ResolveError(t *testing.T) {
	srv := newProbeTestServer(t, nil, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "", nil, errors.New("profile not found")
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:missing:1",
	})

	var result struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Error == nil {
		t.Fatal("expected error for missing profile")
	}
}

func TestConnectionsTest_NoProber(t *testing.T) {
	// A WSServer WITHOUT a prober wired should return an error.
	logger := log.NewSlogAdapter(nil)
	reg := newRegWithStub(logger)
	srv := NewWSServer(logger, reg, WithProfileResolver(&fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	}))
	ctx := context.Background()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = srv.Stop(ctx) }()

	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Error == nil {
		t.Fatal("expected error when no prober is wired")
	}
	if result.Error.Code != -32603 {
		t.Errorf("expected code -32603, got %d", result.Error.Code)
	}
}

func TestConnectionsTest_UnclassifiableError(t *testing.T) {
	unknownErr := errors.New("unexpected internal error")
	srv := newProbeTestServer(t, unknownErr, &fakeResolver{
		resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
			return "host.example.com", &ssh.ConnectConfig{User: "test"}, nil
		},
	})
	conn := connectWS(t, srv)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
		"profileId": "ssh:test:1",
	})

	var result struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Error == nil {
		t.Fatal("expected error for unclassifiable probe error")
	}
}

func TestConnectionsTest_ProbeResultJSON(t *testing.T) {
	// Verify the wire format matches the spec: outcome string, no extra fields.
	tests := []struct {
		err      error
		expected ProbeOutcome
	}{
		{nil, OutcomeAccepted},
		{&ssh.ErrAuthFailed{User: "u", Host: "h", Err: errors.New("bad auth")}, OutcomeRejected},
		{&ssh.ErrUnknownHostKey{Addr: "h:22", KeyAlgo: "k", Fingerprint: "f"}, OutcomeHostKeyProblem},
		{&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}, OutcomeUnreachable},
		{&ssh.ErrEncryptedKey{Path: "/key"}, OutcomeNeedsInteractive},
	}

	for _, tt := range tests {
		srv := newProbeTestServer(t, tt.err, &fakeResolver{
			resolveFn: func(profileID string) (string, *ssh.ConnectConfig, error) {
				return "h", &ssh.ConnectConfig{User: "u"}, nil
			},
		})
		conn := connectWS(t, srv)
		resp := jsonrpcCall(t, conn, "connections.test", map[string]any{
			"profileId": "ssh:test:1",
		})

		var envelope struct {
			Result json.RawMessage `json:"result,omitempty"`
			Error  *struct{}       `json:"error,omitempty"`
		}
		if err := json.Unmarshal(resp, &envelope); err != nil {
			_ = conn.Close()
			t.Fatalf("unmarshal envelope: %v", err)
		}

		if tt.err == nil {
			// Accepted goes via result, not error.
			var res connectionsTestResult
			if err := json.Unmarshal(envelope.Result, &res); err != nil {
				_ = conn.Close()
				t.Fatalf("unmarshal result: %v", err)
			}
			if res.Outcome != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, res.Outcome)
			}
		} else {
			// Error cases still produce results (typed outcomes), not errors.
			var res connectionsTestResult
			if err := json.Unmarshal(envelope.Result, &res); err != nil {
				_ = conn.Close()
				t.Fatalf("unmarshal result: %v", err)
			}
			if res.Outcome != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, res.Outcome)
			}
		}
		_ = conn.Close()
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func newProbeTestServer(t *testing.T, probeReturn error, resolver ProfileResolver) *WSServer {
	t.Helper()
	logger := log.NewSlogAdapter(nil)
	reg := newRegWithStub(logger)

	prober := &fakeProber{
		probeFn: func(_ context.Context, _ string, _ *ssh.ConnectConfig) error {
			return probeReturn
		},
	}

	srv := NewWSServer(
		logger, reg,
		WithProfileResolver(resolver),
		WithProber(prober),
	)
	ctx := context.Background()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop(ctx) })
	return srv
}
