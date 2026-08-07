package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

// The fixture's user key has to be loadable by the OpenSSH CLIENT, which is
// what the nocxify journey actually runs — not merely by Go.
//
// It was not. writeUserKey wrote PKCS#8 ("PRIVATE KEY"), and OpenSSH reads
// ed25519 private keys only in the OpenSSH format. `ssh -i` answered
//
//	Load key "…/id_e2e": invalid format
//
// and, having no key to offer, never sent a publickey userauth request. Go's
// own ssh.ParsePrivateKey accepts BOTH encodings, so nothing on this side of
// the wire could notice — which is why this asserts the encoding rather than
// round-tripping through the library that is indifferent to it (nocx-z9s9.12).
func TestWriteUserKey_IsInTheFormatOpenSSHCanLoad(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	path, err := writeUserKey(priv)
	if err != nil {
		t.Fatalf("writeUserKey: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(path) })

	// The path is this test's own MkdirTemp output, not input.
	raw, err := os.ReadFile(path) //nolint:gosec // path is minted by writeUserKey above
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatal("the key file is not PEM at all")
	}
	if block.Type != "OPENSSH PRIVATE KEY" {
		t.Errorf("PEM block type = %q, want %q — OpenSSH cannot load an ed25519 key in any other encoding",
			block.Type, "OPENSSH PRIVATE KEY")
	}

	// And the paired assertion: it is still a key, not merely a correct label.
	if _, err := gossh.ParsePrivateKey(raw); err != nil {
		t.Errorf("ParsePrivateKey: %v", err)
	}
}

// CONN= must mean "a client reached me and tried to authenticate", for any
// client — not "a client offered a public key".
//
// It was wired only into PublicKeyCallback, so a client that cannot offer a key
// (because the key would not load, because it was told not to, because it has
// none) authenticated by password perfectly well while the fixture stayed
// silent. The journey waits 30 seconds for a line that will never come and then
// reports "saw 0/1 CONN= lines" — a timeout that names the signal and not the
// cause. Password-only is the case that has to work, so it is the case tested
// (nocx-z9s9.12).
func TestConnSignal_FiresForAClientThatOffersNoPublicKey(t *testing.T) {
	userSigner, _, _, err := signer()
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	hostSigner, _, _, err := signer()
	if err != nil {
		t.Fatalf("signer: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer func() { _ = ln.Close() }()

	fired := make(chan struct{}, 1)
	var once sync.Once
	config := buildConfig(userSigner, hostSigner, "banner", "the-password", func() {
		once.Do(func() { fired <- struct{}{} })
	})

	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		// Only the handshake matters here; the session that follows is
		// handleSession's subject, not this test's.
		_, _, _, _ = gossh.NewServerConn(conn, config)
	}()

	// A client with NO public key at all: password is the only method it can
	// offer, which is exactly the journey's hand-typed ssh once its -i key
	// fails to load.
	client, err := gossh.Dial("tcp", ln.Addr().String(), &gossh.ClientConfig{
		User: "e2e",
		Auth: []gossh.AuthMethod{gossh.Password("the-password")},
		// The host key is minted by this test a dozen lines up; there is no
		// trust decision here to get wrong.
		HostKeyCallback: gossh.InsecureIgnoreHostKey(), //nolint:gosec // fixture host key, minted in-process
		Timeout:         10 * time.Second,
	})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	select {
	case <-fired:
	case <-time.After(10 * time.Second):
		t.Fatal("no CONN= signal for a client that authenticated by password")
	}
}
