package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/zalando/go-keyring"
	gossh "golang.org/x/crypto/ssh"
)

// authMethodKind labels a bucket in the fallback chain.
// Defined in ssh_real.go; tests reference the same constants.

func TestAuthChainOrderAuto(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)

	// With a key file set + credential store wired + agent available, Auto
	// should include: publicKey, agent, savedPassword, keyboardInteractive,
	// promptPassword (in that relative order).
	dir := t.TempDir()
	keyPath := writeTestKey(t, dir)

	store := credential.NewKeychain()
	id := credential.Identity{User: "alice", Host: "h", Port: 22}
	if err := store.SavePassword(id, "pw123"); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "h"}
	cfg := &ConnectConfig{
		Credentials:  store,
		CredIdentity: id,
	}

	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}

	// Verify publicKey is present and early.
	foundPubKey := false
	foundSavedPw := false
	foundPromptPw := false
	pubKeyIdx, savedPwIdx, promptPwIdx := -1, -1, -1
	for i, m := range chain {
		switch m.kind {
		case kindPublicKey:
			foundPubKey = true
			pubKeyIdx = i
		case kindSavedPassword:
			foundSavedPw = true
			savedPwIdx = i
		case kindPromptPassword:
			foundPromptPw = true
			promptPwIdx = i
		}
	}
	if !foundPubKey || !foundSavedPw || !foundPromptPw {
		t.Fatalf("chain missing buckets: pubKey=%v savedPw=%v promptPw=%v", foundPubKey, foundSavedPw, foundPromptPw)
	}
	if pubKeyIdx > savedPwIdx {
		t.Errorf("publicKey (%d) should come before savedPassword (%d)", pubKeyIdx, savedPwIdx)
	}
	if savedPwIdx > promptPwIdx {
		t.Errorf("savedPassword (%d) should come before promptPassword (%d)", savedPwIdx, promptPwIdx)
	}
}

func TestAuthChainFilterByAuthMode(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)
	dir := t.TempDir()
	keyPath := writeTestKey(t, dir)

	store := credential.NewKeychain()
	id := credential.Identity{User: "alice", Host: "h", Port: 22}
	if err := store.SavePassword(id, "pw"); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "h"}

	// auth=password should EXCLUDE publicKey bucket, include password buckets.
	cfg := &ConnectConfig{Credentials: store, CredIdentity: id, AuthMode: "password"}
	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}
	for _, m := range chain {
		if m.kind == kindPublicKey {
			t.Error("auth=password should not include publicKey bucket")
		}
	}

	// auth=publicKey should EXCLUDE password buckets, include publicKey.
	cfg2 := &ConnectConfig{Credentials: store, CredIdentity: id, AuthMode: "publicKey"}
	chain2, err := rc.buildAuthChain(resolved, cfg2)
	if err != nil {
		t.Fatalf("buildAuthChain auth=publicKey: %v", err)
	}
	foundPubKey, foundPw := false, false
	for _, m := range chain2 {
		if m.kind == kindPublicKey {
			foundPubKey = true
		}
		if m.kind == kindSavedPassword || m.kind == kindPromptPassword {
			foundPw = true
		}
	}
	if !foundPubKey {
		t.Error("auth=publicKey should include publicKey bucket")
	}
	if foundPw {
		t.Error("auth=publicKey should exclude password buckets")
	}
}

func TestAuthChainExplicitMethodsBypass(t *testing.T) {
	rc := newTestRealClient(t)
	resolved := &resolvedConfig{user: "alice", hostName: "h"}

	// Explicit AuthMethods bypass the chain builder entirely.
	explicit := []gossh.AuthMethod{gossh.Password("explicit")}
	cfg := &ConnectConfig{AuthMethods: explicit}
	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}
	if len(chain) != 1 {
		t.Fatalf("explicit methods should bypass chain, got %d methods", len(chain))
	}
}

func TestAuthChainLateBindCredential(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)
	dir := t.TempDir()
	keyPath := writeTestKey(t, dir)

	// Set up a credential store with a saved password for the identity.
	store := credential.NewKeychain()
	id := credential.Identity{User: "alice", Host: "example.com", Port: 22}
	if err := store.SavePassword(id, "stored-secret"); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "example.com", port: 22}
	cfg := &ConnectConfig{
		Credentials:  store,
		CredIdentity: credential.Identity{User: "alice", Host: "example.com", Port: 22},
	}

	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}

	// Late-bind should inject the stored password as a savedPassword bucket.
	foundStored := false
	for _, m := range chain {
		if m.kind == kindSavedPassword && m.password == "stored-secret" {
			foundStored = true
		}
	}
	if !foundStored {
		t.Error("late-bind did not inject stored credential as savedPassword")
	}
}

func TestAuthChainDefaultKeyDiscovery(t *testing.T) {
	rc := newTestRealClient(t)
	// No identityFile, no password, no agent — should fall back to default
	// key files in ~/.ssh/id_*. Those won't exist in test, so chain may be
	// empty or contain only promptPassword.
	resolved := &resolvedConfig{user: "alice", hostName: "h"}
	cfg := &ConnectConfig{}

	chain, err := rc.buildAuthChain(resolved, cfg)
	// We expect at least promptPassword in the chain (or an error if no methods).
	if err != nil {
		// errNoAuthMethods is acceptable when no keys/agent/password.
		if !errors.Is(err, errNoAuthMethods) {
			t.Fatalf("unexpected error: %v", err)
		}
		return
	}
	foundPrompt := false
	for _, m := range chain {
		if m.kind == kindPromptPassword {
			foundPrompt = true
		}
	}
	if !foundPrompt {
		t.Error("chain should include promptPassword as last resort")
	}
}

func TestResolvePrivateKeyPassphraseByHash(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)
	store := credential.NewKeychain()

	// Generate an encrypted key (simulated: we test the passphrase path,
	// not real encryption — just verify the lookup/save contract).
	hash := credential.KeyHash("sha512:testkeyhash")
	if err := store.SaveKeyPassphrase(hash, "my-passphrase"); err != nil {
		t.Fatalf("SaveKeyPassphrase: %v", err)
	}

	got, err := rc.lookupKeyPassphrase(store, hash)
	if err != nil {
		t.Fatalf("lookupKeyPassphrase: %v", err)
	}
	if got != "my-passphrase" {
		t.Errorf("passphrase = %q, want my-passphrase", got)
	}
}

// newTestRealClient builds a RealClient with test-safe defaults.
func newTestRealClient(t *testing.T) *RealClient {
	t.Helper()
	dir := t.TempDir()
	rc, err := NewReal(
		log.NewSlogAdapter(nil), // nil handler → slog falls back
		WithKnownHostsFile(filepath.Join(dir, "known_hosts")),
		WithSSHConfigPath(filepath.Join(dir, "config")),
	)
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	return rc
}

// writeTestKey writes an ed25519 private key to dir/key and returns its path.
func writeTestKey(t *testing.T, dir string) string {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	_ = pub
	block, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	path := filepath.Join(dir, "test_key")
	pemBytes := pem.EncodeToMemory(block)
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return path
}

// Ensure the new fields compile on ConnectConfig.
func TestConnectConfigNewFields(t *testing.T) {
	cfg := &ConnectConfig{
		AuthMode:     "password",
		Credentials:  credential.NewKeychain(),
		CredIdentity: credential.Identity{User: "u", Host: "h", Port: 22},
	}
	if cfg.AuthMode != "password" {
		t.Error("AuthMode not set")
	}
	if cfg.Credentials == nil {
		t.Error("Credentials not set")
	}
}

// Suppress unused import in phases where context isn't referenced.
var _ = context.Background
