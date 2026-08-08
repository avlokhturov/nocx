package control

import "testing"

// A double Release must not hand back capacity the permit never held. Before
// Permit became idempotent this failed with two slots free while one permit
// was still out — a semaphore of 2 admitting 3. The bound is the whole point
// of this package, so the way it can be silently exceeded gets a test.
func TestDoubleReleaseDoesNotOverAdmit(t *testing.T) {
	sem := NewSemaphore("probe", 2)

	x, rej := sem.TryAcquire(t.Context())
	if rej != nil {
		t.Fatal("first acquire refused")
	}
	_, rej = sem.TryAcquire(t.Context())
	if rej != nil {
		t.Fatal("second acquire refused")
	}
	// Both permits are out; capacity 2 is exhausted.
	if _, r := sem.TryAcquire(t.Context()); r == nil {
		t.Fatal("third acquire should be refused while both permits are held")
	}

	x.Release()
	x.Release() // one holder releases twice; the second must be a no-op

	// y is still held, so at most ONE slot may be free.
	free := 0
	for {
		_, r := sem.TryAcquire(t.Context())
		if r != nil {
			break
		}
		free++
		if free > 5 {
			break
		}
	}
	if free > 1 {
		t.Fatalf("capacity corrupted: %d slots free while one permit is still held (want 1)", free)
	}
}
