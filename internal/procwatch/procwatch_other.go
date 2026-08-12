//go:build !darwin

package procwatch

import "github.com/shady2k/nocx/internal/log"

// New returns the honest answer for every platform that has no NOTE_EXEC:
// nothing is observed, and every watch says so.
//
// The reasoning is in the package comment and is deliberate rather than
// pending. Linux's candidates are a /proc/<pid>/exe poll (a race by
// construction, and an interval is the timing dependence a test may not
// carry), the netlink proc connector (a privilege a terminal should not ask
// for), and ptrace (which changes the child to observe it). A detector that
// misses the fast takeovers while claiming to watch would be worse than the
// handshake bound it replaces, because the bound at least always answers.
func New(logger log.Logger) Watcher {
	logger.Info("process observation is not available on this platform; " +
		"a session that loses its shell is detected by the handshake bound alone")
	return unsupported{err: ErrUnsupported}
}
