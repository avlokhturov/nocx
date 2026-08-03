//go:build linux

package sandbox

import (
	"context"

	"github.com/shady2k/nocx/internal/log"
)

// linuxService is the Landlock-backed Service.
//
// Slice-1 placeholder: enforcement (helper re-exec, strict RestrictPaths at
// min(detectedABI, 8)) lands in slice 2, which replaces the Prepare body.
// Until then the backend reports unavailable and fails closed.
type linuxService struct {
	log log.Logger
}

// New returns the Landlock-backed Service for the current platform.
func New(logger log.Logger) Service {
	return &linuxService{log: logger}
}

func (s *linuxService) Status(_ context.Context) Status {
	return Status{Available: false, Backend: BackendLandlock, Reason: ReasonLandlockUnavailable}
}

func (s *linuxService) Prepare(_ context.Context, _ Request, _ CommandSpec) (*PreparedCommand, error) {
	return nil, NewSetupErrorf("landlock backend not implemented yet")
}
