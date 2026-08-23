package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shady2k/nocx/internal/credential"
)

// memSecretStore is an in-memory credential.SecretStore for tests.
// It implements the new interface (Create/Get/Delete/Exists with context).
type memSecretStore struct {
	mu sync.Mutex
	m  map[credential.SecretID][]byte
}

// newTestStore returns a fresh in-memory secret store.
func newTestStore() *memSecretStore {
	return &memSecretStore{m: make(map[credential.SecretID][]byte)}
}

func (s *memSecretStore) Create(_ context.Context, value credential.Secret) (credential.SecretID, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var idB [32]byte
	if _, err := rand.Read(idB[:]); err != nil {
		return "", err
	}
	id := credential.SecretID(hex.EncodeToString(idB[:]))
	buf := []byte(nil)
	if err := value.Use(func(b []byte) error {
		buf = append(buf, b...)
		return nil
	}); err != nil {
		return "", err
	}
	s.m[id] = buf
	return id, nil
}

func (s *memSecretStore) Get(_ context.Context, id credential.SecretID) (credential.Secret, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	buf, ok := s.m[id]
	if !ok {
		return credential.Secret{}, nil
	}
	return credential.NewSecretBytes(buf), nil
}

func (s *memSecretStore) Resolve(ctx context.Context, id credential.SecretID, why credential.Stance) (credential.Secret, error) {
	return credential.NewOperationResolver(s).Resolve(ctx, id, why)
}

func (s *memSecretStore) Delete(_ context.Context, id credential.SecretID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

func (s *memSecretStore) Exists(_ context.Context, id credential.SecretID) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.m[id]
	return ok, nil
}

// wedgedSocket is an outbound.Socket whose WriteMessage blocks until
// release is closed — the deterministic stand-in for a socket with a full
// send buffer. It lets a test wedge a connection's outbound pump mid-write.
// started (buffered 1) fires on entry to WriteMessage, so a test can wait
// until the pump is genuinely blocked; writes counts completed
// (post-release) writes, so a test can assert a frame was never delivered.
type wedgedSocket struct {
	mu      sync.Mutex
	release chan struct{}
	closed  bool
	started chan struct{}
	writes  atomic.Int64
}

func newWedgedSocket() *wedgedSocket {
	return &wedgedSocket{release: make(chan struct{}), started: make(chan struct{}, 1)}
}

func (s *wedgedSocket) WriteMessage(int, []byte) error {
	select {
	case s.started <- struct{}{}:
	default:
	}
	<-s.release
	s.writes.Add(1)
	return nil
}

func (s *wedgedSocket) SetWriteDeadline(time.Time) error { return nil }

func (s *wedgedSocket) ReadMessage() (int, []byte, error) { return 0, nil, io.EOF }

func (s *wedgedSocket) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.release)
	}
	return nil
}
