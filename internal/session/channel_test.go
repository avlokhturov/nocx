package session

import (
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/ssh"
)

// Compile-time assertions that both transport types satisfy the unified
// Channel interface (AD-7). If these fail to compile, the interface
// contract has drifted and must be reconciled.
func TestPtySatisfiesChannel(t *testing.T) {
	var _ Channel = pty.NewStub(log.NewSlogAdapter(nil))
}

func TestSSHSatisfiesChannel(t *testing.T) {
	var _ Channel = ssh.NewStubChannel(log.NewSlogAdapter(nil))
}

func TestChannelInterfaceShape(t *testing.T) {
	var c Channel = pty.NewStub(log.NewSlogAdapter(nil))
	_ = c.Done()
	_ = c.Close()
}
