package notify

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Focus reports the window's attention state, which suppression consults
// (design §6.1). The window layer provides it — the policy never assumes
// who owns focus. Implementations must be safe for concurrent use.
type Focus interface {
	// WindowFocused reports whether the app window is focused (frontmost).
	WindowFocused() bool

	// FocusedSession reports the session (tab) the user is looking at; the
	// empty string means no tab is focused.
	FocusedSession() string
}

// Disposition reports what Policy.Submit did with one event.
type Disposition int

const (
	// DispositionSuppressed: the event was dropped by the focus rule —
	// nothing was delivered and the event was not counted.
	DispositionSuppressed Disposition = iota

	// DispositionOpened: the event began a new debounce window and will be
	// delivered, once, when the window closes.
	DispositionOpened

	// DispositionCoalesced: the event joined an open debounce window; the
	// window's single notification names the total count.
	DispositionCoalesced
)

func (d Disposition) String() string {
	switch d {
	case DispositionSuppressed:
		return "suppressed"
	case DispositionOpened:
		return "opened"
	case DispositionCoalesced:
		return "coalesced"
	default:
		return fmt.Sprintf("Disposition(%d)", int(d))
	}
}

// DebounceKey identifies one debounce stream: a session and a kind. Keyed by
// session AND kind — never kind alone — or two tabs would collapse into one
// notification and lose their attribution (design §6.2). It never reads
// Title or Body.
type DebounceKey struct {
	Session string
	Kind    Kind
}

// ResultFunc receives the Outcome of every window-close delivery. A refused
// or failed delivery is then observable instead of silently dropped — a
// soft degrade must be visible in the product, not only in a log (design
// §6.4). It is called synchronously from the delivery, after the router's
// Raise returned, and must return promptly. The wire task connects the
// failure surface here.
type ResultFunc func(outcome Outcome)

// PolicyOption configures a Policy at construction.
type PolicyOption func(*Policy)

// WithResultHandler registers fn as the observer of window-close delivery
// outcomes (see ResultFunc). The default policy discards them.
func WithResultHandler(fn ResultFunc) PolicyOption {
	return func(p *Policy) { p.onResult = fn }
}

// Policy applies the attention policy between the sources and the router:
// suppression and the per-{session,kind} debounce with coalescing (design
// §6.1, §6.2). Both stages are payload-independent — suppression keys on
// focus and session, the debounce key on {session, kind}, the coalescing
// count on the number of events — which is what keeps ADR-0029's
// noninterference invariant true: resolution never depends on the
// presentation fields.
//
// The ad-hoc subscription route (ADR-0029 §3, design §6.1) bypasses this
// policy entirely: an explicit gesture delivers immediately through the
// subscription route and is never suppressed, debounced or coalesced. That
// path lands with the subscription work and must not call Submit. This
// policy governs the ordinary raise route only.
type Policy struct {
	ctx    context.Context
	router *Router
	window time.Duration
	focus  Focus
	clock  Clock

	onResult ResultFunc

	mu      sync.Mutex
	streams map[DebounceKey]*stream
}

// stream is one open debounce window: the events accepted for its key since
// the window opened, to be delivered as ONE notification when it closes.
// It retains at most the window-opening event, so memory is bounded by the
// number of open windows and the deadline of each (design §6.2).
type stream struct {
	key      DebounceKey
	count    int
	first    Event // the event that opened the window; carries its attribution
	deadline time.Time
	timer    Timer
}

// NewPolicy builds the attention policy around a router. ctx is the policy's
// own lifetime context — every window-close delivery runs under it, never
// under a caller's request context, because the caller's request is long
// over when a window closes. window is the debounce window (8s in the
// design, termic's number); focus and clock must not be nil.
func NewPolicy(ctx context.Context, router *Router, window time.Duration, focus Focus, clock Clock, opts ...PolicyOption) (*Policy, error) {
	if ctx == nil {
		return nil, errors.New("notify: policy needs a context")
	}
	if router == nil {
		return nil, errors.New("notify: policy needs a router")
	}
	if focus == nil {
		return nil, errors.New("notify: policy needs a focus source")
	}
	if clock == nil {
		return nil, errors.New("notify: policy needs a clock")
	}
	if window <= 0 {
		return nil, errors.New("notify: debounce window must be positive")
	}
	p := &Policy{
		ctx:     ctx,
		router:  router,
		window:  window,
		focus:   focus,
		clock:   clock,
		streams: make(map[DebounceKey]*stream),
	}
	for _, opt := range opts {
		opt(p)
	}
	return p, nil
}

// Submit applies the attention policy to one event and reports what the
// policy did with it. A suppressed event is dropped outright; every other
// event enters (or joins) its debounce window and is delivered exactly once,
// when the window closes, as one notification naming the count of the events
// in the window.
func (p *Policy) Submit(ev Event) Disposition {
	if p.suppressed(ev.SessionID) {
		return DispositionSuppressed
	}

	key := DebounceKey{Session: ev.SessionID, Kind: ev.Kind}
	now := p.clock.Now()

	var expired *stream
	p.mu.Lock()
	if s, ok := p.streams[key]; ok {
		if now.Before(s.deadline) {
			s.count++
			p.mu.Unlock()
			return DispositionCoalesced
		}
		// The deadline passed but the window's timer has not fired yet (or
		// it fired and lost the race with this submit): flush it now and
		// open a fresh window. The stale timer later finds no stream for
		// the key and does nothing.
		delete(p.streams, key)
		expired = s
	}
	s := &stream{
		key:      key,
		count:    1,
		first:    ev,
		deadline: now.Add(p.window),
	}
	s.timer = p.clock.AfterFunc(p.window, func() { p.flush(key) })
	p.streams[key] = s
	p.mu.Unlock()

	if expired != nil {
		p.deliverWindow(expired)
	}
	return DispositionOpened
}

// flush delivers the window for key if it is still open and its deadline has
// passed, then removes it. It is the timer callback; the delivery runs under
// the policy's own context, never a caller's.
func (p *Policy) flush(key DebounceKey) {
	p.mu.Lock()
	s, ok := p.streams[key]
	if !ok {
		p.mu.Unlock()
		return
	}
	if p.clock.Now().Before(s.deadline) {
		// A newer window for the same key superseded the one this timer was
		// scheduled for; the newer window's own timer will close it.
		p.mu.Unlock()
		return
	}
	delete(p.streams, key)
	p.mu.Unlock()

	p.deliverWindow(s)
}

// deliverWindow delivers the coalesced notification of one closed window: a
// single event naming the count, carrying the attribution of the session it
// was keyed on. A window of one is the event itself. Suppression is
// re-checked at delivery, not only at submit: nothing is delivered about the
// tab the user is looking at in a focused window, even if it was not focused
// when the window opened (design §6.1).
func (p *Policy) deliverWindow(s *stream) {
	if p.suppressed(s.key.Session) {
		return
	}
	ev := s.first
	if s.count > 1 {
		ev.Body = fmt.Sprintf("%d notifications", s.count)
	}
	out := p.router.Raise(p.ctx, ev)
	if p.onResult != nil {
		p.onResult(out)
	}
}

// suppressed reports whether an event for session is delivered nowhere: the
// user is looking at that tab in a focused window (design §6.1). Only the
// ordinary raise route passes through here — the ad-hoc subscription route
// bypasses the policy (see Policy).
func (p *Policy) suppressed(session string) bool {
	return session != "" && p.focus.WindowFocused() && p.focus.FocusedSession() == session
}

// Raise presents the policy as the transport's raiser, so notify.raise
// reaches the pipeline through the attention policy rather than around it.
//
// The answer is deliberately not a delivery result. Submit returns as soon as
// the event has been accepted — suppressed, or opened into or joined onto a
// debounce window — and the delivery happens when that window closes, which
// may be seconds later. A program asking for a notification must not block
// until then, so the outcome carries no Results by construction and a nil Err
// means "accepted", never "delivered".
//
// Where a failure becomes visible therefore moves: an admission refusal or a
// sink error arrives at the result handler (WithResultHandler) rather than at
// the caller. ADR-0029 §2.2 requires a refused delivery to be visible, and the
// handler is the seam that carries it — today into the log, and into whatever
// surface reports notification health when one exists (nocx-jiwq.2).
func (p *Policy) Raise(ctx context.Context, ev Event) Outcome {
	if err := ctx.Err(); err != nil {
		return Outcome{Err: err}
	}
	p.Submit(ev)
	return Outcome{}
}
