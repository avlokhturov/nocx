package pty

import (
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/shady2k/nocx/internal/log"
)

// TestLocalPty_ExtraFilesReachTheShell proves the lifecycle descriptor
// mechanism: an extra file passed through WithExtraFiles is inherited by the
// spawned shell as fd 3, and the shell can write to it. The child end's
// parent copy must be closed after spawn, or EOF never arrives.
func TestLocalPty_ExtraFilesReachTheShell(t *testing.T) {
	// SOCK_CLOEXEC is a Linux-only flag, and naming it here is what kept
	// this package's tests from building on macOS (nocx-1w69). The portable
	// form is create-then-mark under ForkLock — the same dance the standard
	// library does — and it is what the product's own socketpair helper does
	// off Linux.
	syscall.ForkLock.RLock()
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err == nil {
		unix.CloseOnExec(fds[0])
		unix.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		t.Fatalf("socketpair: %v", err)
	}
	parent := os.NewFile(uintptr(fds[0]), "test-parent")
	child := os.NewFile(uintptr(fds[1]), "test-child")
	defer func() { _ = parent.Close() }()

	lp, err := NewLocal(log.NewSlogAdapter(nil), Config{
		Cols: 80,
		Rows: 24,
	}, WithExtraFiles(child))
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	defer func() { _ = lp.Close() }()
	_ = child.Close() // the shell holds its own copy; ours must not keep EOF away

	if _, err := lp.Write([]byte("printf EXTRA_FILE_PROOF >&3\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	buf := make([]byte, 4096)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = parent.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, readErr := parent.Read(buf)
		if n > 0 && strings.Contains(string(buf[:n]), "EXTRA_FILE_PROOF") {
			return
		}
		if readErr != nil {
			continue // deadline: keep polling
		}
	}
	t.Fatal("shell output never arrived on the extra fd")
}
