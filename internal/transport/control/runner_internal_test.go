package control

import (
	"context"
	"testing"
)

// releaseRecorder is a Permit that records the release rather than returning
// capacity anywhere — enough to observe WHEN release happens.
type releaseRecorder struct{ released bool }

func (r *releaseRecorder) Release() { r.released = true }

// The permit is released even when the task panics. In production the runner
// is started with `go`, so an unrecovered panic crashes the process by design
// — the guarantee under test is not that the panic is survivable, but that
// the deferred release runs during the unwind, before the crash. Calling the
// runner directly and recovering in this goroutine observes exactly that
// without spawning a helper process.
//
// The interval, both ends: from the moment the runner is entered with an
// acquired permit until it leaves by ANY path, the permit is released.
func TestRunAndReleaseReleasesOnPanic(t *testing.T) {
	rec := &releaseRecorder{}

	func() {
		defer func() {
			if recover() == nil {
				t.Error("the panic was swallowed; the runner must let it propagate")
			}
		}()
		runAndRelease(rec, context.Background(), Task{
			Run: func(context.Context) { panic("boom") },
		})
	}()

	if !rec.released {
		t.Fatal("permit was not released while the panicking task unwound")
	}
}

// The ordinary path closes the same interval.
func TestRunAndReleaseReleasesOnNormalReturn(t *testing.T) {
	rec := &releaseRecorder{}
	runAndRelease(rec, context.Background(), Task{Run: func(context.Context) {}})
	if !rec.released {
		t.Fatal("permit was not released after the task returned")
	}
}
