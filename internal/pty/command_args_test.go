package pty

import (
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

// TestNewLocal_HonorsCommandArgs proves the nocx-u7uh.21 mechanism: a
// Config carrying an explicit Command/Args is what the process spawns —
// the lifecycle bootstrap starts bash with a transient --rcfile, and
// without this honouring, the local tier could never deliver the
// capability (which must ride script text, never the environment).
func TestNewLocal_HonorsCommandArgs(t *testing.T) {
	lp, err := NewLocal(log.NewSlogAdapter(nil), Config{
		Cols:    80,
		Rows:    24,
		Command: "/bin/sh",
		Args:    []string{"-c", "printf 'COMMAND_ARGS_HONORED\\n'"},
	})
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	defer func() { _ = lp.Close() }()

	buf := make([]byte, 4096)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = lp.file.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, readErr := lp.Read(buf)
		if n > 0 && strings.Contains(string(buf[:n]), "COMMAND_ARGS_HONORED") {
			return
		}
		if readErr != nil {
			continue // deadline: keep polling
		}
	}
	t.Fatal("the configured command's output never arrived; cfg.Command/Args were not honoured")
}
