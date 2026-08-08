package capability

import (
	"context"
	"fmt"
	"time"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/transport/control"
)

// SessionService is the session domain surface. It is what a SessionOperation
// hands its callback. Read policy: reads participate in the session gate —
// one registry, and a close must not interleave an open of the same id.
type SessionService interface {
	// Get resolves one session by id. Errors for an unknown id.
	Get(id session.ID) (session.Session, error)
	// Close tears down one session.
	Close(id session.ID) error
	// List returns every live session (sessions.status, attach addressing).
	List() []session.Session
	// Open creates a new session (the open handler's registry half).
	Open(ctx context.Context, cfg session.Config) (session.Session, error)
	// LastUsedForProfiles answers persisted last-used timestamps
	// (sessions.status). An unwired tracker answers an empty map.
	LastUsedForProfiles(profileIDs []string) (map[string]time.Time, error)
}

// SessionOperation is the typed operation for the session domain. Its gate
// is [session]. The operation is scoped by id through SessionOperations.
type SessionOperation interface {
	Run(context.Context, func(context.Context, SessionService) error) error
}

// SessionOperations builds per-session operations. The KIND of resource is
// compile-time (a SessionOperation can only reach sessions); the id is
// runtime. ForSession returns an error for an unknown id and never nil — a
// nil handle is not enforcement. A session can close between ForSession and
// the operation's Run; the per-call Get inside the callback then errors.
type SessionOperations struct {
	sessionGate control.Admission
	registry    session.Registry
	usage       session.ProfileUsageTracker
}

// NewSessionOperations wires the per-session factory. usage may be nil: an
// unwired tracker answers an empty last-used map, exactly as the transport
// handles a nil tracker today.
func NewSessionOperations(sessionGate control.Admission, registry session.Registry, usage session.ProfileUsageTracker) *SessionOperations {
	return &SessionOperations{sessionGate: sessionGate, registry: registry, usage: usage}
}

// ForSession returns a SessionOperation scoped to id, or an error when the
// registry holds no session with that id. Never nil on success.
func (f *SessionOperations) ForSession(id session.ID) (SessionOperation, error) {
	if _, err := f.registry.Get(id); err != nil {
		return nil, fmt.Errorf("capability: unknown session %q", id)
	}
	g := &guard{}
	return newOperation[SessionService](f.sessionGate, g, newSessionService(g, f.registry, f.usage)), nil
}

// NewSessionOperation builds a single SessionOperation — for handlers whose
// operation is fixed at construction (sessions.status, and the session
// half of open) rather than keyed by a per-request id.
func NewSessionOperation(sessionGate control.Admission, registry session.Registry, usage session.ProfileUsageTracker) SessionOperation {
	g := &guard{}
	return newOperation[SessionService](sessionGate, g, newSessionService(g, registry, usage))
}

// newSessionService builds the concrete session service bound to guard g.
func newSessionService(g *guard, registry session.Registry, usage session.ProfileUsageTracker) *sessionService {
	return &sessionService{guard: g, registry: registry, usage: usage}
}

type sessionService struct {
	guard    *guard
	registry session.Registry
	usage    session.ProfileUsageTracker
}

func (s *sessionService) Get(id session.ID) (session.Session, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.registry.Get(id)
}

func (s *sessionService) Close(id session.ID) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.registry.Close(id)
}

func (s *sessionService) List() []session.Session {
	if !s.guard.ok() {
		return nil
	}
	return s.registry.List()
}

func (s *sessionService) Open(ctx context.Context, cfg session.Config) (session.Session, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.registry.Open(ctx, cfg)
}

func (s *sessionService) LastUsedForProfiles(profileIDs []string) (map[string]time.Time, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	if s.usage == nil {
		return map[string]time.Time{}, nil
	}
	return s.usage.LastUsedForProfiles(profileIDs)
}
