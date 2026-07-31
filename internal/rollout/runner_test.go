package rollout

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/ssh"
)

type fakeResolver struct {
	mu       sync.Mutex
	configs  map[string]resolveResult
	requests []resolveRequest
}

type resolveResult struct {
	host string
	cfg  *ssh.ConnectConfig
	err  error
}

type resolveRequest struct {
	profileID    string
	credentialID string
	versionID    string
}

func (f *fakeResolver) ResolveWithVersion(profileID, credentialID, versionID string) (string, *ssh.ConnectConfig, error) {
	f.mu.Lock()
	f.requests = append(f.requests, resolveRequest{profileID, credentialID, versionID})
	r, ok := f.configs[profileID]
	f.mu.Unlock()
	if !ok {
		return "", nil, fmt.Errorf("profile %s not found", profileID)
	}
	return r.host, r.cfg, r.err
}

type fakeProber struct {
	mu        sync.Mutex
	calls     []probeCall
	outcomeFn func(endpoint string) (string, error)
}

type probeCall struct {
	host     string
	endpoint string
}

func (f *fakeProber) ProbeWithResult(ctx context.Context, host string, cfg *ssh.ConnectConfig) (string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, probeCall{host: cfg.User + "@" + host, endpoint: host})
	f.mu.Unlock()
	if f.outcomeFn != nil {
		return f.outcomeFn(host)
	}
	return "SHA256:test", nil
}

type countingProber struct {
	mu          sync.Mutex
	calls       []probeCall
	maxInFlight int64
	inFlight    int64
	delay       time.Duration
}

func (f *countingProber) ProbeWithResult(ctx context.Context, host string, cfg *ssh.ConnectConfig) (string, error) {
	inflight := atomic.AddInt64(&f.inFlight, 1)
	for {
		old := atomic.LoadInt64(&f.maxInFlight)
		if inflight <= old {
			break
		}
		if atomic.CompareAndSwapInt64(&f.maxInFlight, old, inflight) {
			break
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, probeCall{host: cfg.User + "@" + host, endpoint: host})
	f.mu.Unlock()
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
		}
	}
	atomic.AddInt64(&f.inFlight, -1)
	return "SHA256:fp", nil
}

type fakeCredentialInfo struct {
	mu        sync.Mutex
	authModes map[string]string
}

func (f *fakeCredentialInfo) AuthMode(credentialID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	mode, ok := f.authModes[credentialID]
	if !ok {
		return "", ErrCredentialNotFound
	}
	return mode, nil
}

func testConfig(host, user string) *ssh.ConnectConfig {
	return &ssh.ConnectConfig{User: user, Port: 22, CredentialVersionID: "v2"}
}

func testConfigWithBastion(host, user, bastionHost string, bastionPort int) *ssh.ConnectConfig {
	cfg := testConfig(host, user)
	cfg.JumpHost = bastionHost
	cfg.JumpPort = bastionPort
	return cfg
}

func defaultRunner(resolver Resolver, prober Prober, credInfo CredentialInfo) Runner {
	return NewRunner(resolver, prober, credInfo)
}

func TestOneAttemptPerEndpoint(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"p1": {"host1", testConfig("host1", "alice"), nil},
		"p2": {"host1", testConfig("host1", "alice"), nil},
		"p3": {"host2", testConfig("host2", "bob"), nil},
	}}
	p := &fakeProber{outcomeFn: func(string) (string, error) { return "SHA256:fp", nil }}
	ci := &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}
	state, err := defaultRunner(r, p, ci).Run(context.Background(),
		RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1", "p2", "p3"}, BatchSize: 10})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if state.Status != RunStatusCompleted {
		t.Fatalf("expected completed, got %s", state.Status)
	}
	if len(p.calls) != 2 || len(state.Probed) != 2 {
		t.Errorf("expected 2 probes (2 unique endpoints), got calls=%d probed=%d", len(p.calls), len(state.Probed))
	}
}

func TestTwoProfilesSameEndpointDedup(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"f-a": {"web", testConfig("web", "deploy"), nil},
		"f-b": {"web", testConfig("web", "deploy"), nil},
	}}
	p := &fakeProber{outcomeFn: func(string) (string, error) { return "SHA256:fp", nil }}
	ci := &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}
	state, err := defaultRunner(r, p, ci).Run(context.Background(),
		RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"f-a", "f-b"}})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(p.calls) != 1 || len(state.Probed) != 1 {
		t.Errorf("expected 1 probe for dedup, got calls=%d probed=%d", len(p.calls), len(state.Probed))
	}
}

func TestKeyboardInteractiveExcluded(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{"p1": {"h1", testConfig("h1", "alice"), nil}}}
	ci := &fakeCredentialInfo{authModes: map[string]string{"cred:1": "keyboardInteractive"}}
	state, err := defaultRunner(r, &fakeProber{}, ci).Run(context.Background(),
		RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1"}})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(state.Excluded) != 1 || state.Excluded[0].Reason != "needs-interactive" {
		t.Errorf("expected needs-interactive exclusion, got %+v", state.Excluded)
	}
}

func TestHostKeyUnknownExcludes(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{"p1": {"h1", testConfig("h1", "alice"), nil}}}
	p := &fakeProber{
		outcomeFn: func(ep string) (string, error) {
			return "", &ssh.ErrUnknownHostKey{Addr: ep, KeyAlgo: "ssh-ed25519", Fingerprint: "SHA256:x"}
		},
	}
	ci := &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}
	state, err := defaultRunner(r, p, ci).Run(context.Background(),
		RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1"}})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(state.Probed) != 0 {
		t.Errorf("expected 0 probed, got %d", len(state.Probed))
	}
	if len(state.Excluded) != 1 || state.Excluded[0].Reason != "host-key-unknown" {
		t.Errorf("expected host-key-unknown exclusion, got %+v", state.Excluded)
	}
}

func TestHostKeyChangedExcludes(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{"p1": {"h1", testConfig("h1", "alice"), nil}}}
	p := &fakeProber{
		outcomeFn: func(ep string) (string, error) {
			return "", &ssh.ErrHostKeyMismatch{Addr: ep, Fingerprint: "SHA256:new", Expected: "SHA256:old"}
		},
	}
	ci := &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}
	state, err := defaultRunner(r, p, ci).Run(context.Background(),
		RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1"}})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(state.Probed) != 0 {
		t.Errorf("expected 0 probed, got %d", len(state.Probed))
	}
	if len(state.Excluded) != 1 || state.Excluded[0].Reason != "host-key-changed" {
		t.Errorf("expected host-key-changed exclusion, got %+v", state.Excluded)
	}
}

func TestMissingCandidateVersionAborts(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{"p1": {"", nil, ErrVersionNotFound}}}
	state, err := defaultRunner(r, &fakeProber{}, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1"}},
	)
	if err == nil || !errors.Is(err, ErrVersionNotFound) || state.Status != RunStatusFailed {
		t.Fatalf("expected ErrVersionNotFound + failed, got err=%v status=%s", err, state.Status)
	}
}

func TestCancelMidRollout(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"p1": {"h1", testConfig("h1", "u"), nil},
		"p2": {"h2", testConfig("h2", "u"), nil},
		"p3": {"h3", testConfig("h3", "u"), nil},
		"p4": {"h4", testConfig("h4", "u"), nil},
		"p5": {"h5", testConfig("h5", "u"), nil},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	var once sync.Once
	p := &fakeProber{
		outcomeFn: func(string) (string, error) {
			once.Do(cancel)
			<-ctx.Done()
			return "", ctx.Err()
		},
	}
	state, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(ctx,
		RunParams{
			CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"p1", "p2", "p3", "p4", "p5"},
			BatchSize: 10, GlobalConcurrency: 2,
		})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if state.Status != RunStatusCancelled || len(state.Probed) == 0 {
		t.Fatalf("expected cancelled + some probed, got status=%s probed=%d", state.Status, len(state.Probed))
	}
}

func TestCanaryProbedFirst(t *testing.T) {
	var mu sync.Mutex
	var order []string
	p := &fakeProber{
		outcomeFn: func(ep string) (string, error) {
			mu.Lock()
			order = append(order, ep)
			mu.Unlock()
			return "SHA256:fp", nil
		},
	}
	r := &fakeResolver{configs: map[string]resolveResult{
		"c": {"canary", testConfig("canary", "u"), nil},
		"t": {"target", testConfig("target", "u"), nil},
	}}
	_, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"c", "t"}, CanaryIDs: []string{"c"}},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	mu.Lock()
	got := append([]string{}, order...)
	mu.Unlock()
	if len(got) < 2 || got[0] != "canary:22" {
		t.Fatalf("expected canary first, got %v", got)
	}
}

func TestCanaryFailStopsRun(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"c1": {"c1", testConfig("c1", "u"), nil},
		"t1": {"t1", testConfig("t1", "u"), nil},
		"t2": {"t2", testConfig("t2", "u"), nil},
	}}
	p := &fakeProber{
		outcomeFn: func(ep string) (string, error) {
			return "", &ssh.ErrAuthFailed{User: "u", Host: ep, Err: errors.New("wrong")}
		},
	}
	state, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{CredentialID: "cred:1", VersionID: "v2", TargetIDs: []string{"c1", "t1", "t2"}, CanaryIDs: []string{"c1"}},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(state.Probed) != 1 || len(state.NotAttempted) != 2 {
		t.Fatalf("expected 1 probed + 2 not-attempted, got probed=%d na=%d", len(state.Probed), len(state.NotAttempted))
	}
}

func TestConcurrencyLimits(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"p1": {"h1", testConfigWithBastion("h1", "u", "j1", 22), nil},
		"p2": {"h2", testConfigWithBastion("h2", "u", "j1", 22), nil},
		"p3": {"h3", testConfigWithBastion("h3", "u", "j1", 22), nil},
		"p4": {"h4", testConfigWithBastion("h4", "u", "j2", 22), nil},
		"p5": {"h5", testConfigWithBastion("h5", "u", "j2", 22), nil},
	}}
	p := &countingProber{delay: 50 * time.Millisecond}
	state, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{
			CredentialID: "cred:1", VersionID: "v2",
			TargetIDs: []string{"p1", "p2", "p3", "p4", "p5"},
			BatchSize: 10, GlobalConcurrency: 3, BastionConcurrency: 2,
		},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if max := atomic.LoadInt64(&p.maxInFlight); max > 3 {
		t.Errorf("global limit 3 violated: max in-flight %d", max)
	}
	if len(state.Probed) != 5 {
		t.Errorf("expected 5 probed, got %d", len(state.Probed))
	}
}

func TestGlobalConcurrencyLimitDirect(t *testing.T) {
	configs := make(map[string]resolveResult)
	ids := make([]string, 8)
	for i := range 8 {
		h := fmt.Sprintf("h%d", i)
		pid := fmt.Sprintf("p%d", i)
		ids[i] = pid
		configs[pid] = resolveResult{h, testConfig(h, "u"), nil}
	}
	r := &fakeResolver{configs: configs}
	p := &countingProber{delay: 30 * time.Millisecond}
	state, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{
			CredentialID: "cred:1", VersionID: "v2",
			TargetIDs: ids, BatchSize: 8, GlobalConcurrency: 3, BastionConcurrency: 5,
		},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if max := atomic.LoadInt64(&p.maxInFlight); max > 3 {
		t.Errorf("global limit 3 violated: max in-flight %d", max)
	}
	if len(state.Probed) != 8 {
		t.Errorf("expected 8 probed, got %d", len(state.Probed))
	}
}

func TestBastionDeadExcludesRemaining(t *testing.T) {
	r := &fakeResolver{configs: map[string]resolveResult{
		"p1": {"h1", testConfigWithBastion("h1", "u", "dead-jump", 22), nil},
		"p2": {"h2", testConfigWithBastion("h2", "u", "dead-jump", 22), nil},
		"p3": {"h3", testConfigWithBastion("h3", "u", "dead-jump", 22), nil},
	}}
	p := &fakeProber{
		outcomeFn: func(string) (string, error) {
			return "", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}
		},
	}
	state, err := defaultRunner(r, p, &fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{
			CredentialID: "cred:1", VersionID: "v2",
			TargetIDs: []string{"p1", "p2", "p3"},
			BatchSize: 10, GlobalConcurrency: 5, BastionConcurrency: 1,
		},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	// With BastionConcurrency=1, only p1 probes (fails unreachable). Bastion is
	// marked dead; p2 and p3 are excluded without probing.
	if len(state.Probed) != 1 {
		t.Errorf("expected 1 probed (first target through dead bastion), got %d", len(state.Probed))
	}
	if len(state.Excluded) < 1 {
		t.Errorf("expected >=1 exclusion for remaining targets, got %d", len(state.Excluded))
	}
}

func TestEmptyTargets(t *testing.T) {
	state, err := defaultRunner(&fakeResolver{}, &fakeProber{},
		&fakeCredentialInfo{authModes: map[string]string{"cred:1": "password"}}).Run(
		context.Background(), RunParams{CredentialID: "cred:1", VersionID: "v2"},
	)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if state.Status != RunStatusCompleted {
		t.Fatalf("expected completed, got %s", state.Status)
	}
}

func TestCredentialNotFound(t *testing.T) {
	_, err := defaultRunner(&fakeResolver{}, &fakeProber{},
		&fakeCredentialInfo{authModes: map[string]string{}}).Run(
		context.Background(), RunParams{CredentialID: "cred:x", VersionID: "v2", TargetIDs: []string{"p1"}},
	)
	if err == nil || !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("expected ErrCredentialNotFound, got %v", err)
	}
}
