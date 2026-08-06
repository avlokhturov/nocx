package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A signature this tool writes must verify against the public key derived from
// the same seed, over the exact manifest bytes — that is the contract the
// compiled-in keyring (a75.3) will rely on. This test stands in for that
// verifier so a format drift is caught here rather than in the field.
func TestSignRoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(seedEnv, base64.StdEncoding.EncodeToString(priv.Seed()))

	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	body := []byte(`{"version":"0.2.0"}`)
	if err := os.WriteFile(manifest, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sigPath := filepath.Join(dir, "manifest.json.sig")
	if err := sign(manifest, sigPath); err != nil {
		t.Fatal(err)
	}

	sig := decodeSig(t, sigPath)
	if !ed25519.Verify(pub, body, sig) {
		t.Fatal("signature did not verify against the derived public key")
	}
	// A one-byte change to the signed bytes must break verification.
	if ed25519.Verify(pub, []byte(`{"version":"0.2.1"}`), sig) {
		t.Fatal("signature verified against tampered bytes")
	}
}

func TestSignRejectsWrongSeedLength(t *testing.T) {
	// 31 bytes, one short of ed25519.SeedSize.
	t.Setenv(seedEnv, base64.StdEncoding.EncodeToString(make([]byte, ed25519.SeedSize-1)))
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sign(manifest, filepath.Join(dir, "out.sig")); err == nil {
		t.Fatal("expected an error for an undersized seed, got nil")
	}
}

func TestSignRequiresSeed(t *testing.T) {
	t.Setenv(seedEnv, "")
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sign(manifest, filepath.Join(dir, "out.sig")); err == nil {
		t.Fatal("expected an error when the seed env is empty, got nil")
	}
}

func decodeSig(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // path is test-controlled
	if err != nil {
		t.Fatal(err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("signature file is not valid base64: %v", err)
	}
	if len(sig) != ed25519.SignatureSize {
		t.Fatalf("signature is %d bytes, want %d", len(sig), ed25519.SignatureSize)
	}
	return sig
}

// ── verify mode ──────────────────────────────────────────────────────────────
//
// The failure this mode exists to foreclose is the one nobody notices until a
// user is offered an update that will not install: CI signing with a seed whose
// public half is not in the keyring compiled into the artefact being published.
// Both halves are green on their own — the signature is valid, the keyring is
// well-formed — and they are simply not a pair. A signature verified only by
// the key that made it proves the signer works, not that anyone can check it.

func TestVerify_AcceptsASignatureFromAKeyInTheKeyring(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	body := []byte(`{"version":"0.1.0"}`)
	if err := os.WriteFile(manifest, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sigPath := filepath.Join(dir, "manifest.json.sig")
	// The trailing newline is part of what sign() writes; verify must trim it
	// rather than treat the file as corrupt.
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body)) + "\n"
	if err := os.WriteFile(sigPath, []byte(sig), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := verify(manifest, sigPath, []ed25519.PublicKey{pub}); err != nil {
		t.Fatalf("verify with the signing key in the keyring: %v", err)
	}
}

// The whole point: a mismatched pair must fail, and the message must say which
// mismatch it is so a release engineer is not left guessing between a stale
// secret and a stale keyring.
func TestVerify_RejectsASignatureFromAKeyOutsideTheKeyring(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	strangerPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	body := []byte(`{"version":"0.1.0"}`)
	if wErr := os.WriteFile(manifest, body, 0o600); wErr != nil {
		t.Fatal(wErr)
	}
	sigPath := filepath.Join(dir, "manifest.json.sig")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body))
	if wErr := os.WriteFile(sigPath, []byte(sig), 0o600); wErr != nil {
		t.Fatal(wErr)
	}

	err = verify(manifest, sigPath, []ed25519.PublicKey{strangerPub})
	if err == nil {
		t.Fatal("verify accepted a signature no key in the keyring produced")
	}
	if !strings.Contains(err.Error(), "keyring") {
		t.Errorf("error does not point at the keyring/secret mismatch: %v", err)
	}
}

// An empty keyring must fail closed, not vacuously pass. This is the state the
// production build shipped in before nocx-nfu5.1, so a release that reintroduced
// it must not be able to publish quietly.
func TestVerify_RejectsAnEmptyKeyring(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	body := []byte(`{"version":"0.1.0"}`)
	if err := os.WriteFile(manifest, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sigPath := filepath.Join(dir, "manifest.json.sig")
	if err := os.WriteFile(sigPath, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body))), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := verify(manifest, sigPath, nil); err == nil {
		t.Fatal("verify accepted an empty keyring; an unverifiable release would publish")
	}
}

// A signature that has been truncated or re-wrapped must be reported as a
// malformed signature rather than as a mismatched key: the two have different
// remedies.
func TestVerify_RejectsAMalformedSignature(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	if wErr := os.WriteFile(manifest, []byte(`{"version":"0.1.0"}`), 0o600); wErr != nil {
		t.Fatal(wErr)
	}
	sigPath := filepath.Join(dir, "manifest.json.sig")
	if wErr := os.WriteFile(sigPath, []byte("not base64 !!!"), 0o600); wErr != nil {
		t.Fatal(wErr)
	}

	err = verify(manifest, sigPath, []ed25519.PublicKey{pub})
	if err == nil {
		t.Fatal("verify accepted a signature that is not base64")
	}
	if !strings.Contains(err.Error(), "base64") {
		t.Errorf("error does not name the decode failure: %v", err)
	}
}
