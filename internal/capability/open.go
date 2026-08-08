package capability

import (
	"context"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/transport/control"
)

// ProfileResolver maps a profile ID to an SSH host and connect config. It
// is the resolver seam the open flow uses; the composition root wires it
// from the profile service (the transport's ProfileResolver, adapted).
// Passwords are never carried in the returned config — they are late-bound
// via the credential store wired into ConnectConfig, so the resolver reads
// the vault internally and the operation's gates cannot see inside it.
type ProfileResolver interface {
	Resolve(profileID string) (host string, cfg *ssh.ConnectConfig, err error)
}

// OpenService is the session-open surface: resolve the profile, open the
// session, and clean up on failure. It is what an OpenOperation hands its
// callback. The dial itself runs inside the callback — that is the
// deliberate trade of this conservative grain: an open holds the
// [config, session] gates for its whole duration, so a concurrent config
// request is refused rather than frozen. Refining the grain (acquire the
// config gate for the resolve only, then dial ungated) is an
// implementation change here; no handler changes.
type OpenService interface {
	Resolve(profileID string) (host string, cfg *ssh.ConnectConfig, err error)
	Open(ctx context.Context, cfg session.Config) (session.Session, error)
	Close(id session.ID) error
}

// OpenOperation is the typed operation for the "open" control method. Its
// gates are [config, session]: opening resolves a profile and creates a
// session.
type OpenOperation interface {
	Run(context.Context, func(context.Context, OpenService) error) error
}

// NewOpenOperation builds an OpenOperation that acquires configGate before
// sessionGate (the canonical order).
func NewOpenOperation(
	configGate, sessionGate control.Admission,
	resolver ProfileResolver,
	registry session.Registry,
) OpenOperation {
	g := &guard{}
	return newOperation[OpenService](
		control.NewComposite(configGate, sessionGate),
		g,
		newOpenService(g, resolver, registry),
	)
}

// newOpenService builds the concrete open service bound to guard g.
func newOpenService(g *guard, resolver ProfileResolver, registry session.Registry) *openService {
	return &openService{guard: g, resolver: resolver, registry: registry}
}

type openService struct {
	guard    *guard
	resolver ProfileResolver
	registry session.Registry
}

func (s *openService) Resolve(profileID string) (string, *ssh.ConnectConfig, error) {
	if err := s.guard.check(); err != nil {
		return "", nil, err
	}
	return s.resolver.Resolve(profileID)
}

func (s *openService) Open(ctx context.Context, cfg session.Config) (session.Session, error) {
	if err := s.guard.check(); err != nil {
		return nil, err
	}
	return s.registry.Open(ctx, cfg)
}

func (s *openService) Close(id session.ID) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.registry.Close(id)
}
