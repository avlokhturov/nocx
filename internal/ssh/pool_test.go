package ssh

import (
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

// fakeClient is a minimal ssh.Client stand-in for pool testing.
type fakeClient struct {
	closed     bool
	closeCount int
	mu         sync.Mutex
}

func (f *fakeClient) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.closeCount++
	return nil
}

func (f *fakeClient) getCloseCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCount
}

func TestPoolAcquireCreatesAndReuses(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	key := poolKey{host: "example.com", user: "alice"}

	var dialCount int
	pool.dial = func(key poolKey) (sshClientConn, error) {
		dialCount++
		return &fakeClient{}, nil
	}

	c1, err := pool.Acquire(key)
	if err != nil {
		t.Fatalf("Acquire 1: %v", err)
	}
	if dialCount != 1 {
		t.Errorf("after first Acquire, dialCount = %d, want 1", dialCount)
	}

	_, err = pool.Acquire(key)
	if err != nil {
		t.Fatalf("Acquire 2: %v", err)
	}
	if dialCount != 1 {
		t.Errorf("after second Acquire (same key), dialCount = %d, want 1 (reused)", dialCount)
	}

	_ = c1
}

func TestPoolReleaseClosesOnLastRef(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	key := poolKey{host: "example.com", user: "alice"}

	var fc *fakeClient
	pool.dial = func(key poolKey) (sshClientConn, error) {
		fc = &fakeClient{}
		return fc, nil
	}

	c1, _ := pool.Acquire(key)
	c2, _ := pool.Acquire(key)
	pool.Release(c1)
	// Should still be open (2 refs → 1).
	if fc.getCloseCount() != 0 {
		t.Error("connection closed before last ref released")
	}

	pool.Release(c2)
	// Should be closed now (last ref).
	if fc.getCloseCount() != 1 {
		t.Errorf("connection not closed on last ref, closeCount = %d", fc.getCloseCount())
	}
}

func TestPoolDifferentKeysDialSeparately(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	key1 := poolKey{host: "h1", user: "u1"}
	key2 := poolKey{host: "h2", user: "u2"}

	var dialCount int
	pool.dial = func(key poolKey) (sshClientConn, error) {
		dialCount++
		return &fakeClient{}, nil
	}

	_, _ = pool.Acquire(key1)
	_, _ = pool.Acquire(key2)

	if dialCount != 2 {
		t.Errorf("dialCount = %d, want 2 (different keys = different conns)", dialCount)
	}
}

func TestPoolAcquireAfterReleaseReusesUntilClosed(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	key := poolKey{host: "h", user: "u"}

	var dialCount int
	pool.dial = func(key poolKey) (sshClientConn, error) {
		dialCount++
		return &fakeClient{}, nil
	}

	c1, _ := pool.Acquire(key)
	pool.Release(c1)
	// After release (last ref), the conn is closed. New acquire should dial.
	c2, _ := pool.Acquire(key)
	if dialCount != 2 {
		t.Errorf("dialCount = %d, want 2 (should re-dial after close)", dialCount)
	}
	_ = c2
}

func TestPoolConcurrentAcquireSameKey(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	key := poolKey{host: "h", user: "u"}

	var dialCount int
	var dialMu sync.Mutex
	pool.dial = func(key poolKey) (sshClientConn, error) {
		dialMu.Lock()
		dialCount++
		dialMu.Unlock()
		time.Sleep(10 * time.Millisecond) // simulate slow dial
		return &fakeClient{}, nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = pool.Acquire(key)
		}()
	}
	wg.Wait()

	if dialCount != 1 {
		t.Errorf("dialCount = %d, want 1 (concurrent acquire should dedup)", dialCount)
	}
}

func TestPoolKeyByHostAndIdentity(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))

	var dialed []poolKey
	pool.dial = func(key poolKey) (sshClientConn, error) {
		dialed = append(dialed, key)
		return &fakeClient{}, nil
	}

	// Same host+user, different port → different key.
	_, _ = pool.Acquire(poolKey{host: "h", user: "u", port: 22})
	_, _ = pool.Acquire(poolKey{host: "h", user: "u", port: 2222})

	if len(dialed) != 2 {
		t.Errorf("expected 2 dials (different port), got %d", len(dialed))
	}
}

func TestPoolReleaseUnknownHandleNoOp(t *testing.T) {
	pool := NewConnPool(log.NewSlogAdapter(nil))
	// Releasing a handle not in the pool should not panic.
	pool.Release(&poolHandle{key: poolKey{host: "unknown"}, ref: &refCount{}, pool: pool})
}
