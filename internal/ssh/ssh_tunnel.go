package ssh

import (
	"context"
	"errors"
	"net"
	"sync"

	gossh "golang.org/x/crypto/ssh"
)

// TunnelConn is the lease surface a forward holds on a pooled SSH connection
// (spec §7.3). The concrete implementation is *tunnelConn, returned by
// RealClient.TunnelConn; the interface exists so feature packages can fake
// the lease without a live connection, and so the connection-loss contract
// is a declared part of the API rather than an implementation detail.
type TunnelConn interface {
	// Dial opens a direct-tcpip channel to addr over the pooled connection.
	// Each call is an independent channel: one stream failing — a remote
	// target refusing the connection — never affects the connection or any
	// other stream.
	Dial(addr string) (net.Conn, error)
	// Done closes when the underlying connection shuts down: connection
	// loss, server close, keepalive failure. It does NOT close on Close: an
	// intentional stop while the connection is still shared must not read
	// as connection loss.
	Done() <-chan struct{}
	// LostErr reports why the connection shut down. Meaningful once Done
	// has closed; nil when the connection closed cleanly.
	LostErr() error
	// Close releases this lease's pooled reference. The connection stays
	// open for every other reference — tabs and other tunnels alike.
	Close() error
}

// ErrTunnelConnLost is returned by Dial after the underlying SSH connection
// has shut down.
var ErrTunnelConnLost = errors.New("ssh: tunnel connection lost")

// ErrTunnelConnClosed is returned by Dial after the lease was released by
// Close.
var ErrTunnelConnClosed = errors.New("ssh: tunnel connection closed")

// tunnelConn is the concrete TunnelConn. A forward must NOT borrow the tab's
// pool reference — closing the tab that created it would kill it, including
// when another tab is using the forward. This lease holds its own reference:
// it is released exactly once (by Close, or by the loss watcher), and the
// underlying connection closes when the LAST reference — tabs and forwards
// alike — releases.
type tunnelConn struct {
	client *gossh.Client

	// done closes on transport shutdown (the loss signal); closed closes on
	// Close. Dial fails after either.
	done   chan struct{}
	closed chan struct{}

	release func()
	// releaseOnce drops the pool reference exactly once whichever path
	// fires first: Close or the loss watcher.
	releaseOnce sync.Once
	closeOnce   sync.Once

	// lostErr is written by the watcher before done closes, so reading it
	// after <-done is ordered by the channel close.
	lostErr error
}

// newTunnelConn wires a lease. release drops this lease's pool reference
// (pool.Release is already idempotent per handle; the once guard keeps the
// watcher and Close from double-firing the callback).
func newTunnelConn(client *gossh.Client, release func()) *tunnelConn {
	tc := &tunnelConn{
		client:  client,
		done:    make(chan struct{}),
		closed:  make(chan struct{}),
		release: release,
	}
	// One watcher per lease: gossh.Client.Wait returns when the transport
	// shuts down. mux.Wait is cond-var guarded, so this is safe alongside
	// the client's own internal waiter and other leases' watchers on the
	// same connection. Report loss and drop our reference so a dead entry
	// cannot linger behind an unreleased lease; Release is a no-op if Close
	// already ran.
	go func() {
		tc.lostErr = client.Wait()
		close(tc.done)
		tc.releaseOnce.Do(func() {
			if tc.release != nil {
				tc.release()
			}
		})
	}()
	return tc
}

// Dial opens a direct-tcpip channel to addr over the pooled connection.
//
// closed is checked before done — sequentially, not in one select: when the
// lease was explicitly closed AND the connection died (closing the last ref
// does both), a select would pick between two ready cases at random. The
// lease's own state is the deterministic answer: a spent lease reports the
// closed error.
func (c *tunnelConn) Dial(addr string) (net.Conn, error) {
	select {
	case <-c.closed:
		return nil, ErrTunnelConnClosed
	default:
	}
	select {
	case <-c.done:
		return nil, ErrTunnelConnLost
	default:
	}
	return c.client.Dial("tcp", addr)
}

func (c *tunnelConn) Done() <-chan struct{} { return c.done }

func (c *tunnelConn) LostErr() error {
	select {
	case <-c.done:
		return c.lostErr
	default:
		return nil
	}
}

// Close releases this lease's pooled reference.
func (c *tunnelConn) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		c.releaseOnce.Do(func() {
			if c.release != nil {
				c.release()
			}
		})
	})
	return nil
}

// TunnelConn acquires an owned lease on the pooled SSH connection for host,
// for a forward. It takes its OWN pooled reference (spec §7.3): the tab's
// closing the creating tab can never kill a forward another tab is using.
// Release the lease with Close when the forward stops; on connection loss
// the lease releases itself and Done closes.
//
// The same connection configuration (credentials, keys, jump route) as a
// Connect to host is resolved and authorized: a forward is bound by the same
// credential authorization as a tab, and shares the tab's connection when
// the pool key matches (AD-4).
func (rc *RealClient) TunnelConn(ctx context.Context, host string, opts ...ConnectOption) (TunnelConn, error) {
	acq, err := rc.acquirePooled(ctx, host, opts)
	if err != nil {
		return nil, err
	}
	return newTunnelConn(acq.client, func() { rc.pool.Release(acq.handle) }), nil
}
