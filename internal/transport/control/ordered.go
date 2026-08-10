package control

import (
	"context"
	"sync"
)

// orderedSubmission runs tasks strictly in submission order on one worker
// goroutine, under a capacity bound. It is the submission for work whose
// ARRIVAL ORDER is load-bearing but that must still run off the read loop:
// the read loop submits in order, and this submission preserves that order
// by construction — the single worker drains a FIFO channel, so task N+1
// never starts before task N has finished.
//
// The canonical example is resize: the per-session coalescing lane replaces
// its pending op, so two resizes racing off-loop can land on stale
// dimensions. close shares this submission with resize so a close admitted
// after a resize on the same socket observes the resize's enqueue first —
// the same-socket ordering the read loop used to provide by running
// everything inline.
//
// The bound is admission-backed like any other: a full queue refuses with a
// *Rejection (never blocks, never grows without limit), exactly the
// saturation contract. The worker is started lazily on first submit and
// lives for the process — one goroutine per ordered submission, the same
// class of persistent goroutine as an outbound pump.
//
// A panicking task crashes the process, exactly like boundedSubmission's
// runAndRelease (control.go: a panic is deliberately not swallowed — it
// propagates, but never leaks a permit). The queue's already-admitted tasks
// are lost with the crash, which is the same policy as a permit leaked by a
// crashing worker.
type orderedSubmission struct {
	name     string
	capacity int
	ch       chan orderedTask
	once     sync.Once
}

type orderedTask struct {
	ctx  context.Context
	task Task
}

// NewOrderedSubmission returns a Submission that runs each task on a single
// worker in submission order. Capacity bounds the queue; a full queue
// refuses (capacity 0 refuses every submit, negative is a programming error).
func NewOrderedSubmission(name string, capacity int) Submission {
	if capacity < 0 {
		panic("control: negative capacity for ordered submission " + name)
	}
	return &orderedSubmission{name: name, capacity: capacity, ch: make(chan orderedTask, capacity)}
}

// Name identifies the resource for metrics only.
func (s *orderedSubmission) Name() string { return s.name }

// TrySubmit enqueues the task in arrival order. A full queue refuses with a
// *Rejection — the caller answers the saturation error/notification.
func (s *orderedSubmission) TrySubmit(ctx context.Context, task Task) *Rejection {
	select {
	case s.ch <- orderedTask{ctx: ctx, task: task}:
		s.once.Do(func() {
			go s.worker()
		})
		return nil
	default:
		return &Rejection{
			Reason: "capacity exhausted",
			Scope:  s.name,
		}
	}
}

// worker drains the FIFO in submission order. It exits only when the channel
// closes, which never happens in practice — the submission lives for the
// server's lifetime, exactly like an outbound pump.
func (s *orderedSubmission) worker() {
	for t := range s.ch {
		t.task.Run(t.ctx)
	}
}
