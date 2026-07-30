package system_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/vault"
	"github.com/shady2k/nocx/internal/vault/system"
	"github.com/shady2k/nocx/internal/vault/vaulttest"
)

// TestContract runs the shared provider contract against a fake keyring. The
// contract must pass on every platform because CI has no Secret Service.
func TestContract(t *testing.T) {
	vaulttest.RunProviderContract(t, "system", func(t *testing.T) vault.WritableProvider {
		return system.New(system.WithKeyring(newMemKeyring()))
	})
}

// TestProbeWithFakeKeyring verifies that Probe succeeds with an injected fake
// keyring, regardless of whether a Secret Service daemon is available on this
// machine.
func TestProbeWithFakeKeyring(t *testing.T) {
	kr := newMemKeyring()
	p := system.New(system.WithKeyring(kr))
	ctx := context.Background()
	status := p.Probe(ctx)
	if !status.Ready {
		t.Fatalf("Probe with fake keyring: Ready=false, Reason=%q", status.Reason)
	}
}

// TestTimeoutWriteStillLands verifies that a Put that times out still
// completes in the background, and that the value is readable afterwards.
//
// This is the behaviour described on WithTimeout: the timeout bounds waiting,
// it does NOT cancel the underlying operation.
func TestTimeoutWriteStillLands(t *testing.T) {
	kr := newBlockingKeyring()
	p := system.New(system.WithKeyring(kr), system.WithTimeout(50*time.Millisecond))

	ctx := context.Background()
	id, err := vault.MintReferenceForTest(vault.ProviderSystem)
	if err != nil {
		t.Fatalf("MintReferenceForTest: %v", err)
	}

	// Put with a blocking Set — should time out.
	err = p.Put(ctx, id, credential.NewSecret("delayed"))
	var pe *vault.ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("Put error = %T(%[1]v), want *ProviderError", err)
	}
	if pe.Reason != vault.ReasonTimeout {
		t.Fatalf("Put Reason = %q, want ReasonTimeout", pe.Reason)
	}
	if !errors.Is(err, vault.ErrProviderUnavailable) {
		t.Fatalf("Put error must wrap ErrProviderUnavailable")
	}

	// Unblock the background Set goroutine and wait for it to complete.
	kr.unblockSet()
	kr.waitForSetDone()

	// The value should now be stored. Read it back through the provider.
	got, err := p.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get after timed-out Put: %v", err)
	}
	var gotStr string
	if err := got.Use(func(b []byte) error { gotStr = string(b); return nil }); err != nil {
		t.Fatalf("Use: %v", err)
	}
	if gotStr != "delayed" {
		t.Fatalf("got %q, want delayed", gotStr)
	}
}

// TestDeleteAbsentIsIdempotent verifies that deleting a never-stored key is
// not an error — covering the path where the keyring returns ErrNotFound.
func TestDeleteAbsentIsIdempotent(t *testing.T) {
	kr := newMemKeyring()
	p := system.New(system.WithKeyring(kr))
	ctx := context.Background()

	id, err := vault.MintReferenceForTest(vault.ProviderSystem)
	if err != nil {
		t.Fatalf("MintReferenceForTest: %v", err)
	}
	if err := p.Delete(ctx, id); err != nil {
		t.Fatalf("Delete(absent) = %v, want nil", err)
	}
}

// TestGetNotFound verifies that Get of a never-stored key returns
// ErrSecretNotFound, wrapping the correct sentinel.
func TestGetNotFound(t *testing.T) {
	kr := newMemKeyring()
	p := system.New(system.WithKeyring(kr))
	ctx := context.Background()

	id, err := vault.MintReferenceForTest(vault.ProviderSystem)
	if err != nil {
		t.Fatalf("MintReferenceForTest: %v", err)
	}
	_, err = p.Get(ctx, id)
	if !errors.Is(err, vault.ErrSecretNotFound) {
		t.Fatalf("Get(absent) = %v, want ErrSecretNotFound", err)
	}
}

// --- test keyrings ---

// memKeyring is an in-memory Keyring for tests. Missing keys return an error
// wrapping keyring.ErrNotFound.
type memKeyring struct {
	mu    sync.Mutex
	store map[string]string
}

func newMemKeyring() *memKeyring {
	return &memKeyring{store: make(map[string]string)}
}

func (k *memKeyring) Set(service, user, password string) error {
	k.mu.Lock()
	k.store[key(service, user)] = password
	k.mu.Unlock()
	return nil
}

func (k *memKeyring) Get(service, user string) (string, error) {
	k.mu.Lock()
	v, ok := k.store[key(service, user)]
	k.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("memKeyring: %w", keyring.ErrNotFound)
	}
	return v, nil
}

func (k *memKeyring) Delete(service, user string) error {
	k.mu.Lock()
	delete(k.store, key(service, user))
	k.mu.Unlock()
	return nil
}

func key(service, user string) string { return service + "." + user }

// blockingKeyring blocks Set until unblockSet is called. Used to test timeout
// behaviour.
type blockingKeyring struct {
	mu       sync.Mutex
	store    map[string]string
	setBlock chan struct{}
	setDone  chan struct{}
	doneOnce sync.Once
}

func newBlockingKeyring() *blockingKeyring {
	return &blockingKeyring{
		store:    make(map[string]string),
		setBlock: make(chan struct{}),
		setDone:  make(chan struct{}),
	}
}

func (k *blockingKeyring) Set(service, user, password string) error {
	<-k.setBlock
	k.mu.Lock()
	k.store[key(service, user)] = password
	k.mu.Unlock()
	k.doneOnce.Do(func() { close(k.setDone) })
	return nil
}

func (k *blockingKeyring) Get(service, user string) (string, error) {
	k.mu.Lock()
	v, ok := k.store[key(service, user)]
	k.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("blockingKeyring: %w", keyring.ErrNotFound)
	}
	return v, nil
}

func (k *blockingKeyring) Delete(service, user string) error {
	k.mu.Lock()
	delete(k.store, key(service, user))
	k.mu.Unlock()
	return nil
}

func (k *blockingKeyring) unblockSet()     { close(k.setBlock) }
func (k *blockingKeyring) waitForSetDone() { <-k.setDone }
