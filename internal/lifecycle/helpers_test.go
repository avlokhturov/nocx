package lifecycle

import (
	"reflect"
	"sync"
	"testing"
	"time"
)

// fakeClock is an injectable, deterministic clock.
type fakeClock struct {
	t time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time { return c.t }

func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// seqRand yields 1, 2, 3, … (wrapping to 1 after 255) — never a zero byte, so
// capabilities minted from it are never all-zero, and every domain gets a
// distinct capability.
type seqRand struct{ b byte }

func (r *seqRand) Read(p []byte) (int, error) {
	for i := range p {
		r.b++
		if r.b == 0 {
			r.b = 1
		}
		p[i] = r.b
	}
	return len(p), nil
}

// fakePort records every envelope the kernel sends. It is the transport seam
// in the model tests: no I/O, no goroutines, nothing but recorded sends.
type fakePort struct {
	mu   sync.Mutex
	sent []Envelope
}

func (p *fakePort) Send(env Envelope) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = append(p.sent, env)
	return nil
}

func (p *fakePort) envelopes() []Envelope {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Envelope(nil), p.sent...)
}

func (p *fakePort) kinds() []EventKind {
	envs := p.envelopes()
	out := make([]EventKind, 0, len(envs))
	for _, e := range envs {
		out = append(out, e.Event.Kind)
	}
	return out
}

func (p *fakePort) reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = nil
}

func newTestKernel(opts ...Options) (*Kernel, *fakeClock, *seqRand) {
	clock := newFakeClock()
	r := &seqRand{}
	o := Options{Now: clock.now, Rand: r}
	if len(opts) > 0 {
		o.Budgets = opts[0].Budgets
	}
	return New(o), clock, r
}

// env builds an authenticated envelope for a domain handle.
func env(lane LaneID, h DomainHandle, seq uint64, evt Event) Envelope {
	return Envelope{
		Version: ProtocolVersion, Lane: lane, Domain: h.Domain,
		Epoch: h.Epoch, Sequence: seq, Capability: h.Capability, Event: evt,
	}
}

// envRaw builds an envelope with explicit addressing, for auth-layer tests.
func envRaw(lane LaneID, dom DomainID, epoch uint64, cap Capability, seq uint64, evt Event) Envelope {
	return Envelope{
		Version: ProtocolVersion, Lane: lane, Domain: dom,
		Epoch: epoch, Sequence: seq, Capability: cap, Event: evt,
	}
}

// Event builders.
func helloEvt(shell string) Event {
	return Event{Kind: KindHello, Hello: &Hello{Shell: shell}}
}

func startEvt(id *AttemptID, command string) Event {
	return Event{Kind: KindStart, Start: &Start{AttemptID: id, Command: command}}
}

func completeEvt(id AttemptID, code int, f FenceNonce) Event {
	return Event{Kind: KindComplete, Complete: &Complete{AttemptID: &id, ExitCode: &code, Fence: f}}
}

func completeEvtNoFence(id AttemptID) Event {
	return Event{Kind: KindComplete, Complete: &Complete{AttemptID: &id}}
}

func promptReadyEvt() Event {
	return Event{Kind: KindPromptReady, PromptReady: &PromptReady{}}
}

func suspendEvt() Event {
	return Event{Kind: KindDomainSuspended, DomainSuspended: &DomainSuspendedEvent{}}
}

func activateEvt() Event {
	return Event{Kind: KindDomainActivated, DomainActivated: &DomainActivatedEvent{}}
}

func closeEvt() Event {
	return Event{Kind: KindDomainClosed, DomainClosed: &DomainClosedEvent{}}
}

func snapshotEvt(rid RequestID, state ShellState, active *AttemptID, last *CompletedRef, nextSeq uint64) Event {
	return Event{Kind: KindSnapshot, Snapshot: &Snapshot{
		RequestID: rid, ShellState: state, ActiveAttemptID: active, LastCompleted: last, NextSequence: nextSeq,
	}}
}

// fence returns a non-zero FenceNonce carrying the marker byte.
func fence(b byte) FenceNonce {
	var f FenceNonce
	f[0] = b
	return f
}

func mustIngest(t *testing.T, k *Kernel, tID TransportID, e Envelope) {
	t.Helper()
	if err := k.Ingest(tID, e); err != nil {
		t.Fatalf("Ingest(%s) failed: %v", e.Event.Kind, err)
	}
}

func mustState(t *testing.T, k *Kernel, lane LaneID) LaneSnapshot {
	t.Helper()
	st, err := k.State(lane)
	if err != nil {
		t.Fatalf("State(%s): %v", lane, err)
	}
	return st
}

func mustAccept(t *testing.T, p *fakePort) {
	t.Helper()
	kinds := p.kinds()
	if len(kinds) != 1 || kinds[0] != KindAccept {
		t.Fatalf("want exactly one accept, got %v", kinds)
	}
}

// establish roots a domain on a lane through the full handshake and returns
// its handle: RequestDomain → hello → accept. It resets the port's recorded
// sends first so every establish asserts exactly its own accept.
func establish(t *testing.T, k *Kernel, tID TransportID, p *fakePort, lane LaneID, parent *DomainID) DomainHandle {
	t.Helper()
	h, err := k.RequestDomain(lane, parent, tID)
	if err != nil {
		t.Fatalf("RequestDomain(%s): %v", lane, err)
	}
	p.reset()
	mustIngest(t, k, tID, env(lane, h, 1, helloEvt("bash")))
	mustAccept(t, p)
	return h
}

// assertState asserts the lifecycle, domain, attempt and stack of a lane.
func assertState(t *testing.T, st LaneSnapshot, want LifecycleState, dom DomainID, att AttemptID, stack []DomainID) {
	t.Helper()
	if st.Lifecycle != want || st.Domain != dom || st.Attempt != att {
		t.Fatalf("state = %v domain=%s attempt=%s, want %v domain=%s attempt=%s",
			st.Lifecycle, st.Domain, st.Attempt, want, dom, att)
	}
	if !reflect.DeepEqual(st.Stack, stack) {
		t.Fatalf("stack = %v, want %v", st.Stack, stack)
	}
}
