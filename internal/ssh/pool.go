package ssh

import (
	"fmt"
	"sync"

	"github.com/shady2k/nocx/internal/log"
)

// sshClientConn is the subset of *gossh.Client we need: Close. The real
// *gossh.Client satisfies this; tests inject a fake.
type sshClientConn interface {
	Close() error
}

// poolKey identifies a shared SSH connection: host + user + port. Channels
// multiplex over the same connection when this key matches (AD-4).
type poolKey struct {
	host string
	user string
	port int
}

// refCount tracks how many tabs (channels) reference a pooled connection.
type refCount struct {
	n int
}

// poolHandle is a reference to a pooled connection, returned by Acquire.
// Release decrements the ref count; the connection closes on the last ref.
type poolHandle struct {
	key  poolKey
	conn sshClientConn
	ref  *refCount
	pool *ConnPool
}

// ConnPool is a ref-counted ssh.Client connection pool keyed by host+identity
// (AD-4). Channels multiplex over one connection; the connection closes when
// the last tab releases its reference.
//
// The pool wraps the dial logic: on a cache miss it calls dial(key) to
// establish a new *gossh.Client. RealClient.Connect will use this pool to
// share connections across tabs targeting the same host+user+port.
type ConnPool struct {
	log     log.Logger
	mu      sync.Mutex
	pool    map[poolKey]*poolEntry
	dialing map[poolKey]*dialInProgress
	// dial is the connection factory (injected for testing). Production
	// use sets this to a function that calls gossh.Dial.
	dial func(key poolKey) (sshClientConn, error)
}

// poolEntry holds a connection and its ref count.
type poolEntry struct {
	conn sshClientConn
	ref  *refCount
}

// dialInProgress tracks an in-flight dial for a key so concurrent Acquire
// calls wait for the first dialer instead of racing.
type dialInProgress struct {
	done chan struct{}
}

// NewConnPool creates an empty connection pool.
func NewConnPool(logger log.Logger) *ConnPool {
	p := &ConnPool{
		log:     logger.With("module", "ssh-pool"),
		pool:    make(map[poolKey]*poolEntry),
		dialing: make(map[poolKey]*dialInProgress),
	}
	p.dial = p.defaultDial
	return p
}

// Acquire returns a handle to a pooled connection for the given key. On a
// cache miss, it dials a new connection. Concurrent Acquire calls with the
// same key share a single connection: the first goroutine dials under a
// per-key lock, others wait and reuse. Each Acquire increments the ref count.
func (p *ConnPool) Acquire(key poolKey) (*poolHandle, error) {
	p.mu.Lock()
	entry, ok := p.pool[key]
	if ok {
		entry.ref.n++
		p.mu.Unlock()
		return &poolHandle{key: key, conn: entry.conn, ref: entry.ref, pool: p}, nil
	}

	// No existing entry — check if another goroutine is already dialing this
	// key. If so, wait on its done channel and reuse the result.
	if dialing, exists := p.dialing[key]; exists {
		p.mu.Unlock()
		<-dialing.done // wait for the dial to finish
		return p.Acquire(key)
	}

	// We're the first — register a dial-in-progress and dial under the lock.
	d := &dialInProgress{done: make(chan struct{})}
	p.dialing[key] = d
	p.mu.Unlock()

	// Dial (this may block — but we hold the per-key slot, not the pool lock).
	conn, err := p.dial(key)

	p.mu.Lock()
	delete(p.dialing, key)
	if err != nil {
		p.mu.Unlock()
		close(d.done) // wake waiters so they can see the failure / retry
		return nil, fmt.Errorf("dial %s@%s:%d: %w", key.user, key.host, key.port, err)
	}
	// Check again — a concurrent release-after-close can't happen (no entry
	// existed), but be safe.
	if entry, ok := p.pool[key]; ok {
		_ = conn.Close()
		entry.ref.n++
		p.mu.Unlock()
		close(d.done)
		return &poolHandle{key: key, conn: entry.conn, ref: entry.ref, pool: p}, nil
	}
	ref := &refCount{n: 1}
	p.pool[key] = &poolEntry{conn: conn, ref: ref}
	p.mu.Unlock()
	close(d.done) // wake waiters

	return &poolHandle{key: key, conn: conn, ref: ref, pool: p}, nil
}

// Release decrements the ref count for a handle. On the last ref, the
// connection is closed and removed from the pool. Releasing an unknown
// handle is a no-op.
func (p *ConnPool) Release(h *poolHandle) {
	if h == nil || h.ref == nil || h.pool == nil {
		return
	}
	if h.pool != p {
		return // handle belongs to a different pool
	}
	p.mu.Lock()
	h.ref.n--
	if h.ref.n <= 0 {
		entry, ok := p.pool[h.key]
		if ok && entry.ref == h.ref {
			delete(p.pool, h.key)
		}
		if h.conn != nil {
			_ = h.conn.Close()
		}
		p.log.Debug("pool connection closed (last ref)", "host", h.key.host, "user", h.key.user)
	}
	p.mu.Unlock()
}

// CloseAll closes all pooled connections regardless of ref count.
// Used during shutdown.
func (p *ConnPool) CloseAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, entry := range p.pool {
		_ = entry.conn.Close()
		delete(p.pool, key)
	}
}

// Count returns the number of pooled connections (for testing/diagnostics).
func (p *ConnPool) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.pool)
}

// defaultDial is the production dial function. It is a placeholder that
// returns an error — the real wiring will call gossh.Dial here, building
// the ClientConfig from the resolved SSH config + auth chain. This is
// injected by RealClient when it wraps the pool.
func (p *ConnPool) defaultDial(key poolKey) (sshClientConn, error) {
	return nil, fmt.Errorf("pool dial not configured for %s@%s:%d", key.user, key.host, key.port)
}
