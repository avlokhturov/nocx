package rollout

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/ssh"
)

type Runner interface {
	Run(ctx context.Context, params RunParams) (*RunState, error)
}

type RunParams struct {
	CredentialID       string
	VersionID          string
	TargetIDs          []string
	CanaryIDs          []string
	BatchSize          int
	GlobalConcurrency  int
	BastionConcurrency int
}

type RunStatus string

const (
	RunStatusRunning   RunStatus = "running"
	RunStatusCompleted RunStatus = "completed"
	RunStatusCancelled RunStatus = "cancelled"
	RunStatusFailed    RunStatus = "failed"
)

type RunState struct {
	Status       RunStatus        `json:"status"`
	Probed       []EndpointResult `json:"probed,omitempty"`
	Excluded     []Exclusion      `json:"excluded,omitempty"`
	NotAttempted []NotAttempted   `json:"notAttempted,omitempty"`
	StartedAt    time.Time        `json:"startedAt"`
	CompletedAt  *time.Time       `json:"completedAt,omitempty"`
}

type EndpointResult struct {
	ProfileID string `json:"profileId"`
	Endpoint  string `json:"endpoint"`
	Bastion   string `json:"bastion,omitempty"`
	Username  string `json:"username"`
	// AuthPolicy is the auth mode the probe was performed under. It is part
	// of the probe-result identity key in spec §6, so it has to travel out of
	// the run: a result stored under the wrong policy is not found again by a
	// full-identity lookup, and the promotion threshold would measure nothing.
	AuthPolicy  string           `json:"authPolicy,omitempty"`
	Fingerprint string           `json:"fingerprint,omitempty"`
	Outcome     ssh.ProbeOutcome `json:"outcome"`
	Detail      string           `json:"detail,omitempty"`
	Timestamp   time.Time        `json:"timestamp"`
}

type Exclusion struct {
	ProfileID string `json:"profileId"`
	Endpoint  string `json:"endpoint"`
	Reason    string `json:"reason"`
	Detail    string `json:"detail,omitempty"`
}

type NotAttempted struct {
	ProfileID string `json:"profileId"`
	Endpoint  string `json:"endpoint"`
}

type Resolver interface {
	ResolveWithVersion(profileID, credentialID, versionID string) (host string, cfg *ssh.ConnectConfig, err error)
}
type Prober interface {
	ProbeWithResult(ctx context.Context, host string, cfg *ssh.ConnectConfig) (fingerprint string, err error)
}
type CredentialInfo interface {
	AuthMode(credentialID string) (string, error)
}

var (
	ErrCredentialNotFound = errors.New("credential not found")
	ErrVersionNotFound    = errors.New("credential version not found")
)

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

type runner struct {
	resolver     Resolver
	prober       Prober
	credInfo     CredentialInfo
	stateMu      sync.Mutex
	bastionsDead map[string]struct{}
}

func NewRunner(resolver Resolver, prober Prober, credInfo CredentialInfo) Runner {
	return &runner{
		resolver: resolver, prober: prober, credInfo: credInfo,
		bastionsDead: make(map[string]struct{}),
	}
}

func (r *runner) Run(ctx context.Context, params RunParams) (*RunState, error) {
	state := &RunState{Status: RunStatusRunning, StartedAt: time.Now()}
	didCancel := false
	defer func() {
		now := time.Now()
		state.CompletedAt = &now
		if state.Status == RunStatusRunning {
			if didCancel {
				state.Status = RunStatusCancelled
			} else {
				state.Status = RunStatusCompleted
			}
		}
	}()

	if params.BatchSize <= 0 {
		params.BatchSize = 10
	}
	if params.GlobalConcurrency <= 0 {
		params.GlobalConcurrency = 5
	}
	if params.BastionConcurrency <= 0 {
		params.BastionConcurrency = 3
	}

	// Step 1: pre-check credential for interactive auth
	mode, err := r.credInfo.AuthMode(params.CredentialID)
	if err != nil {
		state.Status = RunStatusFailed
		return state, fmt.Errorf("load credential %s: %w", params.CredentialID, err)
	}
	if mode == "keyboardInteractive" || mode == "keyboard-interactive" {
		for _, pid := range params.TargetIDs {
			state.Excluded = append(state.Excluded, Exclusion{
				ProfileID: pid, Reason: "needs-interactive",
				Detail: fmt.Sprintf("credential %s uses keyboard-interactive auth", params.CredentialID),
			})
		}
		state.Status = RunStatusCompleted
		return state, nil
	}

	// Step 2: resolve all targets
	targets, err := r.resolveTargets(ctx, params)
	if err != nil {
		state.Status = RunStatusFailed
		return state, err
	}
	if len(targets) == 0 {
		state.Status = RunStatusCompleted
		return state, nil
	}

	// Step 3: separate canary from remaining
	canarySet := make(map[string]bool, len(params.CanaryIDs))
	for _, id := range params.CanaryIDs {
		canarySet[id] = true
	}
	var canaries, rest []*target
	for _, t := range targets {
		if canarySet[t.profileID] {
			canaries = append(canaries, t)
		} else {
			rest = append(rest, t)
		}
	}

	// Step 4: build concurrency controller
	cc := newConcurrencyControl(params.GlobalConcurrency, params.BastionConcurrency)

	// Step 5: canary probes first
	for _, t := range canaries {
		if t.excluded {
			state.Excluded = append(state.Excluded, Exclusion{
				ProfileID: t.profileID, Endpoint: t.endpoint,
				Reason: t.excludeReason, Detail: t.excludeDetail,
			})
			continue
		}
		r.probeOne(ctx, cc, t, state)
	}
	if ctx.Err() != nil {
		didCancel = true
		return state, nil
	}
	if canaryAllFailed(state, canaries) && len(canaries) > 0 {
		for _, t := range rest {
			state.NotAttempted = append(state.NotAttempted, NotAttempted{ProfileID: t.profileID, Endpoint: t.endpoint})
		}
		return state, nil
	}

	// Step 6: batch probes
	for i := 0; i < len(rest); i += params.BatchSize {
		if ctx.Err() != nil {
			didCancel = true
			return state, nil
		}
		end := i + params.BatchSize
		if end > len(rest) {
			end = len(rest)
		}
		batch := rest[i:end]

		var wg sync.WaitGroup
		for _, t := range batch {
			if t.excluded {
				state.Excluded = append(state.Excluded, Exclusion{
					ProfileID: t.profileID, Endpoint: t.endpoint,
					Reason: t.excludeReason, Detail: t.excludeDetail,
				})
				continue
			}
			if ctx.Err() != nil {
				break
			}
			// Pre-flight bastion check
			if t.bastion != "" && r.bastionDead(t.bastion) {
				state.Excluded = append(state.Excluded, Exclusion{
					ProfileID: t.profileID, Endpoint: t.endpoint,
					Reason: "bastion-unreachable",
					Detail: fmt.Sprintf("bastion %s is unreachable", t.bastion),
				})
				continue
			}
			wg.Add(1)
			t := t
			go func() {
				defer wg.Done()
				r.probeOne(ctx, cc, t, state)
			}()
		}
		wg.Wait()
		if ctx.Err() != nil {
			didCancel = true
			return state, nil
		}
	}

	// Step 7: record never-attempted
	for _, t := range targets {
		if !t.probed && !t.excluded {
			state.NotAttempted = append(state.NotAttempted, NotAttempted{ProfileID: t.profileID, Endpoint: t.endpoint})
		}
	}
	return state, nil
}

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

type target struct {
	profileID     string
	endpoint      string
	bastion       string
	username      string
	cfg           *ssh.ConnectConfig
	excluded      bool
	excludeReason string
	excludeDetail string
	probed        bool
}

func (r *runner) resolveTargets(ctx context.Context, params RunParams) ([]*target, error) {
	seen := make(map[string]bool)
	var targets []*target

	for _, pid := range params.TargetIDs {
		if ctx.Err() != nil {
			break
		}
		host, cfg, err := r.resolver.ResolveWithVersion(pid, params.CredentialID, params.VersionID)
		if err != nil {
			if errors.Is(err, ErrVersionNotFound) {
				return nil, fmt.Errorf("profile %s: %w", pid, err)
			}
			targets = append(targets, &target{
				profileID: pid, excluded: true,
				excludeReason: "resolution-error", excludeDetail: err.Error(),
			})
			continue
		}
		port := cfg.Port
		if port <= 0 {
			port = 22
		}
		endpoint := net.JoinHostPort(host, strconv.Itoa(port))
		key := endpoint + ":" + cfg.User
		if seen[key] {
			continue
		}
		seen[key] = true

		bastion := ""
		if cfg.JumpHost != "" {
			jp := cfg.JumpPort
			if jp <= 0 {
				jp = 22
			}
			bastion = net.JoinHostPort(cfg.JumpHost, strconv.Itoa(jp))
		}
		targets = append(targets, &target{
			profileID: pid, endpoint: endpoint, bastion: bastion,
			username: cfg.User, cfg: cfg,
		})
	}
	return targets, nil
}

// ---------------------------------------------------------------------------
// probeOne
// ---------------------------------------------------------------------------

func (r *runner) probeOne(ctx context.Context, cc *concurrencyControl, t *target, state *RunState) {
	if err := cc.acquire(ctx, t.bastion); err != nil {
		return
	}
	defer cc.release(t.bastion)

	// Re-check bastion dead after acquiring slots: another in-flight probe
	// may have marked it dead while we were waiting for the semaphore.
	if t.bastion != "" && r.bastionDead(t.bastion) {
		r.stateMu.Lock()
		state.Excluded = append(state.Excluded, Exclusion{
			ProfileID: t.profileID, Endpoint: t.endpoint,
			Reason: "bastion-unreachable",
			Detail: fmt.Sprintf("bastion %s is unreachable", t.bastion),
		})
		t.probed = false
		r.stateMu.Unlock()
		return
	}

	fingerprint, err := r.prober.ProbeWithResult(ctx, t.endpoint, t.cfg)
	outcome, detail, classifyErr := ssh.ClassifyProbeError(err)
	if classifyErr != nil {
		detail = classifyErr.Error()
	}

	// Host-key problem: exclude, never count as credential probe.
	if outcome == ssh.OutcomeHostKeyProblem {
		r.stateMu.Lock()
		state.Excluded = append(state.Excluded, Exclusion{
			ProfileID: t.profileID, Endpoint: t.endpoint,
			Reason: "host-key-problem", Detail: detail,
		})
		t.probed = false
		r.stateMu.Unlock()
		return
	}

	// Bastion unreachable: mark dead so remaining targets are excluded.
	if outcome == ssh.OutcomeUnreachable && t.bastion != "" {
		r.stateMu.Lock()
		r.bastionsDead[t.bastion] = struct{}{}
		r.stateMu.Unlock()
		detail = fmt.Sprintf("bastion %s unreachable: %s", t.bastion, detail)
	}

	r.stateMu.Lock()
	authPolicy := t.cfg.AuthMode
	if authPolicy == "" {
		authPolicy = "auto"
	}
	state.Probed = append(state.Probed, EndpointResult{
		ProfileID: t.profileID, Endpoint: t.endpoint, Bastion: t.bastion,
		Username: t.username, Fingerprint: fingerprint, AuthPolicy: authPolicy,
		Outcome: outcome, Detail: detail, Timestamp: time.Now(),
	})
	t.probed = true
	r.stateMu.Unlock()
}

// bastionDead reports whether a bastion has been marked unreachable.
func (r *runner) bastionDead(bastion string) bool {
	r.stateMu.Lock()
	_, dead := r.bastionsDead[bastion]
	r.stateMu.Unlock()
	return dead
}

// ---------------------------------------------------------------------------
// concurrency control
// ---------------------------------------------------------------------------

type concurrencyControl struct {
	global       chan struct{}
	bastionSem   map[string]chan struct{}
	mu           sync.Mutex
	bastionLimit int
}

func newConcurrencyControl(globalLimit, bastionLimit int) *concurrencyControl {
	return &concurrencyControl{
		global:       make(chan struct{}, globalLimit),
		bastionSem:   make(map[string]chan struct{}),
		bastionLimit: bastionLimit,
	}
}

func (cc *concurrencyControl) acquire(ctx context.Context, bastion string) error {
	select {
	case cc.global <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	if bastion != "" {
		sem := cc.semaphoreFor(bastion)
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			<-cc.global
			return ctx.Err()
		}
	}
	return nil
}

func (cc *concurrencyControl) release(bastion string) {
	<-cc.global
	if bastion != "" {
		sem := cc.semaphoreFor(bastion)
		<-sem
	}
}

func (cc *concurrencyControl) semaphoreFor(bastion string) chan struct{} {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	sem, ok := cc.bastionSem[bastion]
	if !ok {
		sem = make(chan struct{}, cc.bastionLimit)
		cc.bastionSem[bastion] = sem
	}
	return sem
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func canaryAllFailed(state *RunState, canaryTargets []*target) bool {
	if len(canaryTargets) == 0 {
		return false
	}
	seen := make(map[string]bool, len(canaryTargets))
	for _, t := range canaryTargets {
		seen[t.profileID] = false
	}
	for _, r := range state.Probed {
		if _, ok := seen[r.ProfileID]; !ok {
			continue
		}
		if r.Outcome == ssh.OutcomeAccepted {
			return false
		}
		seen[r.ProfileID] = true
	}
	for _, e := range state.Excluded {
		if _, ok := seen[e.ProfileID]; ok {
			seen[e.ProfileID] = true
		}
	}
	for _, s := range seen {
		if !s {
			return false
		}
	}
	return true
}
