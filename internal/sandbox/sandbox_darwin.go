//go:build darwin

package sandbox

import (
	"context"

	"github.com/shady2k/nocx/internal/log"
)

// darwinService is the Seatbelt-backed Service.
//
// Slice-1 placeholder: SBPL rendering, the /usr/bin/sandbox-exec probe, and
// the launch wrapper land in slice 3, which replaces the Prepare body. Until
// then the backend reports unavailable and fails closed.
type darwinService struct {
	log log.Logger
}

// New returns the Seatbelt-backed Service for the current platform.
func New(logger log.Logger, _ string) Service {
	return &darwinService{log: logger}
}

// MaybeHelper is a no-op on non-Linux platforms: the sandbox helper is a
// Linux-only mechanism.
func MaybeHelper() bool { return false }

func (s *darwinService) Status(_ context.Context) Status {
	return Status{Available: false, Backend: BackendSeatbelt, Reason: ReasonSandboxExecUnavailable}
}

func (s *darwinService) Prepare(_ context.Context, _ Request, _ CommandSpec) (*PreparedCommand, error) {
	return nil, NewSetupErrorf("seatbelt backend not implemented yet")
}
