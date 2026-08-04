package discovery

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
)

// ---------------------------------------------------------------------------
// Scripted fake connector — the scheduler acquires one fakeConn per sample
// pass that actually reaches a lease, exactly like the production connector
// (ssh.RealClient) hands out leases. queueConn pre-scripts the NEXT
// acquisition (a refusal, a loss) instead of pre-seeding a list the scheduler
// never reads.
// ---------------------------------------------------------------------------

type fakeConnector struct {
	mu     sync.Mutex
	conns  []*fakeConn
	queued []*fakeConn
	err    error
	// autoValid answers every exec on FRESH conns with a valid "normal
	// host" sample. queueConn'd conns are scripted by hand and skip this.
	autoValid bool
}

func (c *fakeConnector) DiscoveryConn(_ context.Context, _ string, _ ...ssh.ConnectOption) (ssh.DiscoveryConn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return nil, c.err
	}
	if len(c.queued) > 0 {
		f := c.queued[0]
		c.queued = c.queued[1:]
		c.conns = append(c.conns, f)
		return f, nil
	}
	f := newFakeConn()
	f.autoValid = c.autoValid
	c.conns = append(c.conns, f)
	return f, nil
}

// queueConn hands the next acquisition a pre-scripted conn.
func (c *fakeConnector) queueConn(f *fakeConn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queued = append(c.queued, f)
}

func (c *fakeConnector) acquired() []*fakeConn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*fakeConn(nil), c.conns...)
}

func (c *fakeConnector) execCount() int {
	n := 0
	for _, f := range c.acquired() {
		n += len(f.commands())
	}
	return n
}

// testScheduler builds a scheduler with tiny cadence for tests and a
// t.Cleanup Close. Cadence is scaled down so a test asserts on wall time in
// milliseconds instead of seconds.
func testScheduler(t *testing.T, conn *fakeConnector, opts ...SchedulerOption) *Scheduler {
	t.Helper()
	base := []SchedulerOption{
		WithSettleDelay(10 * time.Millisecond),
		WithPromptDebounce(15 * time.Millisecond),
		WithSampleInterval(25 * time.Millisecond),
	}
	conn.autoValid = true
	s := NewScheduler(conn, log.NewSlogAdapter(nil), append(base, opts...)...)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestScheduler_SettleSampleAfterConnectionUp(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn, WithSettleDelay(20*time.Millisecond))

	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())

	// One sample must run once the settle delay passes — the panel that
	// samples instantly shows an empty host (spec §4).
	waitFor(t, "settle sample to run", func() bool { return conn.execCount() == 1 })
	time.Sleep(60 * time.Millisecond)
	if got := conn.execCount(); got != 1 {
		t.Fatalf("exec count after settle = %d, want exactly 1", got)
	}
	st := s.Status("ssh:p1:1")
	if st.Sample.State != StateAvailable {
		t.Fatalf("state after settle = %q, want %q", st.Sample.State, StateAvailable)
	}
	if st.Host != "host.example" {
		t.Fatalf("status host = %q, want %q", st.Host, "host.example")
	}
}

func TestScheduler_PromptDebounceCoalesces(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	// A user hammering Enter must not queue probes: five rapid hints
	// produce exactly ONE debounced sample.
	for range 5 {
		s.PromptHint("ssh:p1:1")
		time.Sleep(2 * time.Millisecond)
	}
	waitFor(t, "debounced sample", func() bool { return conn.execCount() == 2 })
	time.Sleep(60 * time.Millisecond)
	if got := conn.execCount(); got != 2 {
		t.Fatalf("exec count after 5 prompt hints = %d, want exactly 2 (settle + one debounced)", got)
	}
}

func TestScheduler_PromptHintsWhileSamplingCoalesceToOne(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	f := conn.acquired()[0]
	block := make(chan struct{})
	f.block = block

	// One hint starts a debounced sample that blocks on the remote exec.
	s.PromptHint("ssh:p1:1")
	waitFor(t, "blocked sample to start", func() bool { return conn.execCount() == 2 })

	// More hints while the sample is in flight: at most one follow-up.
	for range 5 {
		s.PromptHint("ssh:p1:1")
	}
	close(block)

	// settle + blocked sample + exactly one coalesced follow-up.
	waitFor(t, "coalesced follow-up sample", func() bool { return conn.execCount() == 3 })
	time.Sleep(80 * time.Millisecond)
	if got := conn.execCount(); got != 3 {
		t.Fatalf("exec count = %d, want exactly 3 (settle + blocked + one coalesced)", got)
	}
}

func TestScheduler_HiddenTabStopsPeriodicSampling(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	// No watcher yet: periodic sampling must NOT run — a background poll
	// with nobody rendering it is the defect this cadence exists to avoid.
	time.Sleep(120 * time.Millisecond)
	if got := conn.execCount(); got != 1 {
		t.Fatalf("exec count with no visible watcher = %d, want 1 (settle only)", got)
	}

	// Panel opens: periodic sampling starts.
	s.SetVisible("ssh:p1:1", true)
	waitFor(t, "periodic samples", func() bool { return conn.execCount() >= 3 })

	// Panel hides: periodic sampling stops. Snapshot the count first — a
	// timer that already fired before the hide may legitimately land one
	// more sample.
	beforeHide := conn.execCount()
	s.SetVisible("ssh:p1:1", false)
	time.Sleep(80 * time.Millisecond)
	if got := conn.execCount(); got != beforeHide {
		t.Fatalf("exec count after hide = %d, want %d (no periodic samples while hidden)", got, beforeHide)
	}
}

func TestScheduler_PauseSuppressesAutomaticSamples(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	s.SetPaused("ssh:p1:1", true)

	// A prompt hint and a reconnect must both be suppressed while paused.
	s.PromptHint("ssh:p1:1")
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	time.Sleep(100 * time.Millisecond)
	if got := conn.execCount(); got != 1 {
		t.Fatalf("exec count while paused = %d, want 1", got)
	}

	// Resume restores automatic sampling.
	s.SetPaused("ssh:p1:1", false)
	waitFor(t, "sample after resume", func() bool { return conn.execCount() >= 2 })
}

func TestScheduler_SampleNowActsAsRetry(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)

	// First sample: the server refuses the extra session (MaxSessions 1).
	f0 := newFakeConn()
	f0.queue(fakeResponse{err: ssh.ErrExecSessionRefused})
	conn.queueConn(f0)

	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "refused sample", func() bool { return conn.execCount() == 1 })
	st := s.Status("ssh:p1:1")
	if st.Sample.State != StatePermissionOrPolicyRefused {
		t.Fatalf("state after refusal = %q, want %q", st.Sample.State, StatePermissionOrPolicyRefused)
	}

	// Automatic sampling is disabled by the refusal; SampleNow (the panel's
	// Retry) clears it and samples immediately.
	f0.queue(fakeResponse{result: framed(knownRow)})
	s.SampleNow("ssh:p1:1")
	waitFor(t, "retry sample", func() bool {
		return s.Status("ssh:p1:1").Sample.State == StateAvailable
	})
}

func TestScheduler_ConnectionLossMarksLostAndReconnectResamples(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	// Transport dies: the lease's Done channel closes (the loss watcher).
	// A result from the old connection must never apply after reconnect.
	f0 := conn.acquired()[0]
	close(f0.done)
	waitFor(t, "conn lost", func() bool { return s.Status("ssh:p1:1").ConnLost })

	// No further execs are attempted on the dead lease.
	s.PromptHint("ssh:p1:1")
	s.SetVisible("ssh:p1:1", true)
	time.Sleep(80 * time.Millisecond)
	if got := conn.execCount(); got != 1 {
		t.Fatalf("exec count after loss = %d, want 1 (no probes on a dead connection)", got)
	}

	// Reconnect: ConnectionUp resets the stale result and a fresh detector
	// (fresh lease — probe selection is once per connection) samples.
	f1 := newFakeConn()
	f1.queue(fakeResponse{result: framed(knownRow)})
	conn.queueConn(f1)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	// Wait on the STATE, not the exec count: the count increments while the
	// sample is still in flight, before the result lands in the status.
	waitFor(t, "post-reconnect sample", func() bool {
		return s.Status("ssh:p1:1").Sample.State == StateAvailable
	})
	st := s.Status("ssh:p1:1")
	if st.ConnLost {
		t.Fatal("ConnLost still true after reconnect")
	}
	if st.Sample.State != StateAvailable {
		t.Fatalf("state after reconnect = %q, want %q", st.Sample.State, StateAvailable)
	}
}

func TestScheduler_ConnectionDownReleasesLease(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	s.ConnectionUp("ssh:p1:1", "host.example", testConnectOption())
	waitFor(t, "settle sample", func() bool { return conn.execCount() == 1 })

	// Last tab on the profile closed: the lease is released and the target
	// is forgotten — no background poll outlives its consumer.
	f0 := conn.acquired()[0]
	s.ConnectionDown("ssh:p1:1")
	waitFor(t, "lease release", func() bool {
		f0.mu.Lock()
		defer f0.mu.Unlock()
		return f0.closed
	})

	s.PromptHint("ssh:p1:1")
	s.SetVisible("ssh:p1:1", true)
	time.Sleep(60 * time.Millisecond)
	if got := conn.execCount(); got != 1 {
		t.Fatalf("exec count after ConnectionDown = %d, want 1", got)
	}
}

func TestScheduler_StatusPendingBeforeFirstSample(t *testing.T) {
	conn := &fakeConnector{}
	s := testScheduler(t, conn)
	st := s.Status("ssh:never:1")
	if st.Sample.State != StatePending {
		t.Fatalf("state before any connection = %q, want %q", st.Sample.State, StatePending)
	}
	if st.ConnLost || st.Paused || st.Visible {
		t.Fatalf("fresh status must be quiescent, got %+v", st)
	}
	if st.Sample.Listeners != nil {
		t.Fatalf("no listeners before any sample, got %d", len(st.Sample.Listeners))
	}
}

// testConnectOption returns the resolved-config option the transport would
// pass — the lease the pool keys by.
func testConnectOption() ssh.ConnectOption {
	return func(c *ssh.ConnectConfig) {
		c.User = "test"
	}
}
