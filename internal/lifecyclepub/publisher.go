// Package lifecyclepub is the publication boundary of the authenticated
// lifecycle protocol (ADR-0024 decision 7; docs/lifecycle-protocol.md §3,
// "two outbound paths, one boundary").
//
// Authentication terminates in the backend: the kernel (internal/lifecycle)
// validates version, epoch, capability, sequence and transition, and the
// adapters (internal/lifecyclechannel) own the transports. What crosses the
// control plane is neither frames nor secrets — it is this package's Fact,
// a schema-checked projection of the kernel's read model
// (contracts/lifecycle.changed.schema.json), carrying at least lane, domain,
// epoch, the lifecycle state, the active attempt if any, and an attempt's
// completion when one completes. No capability and no raw frame ever leaves
// the backend; the wire test in internal/transport asserts that against the
// actual serialized payload.
//
// The Publisher wraps the kernel and implements the same Kernel-shaped
// interface the adapters consume, so the composition root injects the
// publisher where it would have injected the kernel and every mutation an
// adapter drives is also projected into a fact. Facts are emitted only when
// the lane's projection changes (a reconnect hello that changes nothing is
// not a notification), and only after the mutation succeeded — a rejected
// frame mutates nothing and publishes nothing, except that a desync-budget
// revocation that happens while rejecting a quarantined frame is itself a
// state change and is published.
//
// The publisher is deliberately free of transport and WebSocket knowledge:
// it hands the fact to an Emitter (the WSServer at the composition root),
// which routes it to the lane's session's current subscriber.
package lifecyclepub

import (
	"encoding/hex"
	"reflect"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/lifecycle"
)

// Fact is the published lifecycle fact: the params of the lifecycle.changed
// JSON-RPC notification (contracts/lifecycle.changed.schema.json). It is what
// the kernel concluded — never the capability, never a raw frame, never the
// channel's sequence counter. A lane in native or lost has no live domain, so
// Domain and Epoch are absent there.
type Fact struct {
	Lane      string   `json:"lane"`
	Lifecycle string   `json:"lifecycle"`
	Domain    string   `json:"domain,omitempty"`
	Epoch     uint64   `json:"epoch,omitempty"`
	Attempt   *Attempt `json:"attempt,omitempty"`
}

// Attempt is the projection of one ExecutionAttempt. Completion fields
// (ExitCode, CompletedAt, Fence) are present exactly when State is completed:
// the kernel sets an exit status exactly once, only from an authenticated
// completion.
type Attempt struct {
	ID          string     `json:"id"`
	State       string     `json:"state"`
	Command     string     `json:"command,omitempty"`
	Origin      string     `json:"origin,omitempty"`
	StartedAt   time.Time  `json:"startedAt,omitempty"`
	ExitCode    *int       `json:"exitCode,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	Fence       string     `json:"fence,omitempty"`
}

// Wire names of the lifecycle axis and attempt states. The renderer keys its
// two-axis state machine on these exact strings (ADR-0024 decision 6).
const (
	LifecycleNative         = "native"
	LifecyclePromptReady    = "prompt_ready"
	LifecycleRunning        = "running"
	LifecycleDesynchronized = "desynchronized"
	LifecycleLost           = "lost"

	AttemptOpen      = "open"
	AttemptCompleted = "completed"
	AttemptUnknown   = "unknown"

	OriginApp   = "app"
	OriginShell = "shell"
)

// derive projects the kernel's read model for one lane into a Fact. ok is
// false when the lane does not exist — nothing to publish. The read model is
// the kernel's snapshot after the mutation that triggered the call; the
// derive runs in the caller's goroutine immediately after the mutation, and
// per lane there is exactly one pump goroutine driving it today (the
// lifecyclechannel adapter), so the projection cannot be overtaken by the
// next transition before it is read.
func (p *Publisher) derive(lane lifecycle.LaneID) (Fact, bool) {
	st, err := p.kernel.State(lane)
	if err != nil {
		return Fact{}, false
	}
	f := Fact{
		Lane:      string(st.Lane),
		Lifecycle: lifecycleString(st.Lifecycle),
	}
	if st.Domain != "" {
		f.Domain = string(st.Domain)
		if d, ok := p.kernel.Domain(st.Domain); ok {
			f.Epoch = d.Epoch
		}
	}
	if st.Attempt != "" {
		if att, ok := p.kernel.Attempt(st.Attempt); ok {
			f.Attempt = attemptFact(att)
		}
	}
	return f, true
}

func attemptFact(att lifecycle.ExecutionAttempt) *Attempt {
	a := &Attempt{
		ID:        string(att.ID),
		State:     attemptStateString(att.State),
		Command:   att.Command,
		Origin:    originString(att.Origin),
		StartedAt: att.StartedAt,
	}
	if att.ExitCode != nil {
		a.ExitCode = att.ExitCode
	}
	if att.CompletedAt != nil {
		a.CompletedAt = att.CompletedAt
	}
	if att.Fence != (lifecycle.FenceNonce{}) {
		a.Fence = hex.EncodeToString(att.Fence[:])
	}
	return a
}

func lifecycleString(s lifecycle.LifecycleState) string {
	switch s {
	case lifecycle.LifecycleNative:
		return LifecycleNative
	case lifecycle.LifecyclePromptReady:
		return LifecyclePromptReady
	case lifecycle.LifecycleRunning:
		return LifecycleRunning
	case lifecycle.LifecycleDesynchronized:
		return LifecycleDesynchronized
	case lifecycle.LifecycleLost:
		return LifecycleLost
	default:
		return ""
	}
}

func attemptStateString(s lifecycle.AttemptState) string {
	switch s {
	case lifecycle.AttemptOpen:
		return AttemptOpen
	case lifecycle.AttemptCompleted:
		return AttemptCompleted
	case lifecycle.AttemptUnknown:
		return AttemptUnknown
	default:
		return ""
	}
}

func originString(o lifecycle.AttemptOrigin) string {
	switch o {
	case lifecycle.OriginApp:
		return OriginApp
	case lifecycle.OriginShell:
		return OriginShell
	default:
		return ""
	}
}

// Kernel is the slice of the lifecycle kernel the publisher forwards to. The
// concrete *lifecycle.Kernel satisfies it; the seam exists so the publisher
// is testable and the composition root decides the kernel. It is a superset
// of the lifecyclechannel.Kernel interface (which is what the adapters
// consume), so *Publisher can be injected where an adapter expects its
// kernel.
type Kernel interface {
	BindTransport(t lifecycle.TransportID, port lifecycle.Port) error
	RequestDomain(lane lifecycle.LaneID, parent *lifecycle.DomainID, t lifecycle.TransportID) (lifecycle.DomainHandle, error)
	Ingest(t lifecycle.TransportID, env lifecycle.Envelope) error
	NotifyGap(t lifecycle.TransportID, d lifecycle.DomainID, garbageBytes, garbageFrames int) error
	TransportLost(t lifecycle.TransportID) error
	SubmitAttempt(domain lifecycle.DomainID, command, cwd, host string) (lifecycle.ExecutionAttempt, error)
	AbandonAttempt(id lifecycle.AttemptID) error
	State(lane lifecycle.LaneID) (lifecycle.LaneSnapshot, error)
	Domain(id lifecycle.DomainID) (lifecycle.Domain, bool)
	Attempt(id lifecycle.AttemptID) (lifecycle.ExecutionAttempt, bool)
	OpenAttempt(domain lifecycle.DomainID) (lifecycle.ExecutionAttempt, bool)
}

// Emitter is where published facts go: the WSServer at the composition root,
// which routes them to the lane's session's current subscriber. The emitter
// is bound post-construction (SetEmitter) because it is the transport, which
// is built after the kernel; facts cannot exist before a session spawns a
// shell, which is long after both exist, so the unbound window is empty in
// practice.
type Emitter interface {
	PublishLifecycle(f Fact)
}

// Publisher wraps the kernel, forwards every mutation, and projects the
// affected lane into a Fact on each change. It is safe for concurrent use:
// per-lane serialization comes from the kernel (and from the single adapter
// pump per lane); the publisher's own lock protects its bookkeeping.
type Publisher struct {
	kernel Kernel

	mu      sync.Mutex
	emitter Emitter
	last    map[lifecycle.LaneID]Fact
	known   map[lifecycle.LaneID]struct{}
}

// New builds a Publisher over the kernel. The emitter is bound separately
// with SetEmitter.
func New(k Kernel) *Publisher {
	return &Publisher{
		kernel: k,
		last:   make(map[lifecycle.LaneID]Fact),
		known:  make(map[lifecycle.LaneID]struct{}),
	}
}

// SetEmitter binds the emitter. Calling it twice replaces the emitter; a nil
// emitter drops facts until one is bound (the startup window, which is empty
// in practice).
func (p *Publisher) SetEmitter(e Emitter) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.emitter = e
}

// BindTransport forwards to the kernel. Binding a transport creates no lane
// and changes no lifecycle, so nothing is published.
func (p *Publisher) BindTransport(t lifecycle.TransportID, port lifecycle.Port) error {
	return p.kernel.BindTransport(t, port)
}

// RequestDomain forwards to the kernel and records the lane so a later
// TransportLost can find every lane it may have affected. Minting a Pending
// domain changes no lifecycle, so nothing is published; the frontend keys
// enhanced mode on the published prompt_ready fact, which is what the
// handshake produces (decision 3).
func (p *Publisher) RequestDomain(lane lifecycle.LaneID, parent *lifecycle.DomainID, t lifecycle.TransportID) (lifecycle.DomainHandle, error) {
	h, err := p.kernel.RequestDomain(lane, parent, t)
	if err != nil {
		return h, err
	}
	p.mu.Lock()
	p.known[lane] = struct{}{}
	p.mu.Unlock()
	// Seed the dedupe baseline with the lane's current projection instead of
	// announcing it: a fresh lane is native, and telling the renderer
	// "native" about a lane it has never heard of would be noise. The seed
	// is also what keeps TransportLost from announcing every unrelated lane
	// that merely exists on another transport — only lanes whose projection
	// actually changed emit a fact.
	if f, ok := p.derive(lane); ok {
		p.mu.Lock()
		p.last[lane] = f
		p.mu.Unlock()
	}
	return h, nil
}

// Ingest forwards one authenticated envelope and publishes the lane's
// projection. Published on failure as well as success: the one mutation a
// kernel (the domain is closed and the lane falls to native while the frame
// is being quarantined), and that is a state change the renderer must see.
// Every other rejection leaves the projection unchanged and the change-dedupe
// suppresses the emission.
func (p *Publisher) Ingest(t lifecycle.TransportID, env lifecycle.Envelope) error {
	err := p.kernel.Ingest(t, env)
	p.publishLane(env.Lane)
	return err
}

// Domain returns the read model of one domain, forwarding to the kernel. The
// lifecyclechannel adapter's Kernel interface requires it — the adapter
// answers its handshake timeout by asking whether the domain it minted ever
// became Established.
func (p *Publisher) Domain(id lifecycle.DomainID) (lifecycle.Domain, bool) {
	return p.kernel.Domain(id)
}

// State returns the read model of one lane. Projection consumers (a future
// lifecycle.status RPC, the reconnect replay) read current state through the
// publisher, never through a singleton.
func (p *Publisher) State(lane lifecycle.LaneID) (lifecycle.LaneSnapshot, error) {
	return p.kernel.State(lane)
}

// Attempt returns a copy of the attempt, if it exists.
func (p *Publisher) Attempt(id lifecycle.AttemptID) (lifecycle.ExecutionAttempt, bool) {
	return p.kernel.Attempt(id)
}

// OpenAttempt returns the single open attempt of a domain, if any.
func (p *Publisher) OpenAttempt(domain lifecycle.DomainID) (lifecycle.ExecutionAttempt, bool) {
	return p.kernel.OpenAttempt(domain)
}

// NotifyGap forwards a framing-gap report and publishes the domain's lane:
// the domain enters Desynchronized (or a desync budget exhausts and it is
// revoked, which is also a published change).
func (p *Publisher) NotifyGap(t lifecycle.TransportID, d lifecycle.DomainID, garbageBytes, garbageFrames int) error {
	lane := ""
	if dom, ok := p.kernel.Domain(d); ok {
		lane = string(dom.Lane)
	}
	err := p.kernel.NotifyGap(t, d, garbageBytes, garbageFrames)
	if lane != "" {
		p.publishLane(lifecycle.LaneID(lane))
	}
	return err
}

// TransportLost forwards the loss and publishes every lane the publisher has
// seen: every domain bound to the transport (and its descendants) falls to
// Lost, and each affected lane publishes a lost fact. Unaffected lanes derive
// unchanged and the dedupe suppresses them.
func (p *Publisher) TransportLost(t lifecycle.TransportID) error {
	err := p.kernel.TransportLost(t)
	if err != nil {
		return err
	}
	p.mu.Lock()
	lanes := make([]lifecycle.LaneID, 0, len(p.known))
	for l := range p.known {
		lanes = append(lanes, l)
	}
	p.mu.Unlock()
	for _, l := range lanes {
		p.publishLane(l)
	}
	return nil
}

// SubmitAttempt forwards an app-originated attempt (created synchronously at
// editor submit, before the pty bytes) and publishes the lane's move to
// running.
func (p *Publisher) SubmitAttempt(domain lifecycle.DomainID, command, cwd, host string) (lifecycle.ExecutionAttempt, error) {
	att, err := p.kernel.SubmitAttempt(domain, command, cwd, host)
	if err != nil {
		return att, err
	}
	p.publishLane(att.Lane)
	return att, nil
}

// AbandonAttempt forwards the explicit abandonment (native-mode escape) and
// publishes the attempt's lane: the attempt's state becomes unknown, which is
// a projection change even though the lane stays running.
func (p *Publisher) AbandonAttempt(id lifecycle.AttemptID) error {
	err := p.kernel.AbandonAttempt(id)
	if err != nil {
		return err
	}
	if att, ok := p.kernel.Attempt(id); ok {
		p.publishLane(att.Lane)
	}
	return nil
}

// ReplayLane re-emits the lane's current projection unconditionally —
// bypassing the change-dedupe, which is exactly the point: a reattached
// frontend (AD-9 reconnect, protocol §12) must receive the current state
// even if no transition happened since its last view. The emission also
// refreshes the dedupe baseline, so a replay cannot suppress a later real
// change.
func (p *Publisher) ReplayLane(lane lifecycle.LaneID) {
	f, ok := p.derive(lane)
	if !ok {
		return
	}
	p.mu.Lock()
	p.last[lane] = f
	e := p.emitter
	p.mu.Unlock()
	if e != nil {
		e.PublishLifecycle(f)
	}
}

// publishLane derives the lane's fact and emits it when it changed since the
// last emission for that lane. Derivation runs in the caller's goroutine,
// immediately after the mutation that triggered it; the emitter call happens
// outside the publisher's lock so a slow WebSocket write cannot stall another
// lane's bookkeeping.
func (p *Publisher) publishLane(lane lifecycle.LaneID) {
	f, ok := p.derive(lane)
	if !ok {
		return
	}
	p.mu.Lock()
	if last, seen := p.last[lane]; seen && reflect.DeepEqual(last, f) {
		p.mu.Unlock()
		return
	}
	p.last[lane] = f
	e := p.emitter
	p.mu.Unlock()
	if e != nil {
		e.PublishLifecycle(f)
	}
}
