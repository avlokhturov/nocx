package tunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"

	"github.com/shady2k/nocx/internal/ssh"
)

// local implements the local (-L) strategy: a net.Listener locally, Accept,
// then one direct-tcpip channel per accepted connection to the destination,
// with a bidirectional copy (spec §7.1).
type local struct {
	conn Connector
	dest string
	bind Bind

	mu         sync.Mutex
	lease      ssh.TunnelConn
	listener   net.Listener
	streams    map[net.Conn]struct{}
	stopOnce   sync.Once
	doneCh     chan struct{}
	stopReason StopReason
	err        error
}

func newLocal(bind Bind, dest string, conn Connector) *local {
	return &local{
		conn:    conn,
		dest:    dest,
		bind:    bind,
		doneCh:  make(chan struct{}),
		streams: make(map[net.Conn]struct{}),
	}
}

// start implements strategy.start for -L.
//
// Order is the spec's trap order:
//  1. Bind before reporting — bind errors are synchronous.
//  2. No pre-check of port availability (TOCTOU); the listen is the check.
//  3. Port 0 allocates; the actual bind comes from the listener's address.
//  5. The connection lease is taken HERE, before the bind, so a bind failure
//     releases it instead of leaking a pooled reference.
func (l *local) start(ctx context.Context, host string, opts []ssh.ConnectOption) (Bind, error) {
	lease, err := l.conn.TunnelConn(ctx, host, opts...)
	if err != nil {
		return Bind{}, fmt.Errorf("tunnel: acquire connection: %w", err)
	}

	addr := net.JoinHostPort(l.bind.Host, strconv.Itoa(l.bind.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		_ = lease.Close()
		return Bind{}, err
	}

	// Publish the lease and listener atomically with a stopped check: if
	// shutdown already ran (the connection died while we were binding), it
	// could not close a listener it never saw, so do not publish at all —
	// fail the start instead of reporting success on a dead connection.
	l.mu.Lock()
	select {
	case <-l.doneCh:
		l.mu.Unlock()
		_ = lease.Close()
		_ = ln.Close()
		return Bind{}, errors.New("tunnel: connection lost before bind completed")
	default:
	}
	l.lease = lease
	l.listener = ln
	l.mu.Unlock()

	// The loss watcher starts AFTER the lease and listener are published, so
	// shutdown can always find and close them. A loss during the bind is
	// drained immediately: Done is already closed, the receive returns at
	// once and shutdown runs.
	go l.watchLoss(lease)

	hostStr, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		// Cannot happen for a TCP listener we just created, but be honest.
		_ = lease.Close()
		_ = ln.Close()
		return Bind{}, fmt.Errorf("tunnel: parse actual bind %q: %w", ln.Addr().String(), err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		_ = lease.Close()
		_ = ln.Close()
		return Bind{}, fmt.Errorf("tunnel: parse actual port %q: %w", portStr, err)
	}

	go l.acceptLoop(ln)
	return Bind{Host: hostStr, Port: port}, nil
}

// watchLoss moves the strategy to stopped: connection lost when the lease's
// transport shuts down. The tunnel never silently rebinds and never claims
// to still be running; restoration is nocx-9le.7.
func (l *local) watchLoss(lease ssh.TunnelConn) {
	<-lease.Done()
	l.shutdown(StopReasonConnectionLost, lease.LostErr())
}

// acceptLoop serves the listener until it is closed by shutdown. Each
// accepted connection is handled on its own goroutine with its own
// direct-tcpip channel (spec §7.1 trap 4).
func (l *local) acceptLoop(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			// Closed by shutdown — the strategy is done. A transient accept
			// error on a live listener is not expected for TCP; retrying
			// would spin, so stop and let the loss watcher or owner
			// conclude.
			return
		}
		l.track(c)
		go l.handle(c)
	}
}

// handle proxies one accepted local connection to the destination over its
// own direct-tcpip channel. A failing stream — the remote target refusing
// the connection — affects that stream only, never the listener.
func (l *local) handle(c net.Conn) {
	defer func() {
		l.untrack(c)
		_ = c.Close()
	}()

	l.mu.Lock()
	lease := l.lease
	l.mu.Unlock()
	if lease == nil {
		return
	}

	remote, err := lease.Dial(l.dest)
	if err != nil {
		return
	}
	defer func() { _ = remote.Close() }()

	// Bidirectional copy; when either direction ends, close both sides so
	// the other copy unblocks.
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remote, c)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(c, remote)
		done <- struct{}{}
	}()
	<-done
}

func (l *local) track(c net.Conn) {
	l.mu.Lock()
	if l.streams == nil {
		// shutdown already ran — the listener closed between Accept and
		// here, orphaning this stream. Close it and do not track it; the
		// handler (if it starts) finds no lease and returns.
		l.mu.Unlock()
		_ = c.Close()
		return
	}
	l.streams[c] = struct{}{}
	l.mu.Unlock()
}

func (l *local) untrack(c net.Conn) {
	l.mu.Lock()
	// delete on a nil map is a no-op, so a handler finishing after shutdown
	// (which nil'd the map) cannot panic.
	delete(l.streams, c)
	l.mu.Unlock()
}

// stop implements strategy.stop: the user stopped the forward.
func (l *local) stop() {
	l.shutdown(StopReasonUser, nil)
}

// shutdown is the single teardown path. stopOnce decides which reason wins
// when a user stop and a connection loss race: the first to arrive.
func (l *local) shutdown(reason StopReason, cause error) {
	l.stopOnce.Do(func() {
		l.mu.Lock()
		l.stopReason = reason
		l.err = cause
		ln := l.listener
		l.listener = nil
		streams := l.streams
		l.streams = nil
		lease := l.lease
		l.lease = nil
		l.mu.Unlock()

		if ln != nil {
			_ = ln.Close()
		}
		for s := range streams {
			_ = s.Close()
		}
		if lease != nil {
			_ = lease.Close()
		}
		close(l.doneCh)
	})
}

func (l *local) done() <-chan struct{} { return l.doneCh }

func (l *local) outcome() Outcome {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Outcome{StopReason: l.stopReason, Err: l.err}
}
