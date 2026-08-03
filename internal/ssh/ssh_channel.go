package ssh

import (
	"context"
	"encoding/binary"
	"io"
	"sync"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
)

// RealChannel implements the Channel interface over an SSH session.
type RealChannel struct {
	log     log.Logger
	session *gossh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	done    chan struct{}

	// shellIntegrationReason is why shell integration did not happen,
	// decided by openShell when the session started (nocx-r52q). ReasonNone
	// means integration succeeded or was never attempted.
	shellIntegrationReason RefusalReason

	closeOnce sync.Once
	closeCb   func()
	// releasePoolRef drops this channel's reference to the pooled ssh.Client.
	// Set by RealClient.Connect; invoked once from Close (after closeOnce
	// fires) so the connection closes when the last referencing tab closes,
	// including the jump transport (AD-4). Nil for non-pooled channels.
	releasePoolRef func()
}

func (c *RealChannel) Read(p []byte) (int, error) {
	return c.stdout.Read(p)
}

func (c *RealChannel) Write(p []byte) (int, error) {
	return c.stdin.Write(p)
}

func (c *RealChannel) Close() error {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.closeCb != nil {
			c.closeCb()
		}
		if c.releasePoolRef != nil {
			c.releasePoolRef()
		}
	})
	return nil
}

func (c *RealChannel) Done() <-chan struct{} {
	return c.done
}

func (c *RealChannel) ShellIntegrationReason() RefusalReason {
	return c.shellIntegrationReason
}

// Resize sends a window-change request to the remote end.
//
// It checks the channel's done signal first: after disconnect (AD-7), Resize
// returns *ErrDisconnected immediately instead of blocking on the now-dead
// transport. The context is checked before the request and observed during
// the SendRequest call via a goroutine watchdog — if ctx cancels while
// SendRequest blocks (e.g. on a congested transport), Resize returns
// ctx.Err() promptly. The goroutine is drain-safe because the buffered
// channel guarantees the send always succeeds.
func (c *RealChannel) Resize(ctx context.Context, cols, rows, xpixel, ypixel uint16) error {
	select {
	case <-c.done:
		return &ErrDisconnected{}
	default:
	}

	if err := ctx.Err(); err != nil {
		return err
	}

	wcMsg := ptyWindowChangeMsg{
		Columns: uint32(cols),
		Rows:    uint32(rows),
		Width:   uint32(xpixel),
		Height:  uint32(ypixel),
	}

	type result struct {
		err error
	}
	ch := make(chan result, 1)
	go func() {
		_, err := c.session.SendRequest("window-change", false, gossh.Marshal(&wcMsg))
		ch <- result{err}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return &ErrDisconnected{}
	case r := <-ch:
		return r.err
	}
}

// ---------------------------------------------------------------------------
// Wire-format message types for SSH protocol requests.
// ---------------------------------------------------------------------------

// ptyReqMsg matches RFC 4254 §6.2.
type ptyReqMsg struct {
	Term     string
	Columns  uint32
	Rows     uint32
	Width    uint32
	Height   uint32
	Modelist string
}

// ptyWindowChangeMsg matches RFC 4254 §6.7.
type ptyWindowChangeMsg struct {
	Columns uint32
	Rows    uint32
	Width   uint32
	Height  uint32
}

// buildTerminalModes returns the SSH-encoded terminal modes string.
func buildTerminalModes() string {
	buf := make([]byte, 0, 64)
	for _, m := range []struct {
		opcode byte
		value  uint32
	}{
		{gossh.ECHO, 1},
		{gossh.TTY_OP_ISPEED, 14400},
		{gossh.TTY_OP_OSPEED, 14400},
	} {
		buf = append(buf, m.opcode)
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, m.value)
		buf = append(buf, b...)
	}
	buf = append(buf, 0) // TTY_OP_END
	return string(buf)
}
