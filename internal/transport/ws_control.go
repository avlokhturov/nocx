package transport

// The bounded off-loop executor for control work that must not freeze the
// read loop: connections.test probes and dialog.openFile.
//
// Both run on their own goroutine under a capacity-one admission (the
// internal/transport/control seam, nocx-sfv6.3): the read loop submits and
// moves on, the Submission decides whether the work runs now or is refused,
// and the permit is released when the task returns — cancelled or not. A
// task's context derives from the connection context, so a disconnect
// cancels the work, and the same derived context lets Stop cancel every
// in-flight task at shutdown.

import (
	"context"
	"sync"
	"time"
)

// defaultControlDrainTimeout is the documented maximum Stop waits for
// in-flight off-loop control work to finish after cancelling it. Five
// seconds covers a cooperative task's cancellation round trip with room to
// spare; a task that ignores cancellation is abandoned at this bound
// (forced abandonment — see inflight.waitDrained).
const defaultControlDrainTimeout = 5 * time.Second

// inflightTask is the registration handle of one admitted task.
type inflightTask struct{}

// inflight tracks admitted off-loop control tasks so Stop can cancel them
// and wait, bounded, for them to drain.
//
// begin() is called before TrySubmit, and its Add is serialized with stop()
// under the same mutex: no task can register once shutdown has begun, so a
// WaitGroup.Wait started by Stop observes every task that will ever run —
// the Add/Wait race is closed by construction, not by luck.
type inflight struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	cancels map[*inflightTask]context.CancelFunc
	stopped bool
}

// begin registers a task, deriving a cancellable context from the caller's.
// It reports ok=false once shutdown has begun (the caller must refuse the
// work). The returned release unregisters the task exactly once, cancelling
// its context and freeing the admission permit's WaitGroup slot.
func (t *inflight) begin(ctx context.Context) (tctx context.Context, cancel context.CancelFunc, release func(), ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return nil, nil, nil, false
	}
	tctx, cancel = context.WithCancel(ctx)
	h := &inflightTask{}
	if t.cancels == nil {
		t.cancels = make(map[*inflightTask]context.CancelFunc)
	}
	t.cancels[h] = cancel
	t.wg.Add(1)
	var once sync.Once
	release = func() {
		once.Do(func() {
			t.mu.Lock()
			delete(t.cancels, h)
			t.mu.Unlock()
			cancel()
			t.wg.Done()
		})
	}
	return tctx, cancel, release, true
}

// cancelAll cancels every in-flight task. Idempotent; the tasks' own
// release calls unregister them.
func (t *inflight) cancelAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, c := range t.cancels {
		c()
	}
}

// stop begins shutdown: no new task registers, in-flight ones are cancelled.
func (t *inflight) stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
	t.cancelAll()
}

// waitDrained waits up to timeout for every registered task to finish. It
// reports false on timeout: the remaining tasks are ABANDONED — they may
// still be running and their admission permits stay held until they return.
// That is the forced-abandonment policy for work outside a commit interval:
// the process is exiting, and a dependency that ignores cancellation must
// not be able to hold shutdown hostage past the documented maximum.
func (t *inflight) waitDrained(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}
