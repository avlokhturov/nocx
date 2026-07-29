package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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
	id := credential.NewSecretID()
	if err := store.Set(id, credential.NewSecret("pw123")); err != nil {
		t.Fatalf("Set: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "h"}
	cfg := &ConnectConfig{
		Secrets:  store,
		SecretID: id,
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
	id := credential.NewSecretID()
	if err := store.Set(id, credential.NewSecret("pw")); err != nil {
		t.Fatalf("Set: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "h"}

	// auth=password should EXCLUDE publicKey bucket, include password buckets.
	cfg := &ConnectConfig{Secrets: store, SecretID: id, AuthMode: "password"}
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
	cfg2 := &ConnectConfig{Secrets: store, SecretID: id, AuthMode: "publicKey"}
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
	id := credential.NewSecretID()
	if err := store.Set(id, credential.NewSecret("stored-secret")); err != nil {
		t.Fatalf("Set: %v", err)
	}

	resolved := &resolvedConfig{identityFile: keyPath, user: "alice", hostName: "example.com", port: 22}
	cfg := &ConnectConfig{
		Secrets:  store,
		SecretID: id,
	}

	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}

	// Late-bind should inject the stored password as a savedPassword bucket.
	foundStored := false
	for _, m := range chain {
		if m.kind == kindSavedPassword {
			if err := m.secret.Use(func(b []byte) error {
				if string(b) == "stored-secret" {
					foundStored = true
				}
				return nil
			}); err != nil {
				t.Fatalf("secret.Use: %v", err)
			}
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

	// Verify the lookup/save contract: store a secret, retrieve it,
	// confirm it is non-empty without revealing plaintext.
	hash := credential.NewSecretID()
	if err := store.Set(hash, credential.NewSecret("my-passphrase")); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, err := rc.lookupKeyPassphrase(store, hash)
	if err != nil {
		t.Fatalf("lookupKeyPassphrase: %v", err)
	}
	if got.IsEmpty() {
		t.Error("lookupKeyPassphrase returned empty Secret for a stored passphrase")
	}
}

// TestLoadKeyWithStoredPassphrase verifies the full path: an encrypted
// private key whose passphrase is stored in the SecretStore is successfully
// parsed when loadKey is called with the matching ConnectConfig.
func TestLoadKeyWithStoredPassphrase(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)
	store := credential.NewKeychain()

	dir := t.TempDir()
	passphrase := "encrypted-key-passphrase"

	// Generate and marshal an encrypted ed25519 key.
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	block, err := gossh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(passphrase))
	if err != nil {
		t.Fatalf("marshal encrypted key: %v", err)
	}
	path := filepath.Join(dir, "encrypted_test_key")
	if err = os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	// Store the passphrase in the SecretStore.
	id := credential.NewSecretID()
	if err = store.Set(id, credential.NewSecret(passphrase)); err != nil {
		t.Fatalf("store passphrase: %v", err)
	}

	// Without a config, loadKey returns ErrEncryptedKey (no passphrase available).
	_, err = rc.loadKey(path, nil)
	if err == nil {
		t.Fatal("expected ErrEncryptedKey with nil config, got nil")
	}
	var encErr *ErrEncryptedKey
	if !errors.As(err, &encErr) {
		t.Fatalf("expected *ErrEncryptedKey, got %T: %v", err, err)
	}

	// With cfg but empty PassphraseSecretID, still ErrEncryptedKey.
	cfgNoPass := &ConnectConfig{Secrets: store}
	_, err = rc.loadKey(path, cfgNoPass)
	if err == nil {
		t.Fatal("expected ErrEncryptedKey with empty PassphraseSecretID, got nil")
	}
	if !errors.As(err, &encErr) {
		t.Fatalf("expected *ErrEncryptedKey, got %T: %v", err, err)
	}

	// With cfg + valid PassphraseSecretID, the key parses successfully.
	cfg := &ConnectConfig{
		Secrets:            store,
		PassphraseSecretID: id,
	}
	signer, err := rc.loadKey(path, cfg)
	if err != nil {
		t.Fatalf("loadKey with stored passphrase: %v", err)
	}
	if signer == nil {
		t.Fatal("expected non-nil signer from encrypted key")
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
		AuthMode: "password",
		Secrets:  credential.NewKeychain(),
		SecretID: credential.NewSecretID(),
	}
	if cfg.AuthMode != "password" {
		t.Error("AuthMode not set")
	}
	if cfg.Secrets == nil {
		t.Error("Secrets not set")
	}
	if cfg.SecretID == "" {
		t.Error("SecretID not set")
	}
}

// TestProbeFirstMethodFromExplicitAuthMethods verifies that the probe picks
// the same first method buildAuthChain would — no hardcoded expectation,
// so the test stays correct when the chain's order changes deliberately.
func TestProbeFirstMethodFromExplicitAuthMethods(t *testing.T) {
	rc := newTestRealClient(t)
	resolved := &resolvedConfig{user: "alice", hostName: "h"}

	// Use two distinguishable types: public key (gossh.PublicKeys) and
	// password (gossh.Password). firstAuthMethod must pick the first entry,
	// which is the public-key method — if it picks the password method
	// instead, the concrete type won't match chain[0].method.
	dir := t.TempDir()
	keyPath := writeTestKey(t, dir)
	signer, err := rc.loadKey(keyPath, nil)
	if err != nil {
		t.Fatalf("loadKey: %v", err)
	}
	explicit := []gossh.AuthMethod{
		gossh.PublicKeys(signer),
		gossh.Password("fallback"),
	}
	cfg := &ConnectConfig{AuthMethods: explicit}

	chain, err := rc.buildAuthChain(resolved, cfg)
	if err != nil {
		t.Fatalf("buildAuthChain: %v", err)
	}

	method, err := firstAuthMethod(chain)
	if err != nil {
		t.Fatalf("firstAuthMethod: %v", err)
	}
	if method == nil {
		t.Fatal("firstAuthMethod returned nil method for explicit AuthMethods")
	}
	if len(chain) == 0 {
		t.Fatal("buildAuthChain returned empty chain for explicit AuthMethods")
	}
	if chain[0].method == nil {
		t.Fatal("buildAuthChain's first entry has nil method for explicit AuthMethods")
	}
	// gossh.AuthMethod is incomparable (unexported function-typed method),
	// so we use reflect.TypeOf for a safe concrete-type comparison.
	// Using two different method types (publicKey vs password) means a
	// type mismatch proves firstAuthMethod picked the wrong entry.
	methodType := reflect.TypeOf(method)
	chainType := reflect.TypeOf(chain[0].method)
	if methodType != chainType {
		t.Errorf("firstAuthMethod returned %v, but buildAuthChain's first entry is %v; did it pick entry 1 (password) instead of entry 0?", methodType, chainType)
	}
}

// TestProbeFirstMethodKeyboardInteractive verifies that:
//   - with a stored secret and AuthMode=keyboardInteractive, firstAuthMethod
//     returns a keyboard-interactive method (not a plain password method);
//   - without a stored secret, firstAuthMethod returns ErrEncryptedKey
//     (needs-interactive).
func TestProbeFirstMethodKeyboardInteractive(t *testing.T) {
	keyring.MockInit()
	rc := newTestRealClient(t)
	resolved := &resolvedConfig{user: "alice", hostName: "h"}

	t.Run("with stored secret", func(t *testing.T) {
		store := credential.NewKeychain()
		id := credential.NewSecretID()
		if err := store.Set(id, credential.NewSecret("secret-pw")); err != nil {
			t.Fatalf("Set: %v", err)
		}
		cfg := &ConnectConfig{Secrets: store, SecretID: id, AuthMode: "keyboardInteractive"}

		chain, err := rc.buildAuthChain(resolved, cfg)
		if err != nil {
			t.Fatalf("buildAuthChain: %v", err)
		}

		method, err := firstAuthMethod(chain)
		if err != nil {
			t.Fatalf("firstAuthMethod with stored secret: %v", err)
		}
		if method == nil {
			t.Fatal("firstAuthMethod returned nil method for keyboardInteractive with stored secret")
		}

		// Concrete-type assertion: the method must be keyboard-interactive,
		typeName := fmt.Sprintf("%T", method)
		if strings.Contains(strings.ToLower(typeName), "password") {
			t.Errorf("firstAuthMethod returned a password-type method (%s), want keyboard-interactive", typeName)
		}
	})

	t.Run("without stored secret", func(t *testing.T) {
		cfg := &ConnectConfig{Secrets: nil, SecretID: "", AuthMode: "keyboardInteractive"}
		chain, err := rc.buildAuthChain(resolved, cfg)
		if err != nil {
			t.Fatalf("buildAuthChain: %v", err)
		}

		_, err = firstAuthMethod(chain)
		if err == nil {
			t.Fatal("firstAuthMethod: expected ErrEncryptedKey for keyboardInteractive without stored secret, got nil")
		}
		var encErr *ErrEncryptedKey
		if !errors.As(err, &encErr) {
			t.Fatalf("firstAuthMethod: expected *ErrEncryptedKey, got %T: %v", err, err)
		}
	})
}
