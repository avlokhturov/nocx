package session

import (
	"context"
	"io"
)

// Channel is the unified transport interface for both local PTY and remote
// SSH sessions (AD-7). Both pty.Pty and ssh.Channel satisfy this interface
// identically: io.ReadWriteCloser + Resize + Done. Session references a
// Channel (not a concrete pty.Pty) so reconnect (AD-9) feeds uniformly
// regardless of transport.
type Channel interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, cols, rows, xpixel, ypixel uint16) error
	Done() <-chan struct{}
}
