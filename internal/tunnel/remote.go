package tunnel

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"

	"github.com/shady2k/nocx/internal/ssh"
)

// remote implements the remote (-R) strategy: a listener on the REMOTE host,
// opened via the connection's tcpip-forward request and governed by the
// server's AllowTcpForwarding / PermitListen policy (spec §7.2). An arriving
// connection is dialed LOCALLY — OpenSSH -R resolves the destination on the
// client's network — and relayed.
//
// The bound HOST is never verified. The tcpip-forward reply confirms only
// the port; OpenSSH with GatewayPorts=no silently rebinds a non-loopback
// request to loopback and still reports success, and the protocol gives the
// client no way to see what the server actually bound (spec §7.2). The
// reported actual bind therefore carries the transport's answer — the
// requested address, or 0.0.0.0 for a hostname — and callers must not
// present it as a guarantee that the requested address was bound.
type remote struct {
	conn Connector
	bind Bind
	dest string
	fl   *forwardLifecycle
}

func newRemote(bind Bind, dest string, conn Connector) *remote {
	return &remote{
		conn: conn,
		bind: bind,
		dest: dest,
		fl:   newForwardLifecycle(),
	}
}

// start implements strategy.start for -R. Same trap order as -L: bind before
// reporting, no pre-check, port 0 resolved by the far end and reported from
// the listener's address, the lease acquired before the bind so a failure
// releases it.
//
// A refused listen — AllowTcpForwarding off, or the bind outside
// PermitListen — surfaces the server's refusal with the policy context, not
// a generic failure: the two refusals are indistinguishable on the wire, so
// the reason names both and says another bind may work.
func (r *remote) start(ctx context.Context, host string, opts []ssh.ConnectOption) (Bind, error) {
	lease, err := r.conn.TunnelConn(ctx, host, opts...)
	if err != nil {
		return Bind{}, fmt.Errorf("tunnel: acquire connection: %w", err)
	}

	addr := net.JoinHostPort(r.bind.Host, strconv.Itoa(r.bind.Port))
	ln, err := lease.Listen(addr)
	if err != nil {
		_ = lease.Close()
		return Bind{}, fmt.Errorf("tunnel: remote listen %s refused by server: %w: "+
			"the server's AllowTcpForwarding may be off, or the bind is not permitted "+
			"by PermitListen — another address or port may work", addr, err)
	}
	if !r.fl.publish(lease, ln) {
		_ = lease.Close()
		_ = ln.Close()
		return Bind{}, errors.New("tunnel: connection lost before bind completed")
	}

	// The loss watcher starts AFTER the lease and listener are published, so
	// shutdown can always find and close them (see publish).
	go r.fl.watchLoss(lease)

	// The listener's address carries the port the server actually allocated
	// (a requested 0 comes back as the real port). The host is the
	// transport's answer, never a verified bind — see the type comment.
	hostStr, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		r.fl.shutdown(StopReasonError, err)
		return Bind{}, fmt.Errorf("tunnel: parse actual bind %q: %w", ln.Addr().String(), err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		r.fl.shutdown(StopReasonError, err)
		return Bind{}, fmt.Errorf("tunnel: parse actual port %q: %w", portStr, err)
	}

	// Arriving remote connections are dialed from THIS machine (OpenSSH -R:
	// the destination is "on the local side"), then relayed.
	go r.fl.serve(ln, func(c net.Conn) {
		r.fl.proxy(c, r.dest, func(addr string) (net.Conn, error) { return net.Dial("tcp", addr) })
	})
	return Bind{Host: hostStr, Port: port}, nil
}

// caveat implements strategy.caveat: a success-time caution for a requested
// non-loopback bind. The tcpip-forward reply confirms only the port; the
// host the server actually bound is never verifiable from the wire
// (GatewayPorts=no silently rebinds a non-loopback request to loopback and
// still succeeds), so a URL built from the reported actual bind may only
// work on the server. A loopback request needs no caveat — under every
// policy the bind is loopback. Nothing failed here; this is a disclosure,
// not an error.
func (r *remote) caveat() string {
	if isLoopbackHost(r.bind.Host) {
		return ""
	}
	return fmt.Sprintf(
		"bind address %s requested but not verified: the server may have bound "+
			"a different address (GatewayPorts), so a URL built from this forward "+
			"may only work on the server",
		r.bind.Host,
	)
}

// isLoopbackHost classifies a requested bind host as loopback. "localhost"
// is loopback by convention even though it is not an IP; any other hostname
// is conservatively NOT loopback — a hostname bind is exactly the case the
// caveat exists for, because the client cannot see what the server bound.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// stop implements strategy.stop: the user stopped the forward.
func (r *remote) stop() {
	r.fl.shutdown(StopReasonUser, nil)
}

func (r *remote) done() <-chan struct{} { return r.fl.done() }

func (r *remote) outcome() Outcome { return r.fl.outcome() }
