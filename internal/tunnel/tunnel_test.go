package tunnel_test

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/tunnel"
)

// Compile-time proof that the production SSH client satisfies the tunnel's
// connector seam directly — the future app wiring needs no adapter.
var _ tunnel.Connector = (*ssh.RealClient)(nil)

// ---------------------------------------------------------------------------
// Fake connector: models the pooled-connection semantics the strategies
// depend on — one shared connection per host, a lease per forward, refcounted
// lifetime, and a transport-loss path that closes every lease's Done and
// releases its reference.
// ---------------------------------------------------------------------------

type fakeConn struct {
	mu     sync.Mutex
	refs   int
	leases []*fakeLease
	dialFn func(addr string) (net.Conn, error)
}

func (fc *fakeConn) acquire() *fakeLease {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fl := &fakeLease{conn: fc, done: make(chan struct{}), closed: make(chan struct{})}
	fc.leases = append(fc.leases, fl)
	fc.refs++
	return fl
}

func (fc *fakeConn) refCount() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return fc.refs
}

func (fc *fakeConn) release() {
	fc.mu.Lock()
	fc.refs--
	fc.mu.Unlock()
}

// lose simulates transport death: every lease's Done closes and its
// reference drops, mirroring the real per-lease loss watchers.
func (fc *fakeConn) lose() {
	fc.mu.Lock()
	leases := fc.leases
	fc.leases = nil
	fc.mu.Unlock()
	for _, fl := range leases {
		fl.lost()
	}
}

type fakeLease struct {
	conn *fakeConn

	done       chan struct{} // closed on transport loss
	closed     chan struct{} // closed on Close
	closeOnce  sync.Once
	lostOnce   sync.Once
	releaseRef sync.Once
	lostErr    error
}

var _ ssh.TunnelConn = (*fakeLease)(nil)

func (fl *fakeLease) Dial(addr string) (net.Conn, error) {
	select {
	case <-fl.done:
		return nil, errors.New("ssh: tunnel connection lost")
	case <-fl.closed:
		return nil, errors.New("ssh: tunnel connection closed")
	default:
	}
	return fl.conn.dialFn(addr)
}

func (fl *fakeLease) Done() <-chan struct{} { return fl.done }

func (fl *fakeLease) LostErr() error {
	select {
	case <-fl.done:
		return fl.lostErr
	default:
		return nil
	}
}

func (fl *fakeLease) Close() error {
	fl.closeOnce.Do(func() {
		close(fl.closed)
		fl.releaseRef.Do(func() { fl.conn.release() })
	})
	return nil
}

func (fl *fakeLease) lost() {
	fl.lostOnce.Do(func() {
		fl.lostErr = errors.New("simulated connection reset by peer")
		close(fl.done)
		fl.releaseRef.Do(func() { fl.conn.release() })
	})
}

type fakeConnector struct {
	mu     sync.Mutex
	conns  map[string]*fakeConn
	calls  int
	dialFn func(addr string) (net.Conn, error)
}

var _ tunnel.Connector = (*fakeConnector)(nil)

func newFakeConnector() *fakeConnector {
	return &fakeConnector{
		conns:  make(map[string]*fakeConn),
		dialFn: func(addr string) (net.Conn, error) { return net.Dial("tcp", addr) },
	}
}

func (fc *fakeConnector) TunnelConn(_ context.Context, host string, _ ...ssh.ConnectOption) (ssh.TunnelConn, error) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.calls++
	c := fc.conns[host]
	if c == nil {
		c = &fakeConn{dialFn: fc.dialFn}
		fc.conns[host] = c
	}
	return c.acquire(), nil
}

func (fc *fakeConnector) conn(host string) *fakeConn {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return fc.conns[host]
}

// setDial scripts the "remote target" behaviour for every connection.
func (fc *fakeConnector) setDial(fn func(addr string) (net.Conn, error)) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.dialFn = fn
	for _, c := range fc.conns {
		c.dialFn = fn
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// echoTarget listens on a loopback port and echoes every accepted connection
// back, standing in for the remote destination of a forward.
func echoTarget(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo target listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln.Addr().String()
}

func startTunnel(t *testing.T, spec tunnel.Spec, fc *fakeConnector) *tunnel.Tunnel {
	t.Helper()
	tun, err := tunnel.New(spec, fc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tun
}

// roundTrip writes payload through the tunnel's local listener and reads the
// echo back, proving accept → direct-tcpip → copy end to end.
func roundTrip(t *testing.T, tun *tunnel.Tunnel, payload string) {
	t.Helper()
	addr := net.JoinHostPort(tun.Actual().Host, itoa(tun.Actual().Port))
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial local listener: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("write through tunnel: %v", err)
	}
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read through tunnel: %v", err)
	}
	if string(buf) != payload {
		t.Fatalf("round trip = %q, want %q", buf, payload)
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

func waitDone(t *testing.T, tun *tunnel.Tunnel) {
	t.Helper()
	select {
	case <-tun.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("tunnel Done did not close within 5s")
	}
}

// ---------------------------------------------------------------------------
// model validation
// ---------------------------------------------------------------------------

func TestNew_Validation(t *testing.T) {
	fc := newFakeConnector()

	tests := []struct {
		name string
		spec tunnel.Spec
		want string
	}{
		{"empty direction", tunnel.Spec{}, "direction is required"},
		{"unknown direction", tunnel.Spec{Direction: tunnel.Direction("sideways")}, "unknown direction"},
		{"local without destination", tunnel.Spec{Direction: tunnel.DirectionLocal}, "destination is required"},
		{"local with bare destination", tunnel.Spec{Direction: tunnel.DirectionLocal, Destination: "localhost"}, "invalid local destination"},
		{"remote without destination", tunnel.Spec{Direction: tunnel.DirectionRemote}, "destination is required"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tunnel.New(tt.spec, fc)
			if err == nil {
				t.Fatal("New: expected error, got nil")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("New error = %q, want substring %q", err, tt.want)
			}
		})
	}

	if _, err := tunnel.New(tunnel.Spec{Direction: tunnel.DirectionLocal, Destination: "127.0.0.1:1"}, nil); err == nil {
		t.Fatal("New with nil connector: expected error, got nil")
	}
}

// ---------------------------------------------------------------------------
// traps 1-3: bind before reporting, no pre-check, port 0 reports the actual
// ---------------------------------------------------------------------------

// TestLocal_EADDRINUSE_Synchronous proves trap 1: a busy local port fails
// synchronously from Start with the OS error — never a later goroutine
// discovery — and the acquired connection lease is released (no leaked pooled
// reference).
func TestLocal_EADDRINUSE_Synchronous(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("busy listen: %v", err)
	}
	defer func() { _ = busy.Close() }()
	tcpAddr, ok := busy.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("busy listener address is not TCP: %T", busy.Addr())
	}
	busyPort := tcpAddr.Port

	fc := newFakeConnector()
	tun := startTunnel(t, tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
		Bind:        tunnel.Bind{Port: busyPort},
	}, fc)

	err = tun.Start(context.Background(), "example.com")
	if err == nil {
		t.Fatal("Start on busy port: expected error, got nil")
	}
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("Start error = %v, want EADDRINUSE", err)
	}
	if got := tun.State(); got != tunnel.StateStopped {
		t.Fatalf("state = %q, want stopped", got)
	}
	if got := tun.StopReason(); got != tunnel.StopReasonError {
		t.Fatalf("stop reason = %q, want error", got)
	}
	waitDone(t, tun)

	// The lease was acquired once and released on the bind failure — the
	// pool reference must not leak.
	if got := fc.calls; got != 1 {
		t.Fatalf("connector calls = %d, want 1", got)
	}
	if got := fc.conn("example.com").refCount(); got != 0 {
		t.Fatalf("refcount after failed start = %d, want 0 (lease released)", got)
	}

	// A stopped tunnel cannot restart (spec §7.3: no silent rebind).
	if err := tun.Start(context.Background(), "example.com"); err == nil {
		t.Fatal("Start after stop: expected error, got nil")
	}
}

// TestLocal_PortZeroReportsActualPort proves traps 2 and 3: no pre-checking
// (the listen is the check), and port 0 binds an ephemeral port that is
// reported as the ACTUAL port — never left as 0. Default bind is loopback.
func TestLocal_PortZeroReportsActualPort(t *testing.T) {
	fc := newFakeConnector()
	tun := startTunnel(t, tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
		Bind:        tunnel.Bind{Port: 0},
	}, fc)

	if err := tun.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := tun.State(); got != tunnel.StateRunning {
		t.Fatalf("state = %q, want running", got)
	}
	actual := tun.Actual()
	if actual.Port == 0 {
		t.Fatal("actual port = 0, want an OS-assigned port")
	}
	if actual.Host != tunnel.DefaultLocalHost {
		t.Fatalf("actual host = %q, want default %q", actual.Host, tunnel.DefaultLocalHost)
	}

	roundTrip(t, tun, "hello through the tunnel")

	tun.Stop()
	if got := tun.State(); got != tunnel.StateStopped {
		t.Fatalf("state after stop = %q, want stopped", got)
	}
	if got := tun.StopReason(); got != tunnel.StopReasonUser {
		t.Fatalf("stop reason = %q, want user", got)
	}
	waitDone(t, tun)

	// The listener is really closed after a user stop.
	if _, err := net.DialTimeout("tcp", net.JoinHostPort(actual.Host, itoa(actual.Port)), 500*time.Millisecond); err == nil {
		t.Fatal("listener still accepting after stop")
	}
}

// ---------------------------------------------------------------------------
// trap 4: one stream failing must not kill the listener
// ---------------------------------------------------------------------------

// TestLocal_RefusedRemoteLeavesListenerAlive proves the remote target
// refusing a connection affects that stream only: the listener survives and
// the next connection forwards normally.
func TestLocal_RefusedRemoteLeavesListenerAlive(t *testing.T) {
	fc := newFakeConnector()
	refusals := 0
	fc.setDial(func(addr string) (net.Conn, error) {
		if refusals < 1 {
			refusals++
			return nil, errors.New("connection refused")
		}
		return net.Dial("tcp", addr)
	})

	tun := startTunnel(t, tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
		Bind:        tunnel.Bind{Port: 0},
	}, fc)
	if err := tun.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// First connection: the remote target refuses; the stream dies, but the
	// listener must keep serving.
	addr := net.JoinHostPort(tun.Actual().Host, itoa(tun.Actual().Port))
	first, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial local listener: %v", err)
	}
	_, _ = first.Write([]byte("doomed"))
	firstBuf := make([]byte, 1)
	if _, rerr := first.Read(firstBuf); rerr == nil {
		t.Fatal("refused stream: expected the stream to fail, got data")
	}
	_ = first.Close()

	// The listener survived: the next connection round-trips.
	second, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial local listener after refused stream: %v", err)
	}
	defer func() { _ = second.Close() }()
	if _, err := second.Write([]byte("ping")); err != nil {
		t.Fatalf("write after refused stream: %v", err)
	}
	secondBuf := make([]byte, 4)
	if _, err := io.ReadFull(second, secondBuf); err != nil {
		t.Fatalf("read after refused stream: %v", err)
	}
	if string(secondBuf) != "ping" {
		t.Fatalf("second round trip = %q, want %q", secondBuf, "ping")
	}

	if got := tun.State(); got != tunnel.StateRunning {
		t.Fatalf("state = %q, want running (refused stream must not kill the forward)", got)
	}
	tun.Stop()
}

// ---------------------------------------------------------------------------
// trap 5 + §7.3: own pooled handle, tab teardown isolates
// ---------------------------------------------------------------------------

// TestLocal_TwoTunnelsShareConnection_OneStopDoesNotKillTheOther is the
// ownership invariant at the model level: two forwards on one shared
// connection each hold their OWN lease. Stopping one releases only its lease;
// the connection stays up for the other, which keeps forwarding.
func TestLocal_TwoTunnelsShareConnection_OneStopDoesNotKillTheOther(t *testing.T) {
	fc := newFakeConnector()
	target := echoTarget(t)

	spec := tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: target,
		Bind:        tunnel.Bind{Port: 0},
	}
	tunA := startTunnel(t, spec, fc)
	tunB := startTunnel(t, spec, fc)

	if err := tunA.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start A: %v", err)
	}
	if err := tunB.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start B: %v", err)
	}
	if got := fc.conn("example.com").refCount(); got != 2 {
		t.Fatalf("refcount with two tunnels = %d, want 2", got)
	}

	// Tab A closes (simulated by stopping tunnel A): only A's lease is
	// released. The shared connection stays up and B keeps forwarding.
	tunA.Stop()
	if got := fc.conn("example.com").refCount(); got != 1 {
		t.Fatalf("refcount after A stop = %d, want 1 (B still holds the connection)", got)
	}
	roundTrip(t, tunB, "B still forwards after A stopped")

	// B's stop releases the last reference.
	tunB.Stop()
	if got := fc.conn("example.com").refCount(); got != 0 {
		t.Fatalf("refcount after B stop = %d, want 0", got)
	}
}

// ---------------------------------------------------------------------------
// §7.3: connection loss
// ---------------------------------------------------------------------------

// TestLocal_ConnectionLoss_StoppedConnectionLost proves transport death moves
// the tunnel to stopped: connection lost — it never silently rebinds and
// never claims to be running. The listener is really closed, and a restart
// attempt is refused.
func TestLocal_ConnectionLoss_StoppedConnectionLost(t *testing.T) {
	fc := newFakeConnector()
	tun := startTunnel(t, tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
		Bind:        tunnel.Bind{Port: 0},
	}, fc)
	if err := tun.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	actual := tun.Actual()

	fc.conn("example.com").lose()

	waitDone(t, tun)
	if got := tun.State(); got != tunnel.StateStopped {
		t.Fatalf("state = %q, want stopped", got)
	}
	if got := tun.StopReason(); got != tunnel.StopReasonConnectionLost {
		t.Fatalf("stop reason = %q, want %q", got, tunnel.StopReasonConnectionLost)
	}
	if tun.Err() == nil {
		t.Fatal("Err = nil after connection loss, want the transport error")
	}

	// The listener is closed — the tunnel is not silently rebinding.
	if _, err := net.DialTimeout("tcp", net.JoinHostPort(actual.Host, itoa(actual.Port)), 500*time.Millisecond); err == nil {
		t.Fatal("listener still accepting after connection loss")
	}

	// No restart (restoration belongs to nocx-9le.7).
	if err := tun.Start(context.Background(), "example.com"); err == nil {
		t.Fatal("Start after connection loss: expected error, got nil")
	}

	// The lease released its reference on loss.
	if got := fc.conn("example.com").refCount(); got != 0 {
		t.Fatalf("refcount after loss = %d, want 0", got)
	}
}

// TestLocal_ConnectionLoss_OtherTunnelSurvives? — a connection loss is
// transport-wide: every forward on the dead connection stops. That is
// covered at the ssh layer (killConns); here the fake models it by closing
// every lease. Assert both tunnels stop when the shared connection dies.
func TestLocal_ConnectionLoss_StopsEveryTunnelOnTheConnection(t *testing.T) {
	fc := newFakeConnector()
	spec := tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
		Bind:        tunnel.Bind{Port: 0},
	}
	tunA := startTunnel(t, spec, fc)
	tunB := startTunnel(t, spec, fc)
	if err := tunA.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start A: %v", err)
	}
	if err := tunB.Start(context.Background(), "example.com"); err != nil {
		t.Fatalf("Start B: %v", err)
	}

	fc.conn("example.com").lose()

	waitDone(t, tunA)
	waitDone(t, tunB)
	if got := tunA.StopReason(); got != tunnel.StopReasonConnectionLost {
		t.Fatalf("A stop reason = %q, want connection lost", got)
	}
	if got := tunB.StopReason(); got != tunnel.StopReasonConnectionLost {
		t.Fatalf("B stop reason = %q, want connection lost", got)
	}
}

// ---------------------------------------------------------------------------
// remote / dynamic are in the model but not implemented
// ---------------------------------------------------------------------------

func TestStart_RemoteAndDynamicNotImplemented(t *testing.T) {
	for _, dir := range []tunnel.Direction{tunnel.DirectionRemote, tunnel.DirectionDynamic} {
		t.Run(string(dir), func(t *testing.T) {
			fc := newFakeConnector()
			tun := startTunnel(t, tunnel.Spec{
				Direction:   dir,
				Destination: "127.0.0.1:80", // remote needs one; dynamic ignores it
				Bind:        tunnel.Bind{Port: 0},
			}, fc)
			err := tun.Start(context.Background(), "example.com")
			if err == nil {
				t.Fatal("Start: expected not-implemented error, got nil")
			}
			if got := tun.State(); got != tunnel.StateStopped {
				t.Fatalf("state = %q, want stopped", got)
			}
			if got := tun.StopReason(); got != tunnel.StopReasonError {
				t.Fatalf("stop reason = %q, want error", got)
			}
			waitDone(t, tun)
		})
	}
}

// TestStopBeforeStartIsSafe: Stop on a never-started tunnel must not panic
// and must leave the record stopped.
func TestStopBeforeStartIsSafe(t *testing.T) {
	fc := newFakeConnector()
	tun := startTunnel(t, tunnel.Spec{
		Direction:   tunnel.DirectionLocal,
		Destination: echoTarget(t),
	}, fc)
	tun.Stop()
	if got := tun.State(); got != tunnel.StateStopped {
		t.Fatalf("state = %q, want stopped", got)
	}
	waitDone(t, tun)
}
