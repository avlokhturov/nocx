package lifecycle

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"sort"
	"sync"
	"time"
)

// Options configure a Kernel. Zero fields fall back to the defaults: the real
// clock, crypto/rand, and DefaultBudgets.
type Options struct {
	Now     func() time.Time
	Rand    io.Reader
	Budgets Budgets
}

// Kernel is the pure authenticated lifecycle model. It is safe for concurrent
// use: each public method serializes on an internal mutex, applies its
// transition, and only then — outside the lock — delivers outbound envelopes
// (accept, refresh_request) to the transport ports. Invalid events mutate
// nothing and return a sentinel error (errors.go).
type Kernel struct {
	mu       sync.Mutex
	now      func() time.Time
	rand     io.Reader
	budgets  Budgets
	registry *DomainRegistry
	lanes    map[LaneID]*laneState
	attempts map[AttemptID]*ExecutionAttempt
	ports    map[TransportID]Port
}

// New builds a Kernel with the given options. A nil Now uses time.Now; a nil
// Rand uses crypto/rand.Reader.
func New(opts Options) *Kernel {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Rand == nil {
		opts.Rand = rand.Reader
	}
	opts.Budgets = opts.Budgets.withDefaults()
	return &Kernel{
		now:      opts.Now,
		rand:     opts.Rand,
		budgets:  opts.Budgets,
		registry: NewDomainRegistry(),
		lanes:    make(map[LaneID]*laneState),
		attempts: make(map[AttemptID]*ExecutionAttempt),
		ports:    make(map[TransportID]Port),
	}
}

// BindTransport registers a transport and its outbound port. A transport binds
// once and is never unbound.
func (k *Kernel) BindTransport(t TransportID, port Port) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if t == "" || port == nil {
		return ErrInvalidArgument
	}
	if _, ok := k.ports[t]; ok {
		return ErrInvalidArgument
	}
	k.ports[t] = port
	return nil
}

// RequestDomain mints a Pending domain bound to the transport: a fresh id, a
// fresh epoch and a fresh capability. The adapter substitutes the capability
// into the integration script and waits for the shell's hello; nothing is
// live until the handshake completes (decision 3). parent must be the top of
// the lane's stack; a top-level domain requires an empty lane.
func (k *Kernel) RequestDomain(lane LaneID, parent *DomainID, t TransportID) (DomainHandle, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, ok := k.ports[t]; !ok {
		return DomainHandle{}, ErrUnknownTransport
	}
	ls := k.getLane(lane)
	if k.overHandshakeBudget(ls) {
		return DomainHandle{}, ErrHandshakeRateLimited
	}
	var parentID *DomainID
	if parent != nil {
		pd, ok := k.registry.Lookup(*parent)
		if !ok {
			return DomainHandle{}, ErrUnknownParent
		}
		if pd.State != DomainEstablished && pd.State != DomainSuspended {
			return DomainHandle{}, ErrParentNotLive
		}
		if pd.Lane != lane {
			return DomainHandle{}, ErrWrongLane
		}
		if ls.top() != pd.ID {
			return DomainHandle{}, ErrParentNotTop
		}
		pid := pd.ID
		parentID = &pid
	} else if ls.top() != "" {
		return DomainHandle{}, ErrLaneBusy
	}
	d := &Domain{
		ID:         DomainID("dom-" + k.randomHex(8)),
		Epoch:      k.registry.nextEpoch(),
		Parent:     parentID,
		Lane:       lane,
		Transport:  t,
		State:      DomainPending,
		capability: k.randomCapability(),
	}
	k.registry.Register(d)
	return DomainHandle{Domain: d.ID, Epoch: d.Epoch, Capability: d.capability}, nil
}

// Ingest delivers one authenticated envelope from a transport. Validation
// order (decision 7): protocol version, domain liveness, transport binding,
// epoch, capability — authentication terminates before any domain or sequence
// state is consulted — then lane match, then the monotonic sequence rule, then
// the legal transition. Invalid events mutate nothing.
func (k *Kernel) Ingest(t TransportID, env Envelope) error {
	k.mu.Lock()
	out, err := k.ingestLocked(t, env)
	k.mu.Unlock()
	k.flush(out)
	return err
}

func (k *Kernel) ingestLocked(t TransportID, env Envelope) ([]outbound, error) {
	if _, ok := k.ports[t]; !ok {
		return nil, ErrUnknownTransport
	}
	if env.Version != ProtocolVersion {
		return nil, ErrBadVersion
	}
	if !env.Event.validInbound() {
		return nil, ErrIllegalEvent
	}
	d, ok := k.registry.Lookup(env.Domain)
	if !ok {
		k.recordAuthFailure(env.Lane)
		return nil, ErrUnknownDomain
	}
	if d.Transport != t {
		k.recordAuthFailure(d.Lane)
		return nil, ErrWrongTransport
	}
	if d.Epoch != env.Epoch {
		k.recordAuthFailure(d.Lane)
		return nil, ErrStaleEpoch
	}
	if d.capability != env.Capability {
		k.recordAuthFailure(d.Lane)
		return nil, ErrBadCapability
	}
	if d.Lane != env.Lane {
		return nil, ErrWrongLane
	}
	// Authenticated. Sequence state may mutate only after this point.
	if env.Sequence <= d.lastSeq {
		return nil, ErrSequenceReplay
	}
	ls := k.lanes[d.Lane]
	if d.State == DomainDesynchronized {
		k.checkDesyncBudget(d, ls) // time can elapse while nothing is scanned
	}
	var out []outbound
	var err error
	switch env.Event.Kind {
	case KindHello:
		out, err = k.applyHello(d, ls, env)
	case KindStart:
		out, err = k.applyStart(d, ls, env)
	case KindComplete:
		out, err = k.applyComplete(d, ls, env)
	case KindPromptReady:
		out, err = k.applyPromptReady(d, ls, env)
	case KindSnapshot:
		out, err = k.applySnapshot(d, ls, env)
	case KindDomainSuspended:
		out, err = k.applySuspend(d, ls, env)
	case KindDomainActivated:
		out, err = k.applyActivate(d, ls, env)
	case KindDomainClosed:
		out, err = k.applyClose(d, ls, env)
	default:
		return nil, ErrIllegalEvent
	}
	if err == nil {
		// The counter advances exactly when an event is accepted — never
		// before authentication, never on a rejected frame (decision 7).
		d.lastSeq = env.Sequence
	}
	return out, err
}

// NotifyGap reports framing corruption on a transport: the adapter scanned
// garbageBytes of garbage spanning garbageFrames frame boundaries. The domain
// enters Desynchronized (or the episode's budgets accumulate), nocx requests an
// authenticated snapshot, and only a snapshot answering it restores authority
// (decision 7). Budget exhaustion revokes the domain.
func (k *Kernel) NotifyGap(t TransportID, dID DomainID, garbageBytes, garbageFrames int) error {
	k.mu.Lock()
	out, err := k.notifyGapLocked(t, dID, garbageBytes, garbageFrames)
	k.mu.Unlock()
	k.flush(out)
	return err
}

func (k *Kernel) notifyGapLocked(t TransportID, dID DomainID, garbageBytes, garbageFrames int) ([]outbound, error) {
	if _, ok := k.ports[t]; !ok {
		return nil, ErrUnknownTransport
	}
	if garbageBytes < 0 || garbageFrames < 0 {
		return nil, ErrInvalidArgument
	}
	d, ok := k.registry.Lookup(dID)
	if !ok {
		return nil, ErrUnknownDomain
	}
	if d.Transport != t {
		return nil, ErrWrongTransport
	}
	ls := k.lanes[d.Lane]
	var out []outbound
	switch d.State {
	case DomainEstablished:
		if d.desyncEpisodes+1 > k.budgets.MaxDesyncEpisodes {
			k.revoke(d, ls)
			return out, nil
		}
		d.desyncEpisodes++
		d.State = DomainDesynchronized
		d.desyncSince = k.now()
		d.desyncBytes = garbageBytes
		d.desyncFrames = garbageFrames
		rid := RequestID("req-" + k.randomHex(8))
		d.refreshRequest = &rid
		if ls.top() == d.ID {
			k.setLifecycle(ls, LifecycleDesynchronized, d.ID, "")
		}
		out = append(out, k.refreshOutbound(d, rid))
	case DomainDesynchronized:
		d.desyncBytes += garbageBytes
		d.desyncFrames += garbageFrames
		k.checkDesyncBudget(d, ls)
	default:
		return nil, ErrDomainNotLive
	}
	return out, nil
}

// TransportLost notifies that a transport died. Every domain bound to it is
// lost (decision 8), the cascade takes their descendants down too, open
// attempts become unknown and never successful, and each affected lane falls
// to LifecycleLost. A new session gets fresh epochs — never resumed ones.
func (k *Kernel) TransportLost(t TransportID) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, ok := k.ports[t]; !ok {
		return ErrUnknownTransport
	}
	dead := make(map[DomainID]bool)
	for _, d := range k.registry.DomainsOnTransport(t) {
		dead[d.ID] = true
	}
	// Cascade: a domain cannot outlive its parent chain.
	changed := true
	for changed {
		changed = false
		for _, d := range k.registry.All() {
			if !dead[d.ID] && d.Parent != nil && dead[*d.Parent] {
				dead[d.ID] = true
				changed = true
			}
		}
	}
	affected := make(map[LaneID]bool)
	for _, d := range k.registry.All() {
		if !dead[d.ID] {
			continue
		}
		d.State = DomainLost
		d.refreshRequest = nil
		k.unknownOpenAttempts(d.ID)
		if ls, ok := k.lanes[d.Lane]; ok {
			affected[d.Lane] = true
			k.removeFromStack(ls, d.ID)
		}
	}
	for lane := range affected {
		if ls, ok := k.lanes[lane]; ok {
			k.setLifecycle(ls, LifecycleLost, "", "")
		}
	}
	return nil
}

// SubmitAttempt synchronously creates an app-originated attempt — id,
// app-owned command text, cwd, host, start time — before the bytes that could
// cause the shell's own start are written to the pty (decision 5). It requires
// a live, active, non-desynchronized domain at a ready prompt.
func (k *Kernel) SubmitAttempt(domain DomainID, command, cwd, host string) (ExecutionAttempt, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	d, ok := k.registry.Lookup(domain)
	if !ok {
		return ExecutionAttempt{}, ErrUnknownDomain
	}
	ls := k.lanes[d.Lane]
	if err := k.requireActive(d, ls); err != nil {
		return ExecutionAttempt{}, err
	}
	if ls.lifecycle != LifecyclePromptReady {
		return ExecutionAttempt{}, ErrNotPromptReady
	}
	if len(command) > k.budgets.MaxCommandBytes {
		return ExecutionAttempt{}, ErrOversizeCommand
	}
	if open := k.openAttemptFor(d.ID); open != nil {
		return ExecutionAttempt{}, ErrAttemptOpen
	}
	att := k.createAttempt(d, k.newAttemptID(), OriginApp, false, command, cwd, host, k.now())
	k.setLifecycle(ls, LifecycleRunning, d.ID, att.ID)
	return *att, nil
}

// AbandonAttempt marks an open attempt unknown — the explicit abandonment path
// (native-mode escape, decision 5). Nothing may mark it successful and nothing
// may assign it an exit code it did not report.
func (k *Kernel) AbandonAttempt(id AttemptID) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	att, ok := k.attempts[id]
	if !ok || att.State != AttemptOpen {
		return ErrAttemptNotOpen
	}
	att.State = AttemptUnknown
	return nil
}

// State returns the read model of one lane.
func (k *Kernel) State(lane LaneID) (LaneSnapshot, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	ls, ok := k.lanes[lane]
	if !ok {
		return LaneSnapshot{}, ErrUnknownLane
	}
	snap := LaneSnapshot{
		Lane:      lane,
		Lifecycle: ls.lifecycle,
		Domain:    ls.lifecycleDomain,
		Attempt:   ls.lifecycleAttempt,
		Stack:     append([]DomainID(nil), ls.stack...),
	}
	for _, att := range k.attempts {
		if att.State != AttemptOpen {
			continue
		}
		if dl, ok := k.registry.Lookup(att.Domain); ok && dl.Lane == lane {
			snap.OpenAttempts = append(snap.OpenAttempts, att.ID)
		}
	}
	sort.Slice(snap.OpenAttempts, func(i, j int) bool { return snap.OpenAttempts[i] < snap.OpenAttempts[j] })
	return snap, nil
}

// Attempt returns a copy of the attempt, if it exists.
func (k *Kernel) Attempt(id AttemptID) (ExecutionAttempt, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	att, ok := k.attempts[id]
	if !ok {
		return ExecutionAttempt{}, false
	}
	return *att, true
}

// OpenAttempt returns the single open attempt of a domain, if any. At most one
// attempt is open per domain at a time.
func (k *Kernel) OpenAttempt(domain DomainID) (ExecutionAttempt, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if att := k.openAttemptFor(domain); att != nil {
		return *att, true
	}
	return ExecutionAttempt{}, false
}

// Domain returns the read model of one domain.
func (k *Kernel) Domain(id DomainID) (Domain, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	d, ok := k.registry.Lookup(id)
	if !ok {
		return Domain{}, false
	}
	return *d, true
}

// --- transitions -----------------------------------------------------------

func (k *Kernel) applyHello(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	switch d.State {
	case DomainPending:
		if d.Parent == nil {
			if ls.top() != "" {
				k.recordAuthFailure(d.Lane)
				return nil, ErrLaneBusy
			}
		} else {
			pd, ok := k.registry.Lookup(*d.Parent)
			if !ok {
				return nil, ErrUnknownParent
			}
			if pd.State != DomainSuspended {
				k.recordAuthFailure(d.Lane)
				return nil, ErrParentActive
			}
			if ls.top() != pd.ID {
				return nil, ErrParentNotTop
			}
		}
		d.State = DomainEstablished
		ls.stack = append(ls.stack, d.ID)
		k.setLifecycle(ls, LifecyclePromptReady, d.ID, "")
		return []outbound{k.acceptOutbound(d)}, nil
	case DomainEstablished, DomainSuspended, DomainDesynchronized:
		// Reconnect within the epoch: accepted, counter never resets,
		// authority unchanged. A fresh accept lets the shell gate its
		// prompt suppression on the reply.
		return []outbound{k.acceptOutbound(d)}, nil
	default:
		return nil, ErrDomainNotLive
	}
}

func (k *Kernel) applyStart(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if err := k.requireActive(d, ls); err != nil {
		return nil, err
	}
	if len(env.Event.Start.Command) > k.budgets.MaxCommandBytes {
		return nil, ErrOversizeCommand
	}
	open := k.openAttemptFor(d.ID)
	// Lifecycle gate (decision 5): a start attaches to the single pending
	// app attempt, or opens a shell-originated attempt — and only at a ready
	// prompt. Running with a just-completed attempt (awaiting prompt_ready)
	// or any other lane state is a violation.
	switch {
	case open != nil && !open.Started:
		if env.Event.Start.AttemptID != nil && *env.Event.Start.AttemptID != open.ID {
			return nil, ErrAttemptMismatch // a second top-level attempt over a pending one
		}
		open.Started = true // attach: id, command text, cwd, host and secrets stay app-owned
		k.setLifecycle(ls, LifecycleRunning, d.ID, open.ID)
		return nil, nil
	case open != nil:
		return nil, ErrAttemptOpen // start while an attempt runs
	default:
		if ls.lifecycle != LifecyclePromptReady {
			return nil, ErrNotPromptReady // no prompt yet: completion pending, or lane lost/native
		}
		if env.Event.Start.AttemptID != nil {
			if _, exists := k.attempts[*env.Event.Start.AttemptID]; exists {
				return nil, ErrAttemptIDExists
			}
		}
		var id AttemptID
		if env.Event.Start.AttemptID != nil {
			id = *env.Event.Start.AttemptID
		} else {
			id = k.newAttemptID()
		}
		att := k.createAttempt(d, id, OriginShell, true, env.Event.Start.Command, "", "", k.now())
		k.setLifecycle(ls, LifecycleRunning, d.ID, att.ID)
		return nil, nil
	}
}

func (k *Kernel) applyComplete(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if err := k.requireActive(d, ls); err != nil {
		return nil, err
	}
	c := env.Event.Complete
	if c.Fence == (FenceNonce{}) {
		return nil, ErrFenceMissing
	}
	att := k.openAttemptFor(d.ID)
	if c.AttemptID != nil {
		named, ok := k.attempts[*c.AttemptID]
		if !ok {
			return nil, ErrAttemptNotOpen
		}
		if named.Domain != d.ID {
			return nil, ErrAttemptDomainMismatch
		}
		if att != nil && named.ID != att.ID {
			return nil, ErrAttemptMismatch
		}
		att = named
	}
	if att == nil {
		return nil, ErrAttemptNotOpen
	}
	if !att.Started {
		return nil, ErrAttemptNotStarted
	}
	if att.State != AttemptOpen {
		return nil, ErrAttemptNotOpen // exit status is set exactly once
	}
	now := k.now()
	att.State = AttemptCompleted
	att.ExitCode = c.ExitCode
	att.CompletedAt = &now
	att.Fence = c.Fence
	return nil, nil
}

func (k *Kernel) applyPromptReady(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if err := k.requireActive(d, ls); err != nil {
		return nil, err
	}
	if open := k.openAttemptFor(d.ID); open != nil {
		return nil, ErrPromptOverAttempt
	}
	k.setLifecycle(ls, LifecyclePromptReady, d.ID, "")
	return nil, nil
}

func (k *Kernel) applySuspend(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if err := k.requireActive(d, ls); err != nil {
		return nil, err
	}
	d.State = DomainSuspended
	k.setLifecycle(ls, LifecycleNative, "", "")
	return nil, nil
}

func (k *Kernel) applyActivate(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if d.State != DomainSuspended {
		return nil, ErrNotSuspended
	}
	if ls.top() != d.ID {
		return nil, ErrDomainNotTop // a live child is above; close it first
	}
	d.State = DomainEstablished
	if open := k.openAttemptFor(d.ID); open != nil {
		k.setLifecycle(ls, LifecycleRunning, d.ID, open.ID)
	} else {
		k.setLifecycle(ls, LifecyclePromptReady, d.ID, "")
	}
	return nil, nil
}

func (k *Kernel) applyClose(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if d.State != DomainEstablished && d.State != DomainSuspended {
		return nil, ErrDomainNotLive
	}
	if ls.top() != d.ID {
		return nil, ErrDomainNotTop
	}
	ls.stack = ls.stack[:len(ls.stack)-1]
	d.State = DomainClosed
	k.unknownOpenAttempts(d.ID) // the shell is gone; no completion will come
	k.setLifecycle(ls, LifecycleNative, "", "")
	return nil, nil
}

func (k *Kernel) applySnapshot(d *Domain, ls *laneState, env Envelope) ([]outbound, error) {
	if d.State != DomainDesynchronized {
		return nil, ErrSnapshotUnexpected
	}
	s := env.Event.Snapshot
	if d.refreshRequest == nil || *d.refreshRequest != s.RequestID {
		return nil, ErrSnapshotMismatch
	}
	if s.NextSequence <= env.Sequence {
		return nil, ErrSnapshotSequence
	}
	if s.ActiveAttemptID != nil && s.LastCompleted != nil && *s.ActiveAttemptID == s.LastCompleted.AttemptID {
		return nil, ErrSnapshotConflict
	}
	// Validation phase: every reference in the snapshot must agree with the
	// kernel's records before anything mutates (decision 7: invalid events
	// mutate nothing). An unknown active attempt is fine — it will be
	// created from the snapshot (its start was lost in the gap) — and an
	// unknown last-completed attempt is fine — there is nothing open to
	// reconcile against it.
	if s.ActiveAttemptID != nil {
		if att, exists := k.attempts[*s.ActiveAttemptID]; exists {
			if att.Domain != d.ID {
				return nil, ErrSnapshotConflict
			}
			if att.State != AttemptOpen {
				return nil, ErrSnapshotConflict // shell claims running; we have it terminal
			}
		}
	}
	if s.LastCompleted != nil {
		if att, exists := k.attempts[s.LastCompleted.AttemptID]; exists {
			if att.Domain != d.ID {
				return nil, ErrSnapshotConflict
			}
		}
	}
	// Apply phase: all validation passed, so every mutation below is final.
	if s.ActiveAttemptID != nil {
		if _, exists := k.attempts[*s.ActiveAttemptID]; !exists {
			k.createAttempt(d, *s.ActiveAttemptID, OriginShell, true, "", "", "", k.now())
		}
	}
	if s.LastCompleted != nil {
		if att, exists := k.attempts[s.LastCompleted.AttemptID]; exists && att.State == AttemptOpen {
			now := k.now()
			att.State = AttemptCompleted
			att.ExitCode = s.LastCompleted.ExitCode
			att.CompletedAt = &now
		}
		// Already terminal: nothing to reconcile.
	}
	for _, att := range k.attempts {
		if att.Domain == d.ID && att.State == AttemptOpen &&
			(s.ActiveAttemptID == nil || *s.ActiveAttemptID != att.ID) {
			att.State = AttemptUnknown // open, but the shell is not running it
		}
	}
	d.State = DomainEstablished
	d.refreshRequest = nil
	d.desyncBytes, d.desyncFrames = 0, 0
	if ls.top() == d.ID {
		if s.ActiveAttemptID != nil {
			k.setLifecycle(ls, LifecycleRunning, d.ID, *s.ActiveAttemptID)
		} else {
			k.setLifecycle(ls, LifecyclePromptReady, d.ID, "")
		}
	}
	return nil, nil
}

// --- helpers ---------------------------------------------------------------

type outbound struct {
	port Port
	env  Envelope
}

// flush delivers outbound envelopes after the lock is released. Ports are
// captured under the lock and never unbound, so the captured value stays
// valid. Send failures are best-effort (safe direction: the shell times out).
func (k *Kernel) flush(out []outbound) {
	for _, o := range out {
		_ = o.port.Send(o.env)
	}
}

func (k *Kernel) acceptOutbound(d *Domain) outbound {
	return outbound{
		port: k.ports[d.Transport],
		env: Envelope{
			Version: ProtocolVersion, Lane: d.Lane, Domain: d.ID,
			Epoch: d.Epoch, Capability: d.capability,
			Event: Event{Kind: KindAccept, Accept: &Accept{}},
		},
	}
}

func (k *Kernel) refreshOutbound(d *Domain, rid RequestID) outbound {
	return outbound{
		port: k.ports[d.Transport],
		env: Envelope{
			Version: ProtocolVersion, Lane: d.Lane, Domain: d.ID,
			Epoch: d.Epoch, Capability: d.capability,
			Event: Event{Kind: KindRefreshRequest, RefreshRequest: &RefreshRequest{RequestID: rid}},
		},
	}
}

// requireActive enforces that the domain is live, established (not
// desynchronized), and the top of its lane stack.
func (k *Kernel) requireActive(d *Domain, ls *laneState) error {
	switch d.State {
	case DomainEstablished:
		if ls.top() != d.ID {
			return ErrDomainNotTop
		}
		return nil
	case DomainDesynchronized:
		return ErrDomainDesynchronized
	case DomainSuspended:
		return ErrDomainInactive
	case DomainPending:
		return ErrDomainPending
	default:
		return ErrDomainNotLive
	}
}

func (k *Kernel) createAttempt(d *Domain, id AttemptID, origin AttemptOrigin, started bool, command, cwd, host string, at time.Time) *ExecutionAttempt {
	att := &ExecutionAttempt{
		ID: id, Domain: d.ID, Lane: d.Lane,
		Command: command, Cwd: cwd, Host: host,
		StartedAt: at, Origin: origin, Started: started, State: AttemptOpen,
	}
	k.attempts[id] = att
	return att
}

func (k *Kernel) openAttemptFor(domain DomainID) *ExecutionAttempt {
	for _, att := range k.attempts {
		if att.Domain == domain && att.State == AttemptOpen {
			return att
		}
	}
	return nil
}

func (k *Kernel) unknownOpenAttempts(domain DomainID) {
	for _, att := range k.attempts {
		if att.Domain == domain && att.State == AttemptOpen {
			att.State = AttemptUnknown
		}
	}
}

func (k *Kernel) removeFromStack(ls *laneState, id DomainID) {
	for i, cur := range ls.stack {
		if cur == id {
			ls.stack = append(ls.stack[:i], ls.stack[i+1:]...)
			return
		}
	}
}

func (k *Kernel) revoke(d *Domain, ls *laneState) {
	d.State = DomainClosed
	d.refreshRequest = nil
	k.unknownOpenAttempts(d.ID)
	k.removeFromStack(ls, d.ID)
	k.setLifecycle(ls, LifecycleNative, "", "")
}

func (k *Kernel) checkDesyncBudget(d *Domain, ls *laneState) {
	if d.desyncBytes > k.budgets.ScanBytes ||
		d.desyncFrames > k.budgets.ScanFrames ||
		k.now().Sub(d.desyncSince) >= k.budgets.ScanDuration {
		k.revoke(d, ls)
	}
}

func (k *Kernel) getLane(lane LaneID) *laneState {
	if ls, ok := k.lanes[lane]; ok {
		return ls
	}
	ls := &laneState{lane: lane}
	k.lanes[lane] = ls
	return ls
}

func (k *Kernel) setLifecycle(ls *laneState, st LifecycleState, d DomainID, att AttemptID) {
	ls.lifecycle = st
	ls.lifecycleDomain = d
	ls.lifecycleAttempt = att
}

func (k *Kernel) overHandshakeBudget(ls *laneState) bool {
	if ls == nil {
		return false
	}
	now := k.now()
	keep := ls.helloFailures[:0]
	for _, t := range ls.helloFailures {
		if now.Sub(t) < k.budgets.HandshakeWindow {
			keep = append(keep, t)
		}
	}
	ls.helloFailures = keep
	return len(keep) >= k.budgets.HandshakeFailures
}

// recordAuthFailure charges one failed handshake to the lane (decision 3's
// rate limit). Unknown lanes are skipped: garbage lane ids are the adapter's
// connection-level concern.
func (k *Kernel) recordAuthFailure(lane LaneID) {
	if ls, ok := k.lanes[lane]; ok {
		ls.helloFailures = append(ls.helloFailures, k.now())
	}
}

func (k *Kernel) randomHex(n int) string {
	b := make([]byte, n)
	_, _ = io.ReadFull(k.rand, b)
	return hex.EncodeToString(b)
}

func (k *Kernel) randomCapability() Capability {
	var c Capability
	_, _ = io.ReadFull(k.rand, c[:])
	return c
}

func (k *Kernel) newAttemptID() AttemptID {
	return AttemptID("att-" + k.randomHex(8))
}
