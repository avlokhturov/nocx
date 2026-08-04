//go:build !linux && !darwin && !windows

package nativeports

// Everything else: the typed "not implemented on this platform" fallback.
// The provider maps it to the discovery unavailable state, so an
// unsupported OS degrades into a sentence the panel already knows how to
// render — never into a convincing empty list.
import (
	"context"

	"github.com/shady2k/nocx/internal/discovery"
)

const probeName = ""

func listeners(context.Context) ([]discovery.Listener, error) {
	return nil, ErrUnsupported
}
