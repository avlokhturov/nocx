package connectfwd

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/tunnel"
)

// ---------------------------------------------------------------------------
// Fakes — a connector that hands out lease stand-ins, so the replay is
// exercised end to end against real listeners without an SSH server.
// ---------------------------------------------------------------------------

type fakeLease struct {
	done chan struct{}
	once sync.Once
}

func (f *fakeLease) Dial(string) (net.Conn, error) {
	return nil, errors.New("dial is not used by these tests")
}
func (f *fakeLease) Done() <-chan struct{} { return f.done }
func (f *fakeLease) LostErr() error        { return nil }
func (f *fakeLease) Close() error {
	f.once.Do(func() { close(f.done) })
	return nil
}

type fakeConnector struct {
	mu     sync.Mutex
	err    error // when set, every TunnelConn call fails (rule 3 stand-in)
	leases []*fakeLease
}

func (fc *fakeConnector) TunnelConn(_ context.Context, _ string, _ ...ssh.ConnectOption) (ssh.TunnelConn, error) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.err != nil {
		return nil, fc.err
	}
	l := &fakeLease{done: make(chan struct{})}
	fc.leases = append(fc.leases, l)
	return l, nil
}

func (fc *fakeConnector) leaseCount() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return len(fc.leases)
}

// occupyPort binds a real listener on 127.0.0.1:0 and returns the occupied
// port. The listener stays open for the test's lifetime (closed via
// t.Cleanup) — a forward requested on that port then hits a genuine
// EADDRINUSE.
func occupyPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy listener: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	_, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("parse occupy addr: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse occupy port: %v", err)
	}
	return port
}

// stopRunning stops every tunnel the replay started, so a test never leaks
// a live listener or a lease goroutine into the next test (or -race).
func stopRunning(t *testing.T, results []Result) {
	t.Helper()
	t.Cleanup(func() {
		for _, r := range results {
			if r.Tunnel != nil && r.Tunnel.State() == tunnel.StateRunning {
				r.Tunnel.Stop()
			}
		}
	})
}

func runningCount(results []Result) int {
	n := 0
	for _, r := range results {
		if r.Tunnel != nil && r.Tunnel.State() == tunnel.StateRunning {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// The replay contract (spec §8, D5)
// ---------------------------------------------------------------------------

func TestReplay_OpensEveryStoredForward(t *testing.T) {
	// A profile with two stored forwards opens both on connect, each on its
	// own pooled-connection lease, each reporting a real allocated bind.
	conn := &fakeConnector{}
	forwards := []profile.ForwardSpec{
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "db.internal:5432"},
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "api:80"},
	}

	results := Replay(context.Background(), "ssh:p1", forwards, "host.example", conn, nil)
	stopRunning(t, results)

	if len(results) != 2 {
		t.Fatalf("results = %d, want 2 (a result exists for every row)", len(results))
	}
	if n := runningCount(results); n != 2 {
		t.Fatalf("running forwards = %d, want 2", n)
	}
	for i, r := range results {
		if r.Err != nil {
			t.Errorf("result[%d].Err = %v, want nil", i, r.Err)
		}
		if r.Index != i {
			t.Errorf("result[%d].Index = %d, want %d (stored order preserved)", i, r.Index, i)
		}
		actual := r.Tunnel.Actual()
		if actual.Port == 0 {
			t.Errorf("result[%d] actual port = 0, want an allocated port", i)
		}
		if r.Tunnel.Provenance != tunnel.ProvenanceProfile {
			t.Errorf("result[%d] provenance = %q, want profile", i, r.Tunnel.Provenance)
		}
	}
	// Every forward takes its OWN lease (spec §7.3) — never the tab's.
	if got := conn.leaseCount(); got != 2 {
		t.Errorf("connector leases = %d, want 2", got)
	}
}

func TestReplay_BusyLocalPortFailsItsRowOnly(t *testing.T) {
	// A stored forward whose local port is busy at connect time fails
	// visibly and individually; the session still opens and the other
	// stored forwards still establish (spec §10.11).
	busyPort := occupyPort(t)

	conn := &fakeConnector{}
	forwards := []profile.ForwardSpec{
		{Direction: "local", BindHost: "127.0.0.1", BindPort: busyPort, Destination: "db:5432"},
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "api:80"},
	}

	results := Replay(context.Background(), "ssh:p1", forwards, "host.example", conn, nil)
	stopRunning(t, results)

	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	if results[0].Err == nil {
		t.Fatal("busy row Err = nil, want the bind failure")
	}
	if results[0].Tunnel.State() != tunnel.StateStopped {
		t.Errorf("busy row state = %s, want stopped", results[0].Tunnel.State())
	}
	if results[1].Err != nil {
		t.Errorf("free row Err = %v, want nil", results[1].Err)
	}
	if results[1].Tunnel.State() != tunnel.StateRunning {
		t.Errorf("free row state = %s, want running", results[1].Tunnel.State())
	}
}

func TestReplay_OneFailureDoesNotStopTheOthers(t *testing.T) {
	// Same shape as the nocx-6nh6 rule about one stream not killing a
	// listener, one level up: busy row first, two good rows after — both
	// still establish.
	busyPort := occupyPort(t)

	conn := &fakeConnector{}
	forwards := []profile.ForwardSpec{
		{Direction: "local", BindHost: "127.0.0.1", BindPort: busyPort, Destination: "db:5432"},
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "api:80"},
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "metrics:9090"},
	}

	results := Replay(context.Background(), "ssh:p1", forwards, "host.example", conn, nil)
	stopRunning(t, results)

	if len(results) != 3 {
		t.Fatalf("results = %d, want 3", len(results))
	}
	if n := runningCount(results); n != 2 {
		t.Errorf("running forwards = %d, want 2", n)
	}
	if results[0].Err == nil {
		t.Error("busy row Err = nil, want the bind failure")
	}
}

func TestReplay_ConnectorRefusedReportsEveryRow(t *testing.T) {
	// Every external call gets a failure test (AGENTS.md rule 3): when the
	// connection cannot be acquired, each row reports its own acquire
	// failure and nothing panics or hangs — the caller keeps the session.
	conn := &fakeConnector{err: errors.New("connection refused by policy")}
	forwards := []profile.ForwardSpec{
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "db:5432"},
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "api:80"},
	}

	results := Replay(context.Background(), "ssh:p1", forwards, "host.example", conn, nil)

	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	for i, r := range results {
		if r.Err == nil {
			t.Errorf("result[%d].Err = nil, want the acquire failure", i)
		}
	}
	if n := runningCount(results); n != 0 {
		t.Errorf("running forwards = %d, want 0", n)
	}
}

func TestReplay_PreservesAllThreeDirections(t *testing.T) {
	// D4: all three directions are in the domain model from day one and
	// nothing is thrown away between them. Remote and dynamic are not yet
	// implemented by the tunnel layer, so their rows report that as the
	// row's own outcome — never coerced to local, never dropped, never
	// allowed to stop the local row.
	conn := &fakeConnector{}
	forwards := []profile.ForwardSpec{
		{Direction: "local", BindHost: "127.0.0.1", BindPort: 0, Destination: "db:5432"},
		{Direction: "remote", BindHost: "0.0.0.0", BindPort: 9090, Destination: "127.0.0.1:3000"},
		{Direction: "dynamic", BindHost: "127.0.0.1", BindPort: 1080},
	}

	results := Replay(context.Background(), "ssh:p1", forwards, "host.example", conn, nil)
	stopRunning(t, results)

	if len(results) != 3 {
		t.Fatalf("results = %d, want 3", len(results))
	}
	if results[0].Err != nil || results[0].Tunnel.State() != tunnel.StateRunning {
		t.Fatalf("local row = %+v, want running with no error", results[0])
	}
	if results[1].Err == nil {
		t.Error("remote row Err = nil, want the not-implemented outcome")
	}
	if results[1].Spec.Direction != "remote" {
		t.Errorf("remote row direction = %q, want remote (never coerced)", results[1].Spec.Direction)
	}
	if results[2].Err == nil {
		t.Error("dynamic row Err = nil, want the not-implemented outcome")
	}
	if results[2].Spec.Direction != "dynamic" {
		t.Errorf("dynamic row direction = %q, want dynamic (never coerced)", results[2].Spec.Direction)
	}
}

func TestReplay_EmptyListIsNoRows(t *testing.T) {
	results := Replay(context.Background(), "ssh:p1", nil, "host.example", &fakeConnector{}, nil)
	if len(results) != 0 {
		t.Fatalf("results = %d, want 0 for an empty forward list", len(results))
	}
}
