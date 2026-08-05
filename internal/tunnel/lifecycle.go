package tunnel

import (
	"io"
	"net"
	"sync"

	"github.com/shady2k/nocx/internal/ssh"
)

// forwardLifecycle is the part every strategy shares (spec §7.3): an owned
// connection lease, a bound listener, the in-flight streams, and ONE teardown
// path that closes all three and reports the winning stop reason. The
// strategies differ only in where the listener lives and what happens to an
// accepted connection — the local (-L) and remote (-R) strategies proxy to a
// fixed destination (via the lease for -L, locally for -R), the dynamic (-D)
// strategy negotiates SOCKS5 — never in this machinery.
type forwardLifecycle struct {
	mu         sync.Mutex
	lease      ssh.TunnelConn
	listener   net.Listener
	streams    map[net.Conn]struct{}
	stopOnce   sync.Once
	doneCh     chan struct{}
	stopReason StopReason
	err        error
}

func newForwardLifecycle() *forwardLifecycle {
	return &forwardLifecycle{
		doneCh:  make(chan struct{}),
		streams: make(map[net.Conn]struct{}),
	}
}

// publish records the lease and listener atomically with a stopped check: if
// shutdown already ran (the connection died while the strategy was binding),
// it could not close a listener it never saw, so do not publish at all —
// fail the start instead of reporting success on a dead connection.
func (fl *forwardLifecycle) publish(lease ssh.TunnelConn, ln net.Listener) bool {
	fl.mu.Lock()
	defer fl.mu.Unlock()
	select {
	case <-fl.doneCh:
		return false
	default:
	}
	fl.lease = lease
	fl.listener = ln
	return true
}

// watchLoss moves the strategy to stopped: connection lost when the lease's
// transport shuts down. The tunnel never silently rebinds and never claims
// to still be running; restoration is nocx-9le.7. It starts AFTER publish,
// so shutdown can always find and close the lease and listener; a loss
// during the bind is drained immediately — Done is already closed, the
// receive returns at once and shutdown runs.
func (fl *forwardLifecycle) watchLoss(lease ssh.TunnelConn) {
	<-lease.Done()
	fl.shutdown(StopReasonConnectionLost, lease.LostErr())
}

// serve runs the accept loop until the listener closes. The listener is
// passed in — never re-read from the lifecycle — because shutdown nil's the
// stored listener and then closes it, and the loop must keep calling Accept
// on the SAME object to observe the close. Each accepted connection is
// tracked and handed to the strategy's handler on its own goroutine (spec
// §7.1 trap 4: one failing stream never kills the listener).
func (fl *forwardLifecycle) serve(ln net.Listener, handler func(net.Conn)) {
	for {
		c, err := ln.Accept()
		if err != nil {
			// Closed by shutdown — the strategy is done. A transient accept
			// error on a live listener is not expected for TCP; retrying
			// would spin, so stop and let the loss watcher or owner
			// conclude.
			return
		}
		fl.track(c)
		go handler(c)
	}
}

// proxy proxies one accepted connection to dest via dial, then relays bytes
// until either side ends. dial is the strategy's path: -L dials through the
// SSH connection (dest resolves on the server's network), -R dials locally
// (OpenSSH -R resolves dest on the client's network). A failing stream —
// the target refusing — affects that stream only, never the listener.
func (fl *forwardLifecycle) proxy(c net.Conn, dest string, dial func(addr string) (net.Conn, error)) {
	defer func() {
		fl.untrack(c)
		_ = c.Close()
	}()

	fl.mu.Lock()
	lease := fl.lease
	fl.mu.Unlock()
	if lease == nil {
		// shutdown already ran — the listener closed between Accept and
		// here, orphaning this stream. Do not dial on a dead forward.
		return
	}

	remote, err := dial(dest)
	if err != nil {
		return
	}
	defer func() { _ = remote.Close() }()

	fl.relay(c, remote)
}

// relay copies bytes both ways; when either direction ends, close both sides
// so the other copy unblocks.
func (fl *forwardLifecycle) relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(b, a)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(a, b)
		done <- struct{}{}
	}()
	<-done
}

func (fl *forwardLifecycle) track(c net.Conn) {
	fl.mu.Lock()
	if fl.streams == nil {
		// shutdown already ran — the listener closed between Accept and
		// here, orphaning this stream. Close it and do not track it; the
		// handler (if it starts) finds no lease and returns.
		fl.mu.Unlock()
		_ = c.Close()
		return
	}
	fl.streams[c] = struct{}{}
	fl.mu.Unlock()
}

func (fl *forwardLifecycle) untrack(c net.Conn) {
	fl.mu.Lock()
	// delete on a nil map is a no-op, so a handler finishing after shutdown
	// (which nil'd the map) cannot panic.
	delete(fl.streams, c)
	fl.mu.Unlock()
}

// shutdown is the single teardown path. stopOnce decides which reason wins
// when a user stop and a connection loss race: the first to arrive.
func (fl *forwardLifecycle) shutdown(reason StopReason, cause error) {
	fl.stopOnce.Do(func() {
		fl.mu.Lock()
		fl.stopReason = reason
		fl.err = cause
		ln := fl.listener
		fl.listener = nil
		streams := fl.streams
		fl.streams = nil
		lease := fl.lease
		fl.lease = nil
		fl.mu.Unlock()

		if ln != nil {
			_ = ln.Close()
		}
		for s := range streams {
			_ = s.Close()
		}
		if lease != nil {
			_ = lease.Close()
		}
		close(fl.doneCh)
	})
}

func (fl *forwardLifecycle) done() <-chan struct{} { return fl.doneCh }

func (fl *forwardLifecycle) outcome() Outcome {
	fl.mu.Lock()
	defer fl.mu.Unlock()
	return Outcome{StopReason: fl.stopReason, Err: fl.err}
}
