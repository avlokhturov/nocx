package control

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// orderedSubmission preserves submission order while running off the
// caller's goroutine — the property resize's coalescing lane depends on
// (ws_session_ops_test.go). These tests pin FIFO, the capacity bound, and
// per-task context propagation.

func TestOrderedSubmission_RunsInSubmissionOrder(t *testing.T) {
	sub := NewOrderedSubmission("session", 8)
	ctx := context.Background()
	var mu sync.Mutex
	var ran []int
	done := make(chan struct{})
	for i := range 5 {
		i := i
		if rej := sub.TrySubmit(ctx, Task{Run: func(context.Context) {
			mu.Lock()
			ran = append(ran, i)
			mu.Unlock()
			if i == 4 {
				close(done)
			}
		}}); rej != nil {
			t.Fatalf("submit %d refused: %+v", i, rej)
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("tasks never all ran")
	}
	mu.Lock()
	defer mu.Unlock()
	for i := range ran {
		if ran[i] != i {
			t.Fatalf("execution order = %v, want 0..4 in submission order", ran)
		}
	}
}

func TestOrderedSubmission_SecondTaskWaitsForFirst(t *testing.T) {
	sub := NewOrderedSubmission("session", 4)
	ctx := context.Background()
	firstStarted := make(chan struct{})
	firstDone := make(chan struct{})
	secondRan := make(chan struct{})

	if rej := sub.TrySubmit(ctx, Task{Run: func(context.Context) {
		close(firstStarted)
		<-firstDone
	}}); rej != nil {
		t.Fatal("first submit refused")
	}
	select {
	case <-firstStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first task never started")
	}
	if rej := sub.TrySubmit(ctx, Task{Run: func(context.Context) {
		close(secondRan)
	}}); rej != nil {
		t.Fatal("second submit refused")
	}
	select {
	case <-secondRan:
		t.Fatal("second task ran while the first was still in flight — order violated")
	case <-time.After(200 * time.Millisecond):
	}
	close(firstDone)
	select {
	case <-secondRan:
	case <-time.After(5 * time.Second):
		t.Fatal("second task never ran after the first completed")
	}
}

func TestOrderedSubmission_RefusesWhenFull(t *testing.T) {
	sub := NewOrderedSubmission("session", 2)
	ctx := context.Background()
	release := make(chan struct{})
	var n int64
	// Fill the queue: the first task blocks, the second waits in the FIFO.
	for i := range 2 {
		if rej := sub.TrySubmit(ctx, Task{Run: func(context.Context) {
			atomic.AddInt64(&n, 1)
			<-release
		}}); rej != nil {
			t.Fatalf("submit %d refused: %+v", i, rej)
		}
	}
	// The third submit must be refused, never queued.
	rej := sub.TrySubmit(ctx, Task{Run: func(context.Context) {}})
	if rej == nil {
		t.Fatal("third submit must be refused when the queue is full")
	}
	if rej.Scope != "session" {
		t.Fatalf("rejection scope = %q, want the submission's name", rej.Scope)
	}
	close(release)
	// The admitted tasks complete.
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadInt64(&n) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("admitted tasks never completed (%d ran)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestOrderedSubmission_PropagatesTaskContext(t *testing.T) {
	sub := NewOrderedSubmission("session", 4)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	observed := make(chan bool, 1)
	if rej := sub.TrySubmit(ctx, Task{Run: func(taskCtx context.Context) {
		select {
		case <-taskCtx.Done():
			observed <- true
		default:
			observed <- false
		}
	}}); rej != nil {
		t.Fatal("submit refused")
	}
	select {
	case cancelled := <-observed:
		if !cancelled {
			t.Fatal("task did not observe the cancelled submit context")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("task never ran")
	}
}
