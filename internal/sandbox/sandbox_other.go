//go:build !linux && !darwin

package sandbox

import (
	"context"

	"github.com/shady2k/nocx/internal/log"
)

// unsupportedService is the final Windows-and-other stub: the V1 sandbox is
// unsupported outside Linux and macOS (design spec §9.4), so the composition
// root still wires a Service and every request fails closed.
type unsupportedService struct{}

// New returns the unsupported-platform Service for the current platform.
func New(logger log.Logger) Service {
	return unsupportedService{}
}

func (unsupportedService) Status(_ context.Context) Status {
	return Status{Available: false, Backend: BackendUnsupported, Reason: ReasonUnsupportedPlatform}
}

func (unsupportedService) Prepare(_ context.Context, _ Request, _ CommandSpec) (*PreparedCommand, error) {
	return nil, NewSetupErrorf("filesystem sandbox is unsupported on this platform")
}
