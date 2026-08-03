package shellintegration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/pkg/sftp"
)

// ---------------------------------------------------------------------------
// In-process SSH server with an sftp subsystem, rooted at the real filesystem
// ---------------------------------------------------------------------------

// remoteTestSSHServer is a minimal SSH server that accepts exactly one user
// key and serves the "sftp" subsystem over every session channel. Absolute
// paths pass through to the real filesystem (the legacy sftp server only
// roots relative paths), so a test can use t.TempDir() as the remote home and
// assert on the directory afterwards.
type remoteTestSSHServer struct {
	t          *testing.T
	listener   net.Listener
	addr       string
	hostSigner gossh.Signer
	userSigner gossh.Signer
}

func startRemoteTestSSHServer(t *testing.T) *remoteTestSSHServer {
	t.Helper()

	hostSigner := testSigner(t)
	userSigner := testSigner(t)

	config := &gossh.ServerConfig{
		PublicKeyCallback: func(meta gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			if bytes.Equal(key.Marshal(), userSigner.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("gossh: unknown public key for %q", meta.User())
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("test server listen: %v", err)
	}

	srv := &remoteTestSSHServer{
		t:          t,
		listener:   listener,
		addr:       listener.Addr().String(),
		hostSigner: hostSigner,
		userSigner: userSigner,
	}
	go srv.acceptLoop(config)
	return srv
}

func testSigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	return signer
}

func (s *remoteTestSSHServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			// Listener closed (s.close) — stop.
			return
		}
		go s.serveConn(conn, config)
	}
}

func (s *remoteTestSSHServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		s.t.Logf("test server handshake: %v", err)
		_ = conn.Close()
		return
	}
	go gossh.DiscardRequests(reqs)

	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
			continue
		}
		ch, reqs, err := newChan.Accept()
		if err != nil {
			s.t.Logf("test server accept channel: %v", err)
			return
		}
		go s.handleSession(ch, reqs)
	}

	_ = sshConn.Close()
}

func (s *remoteTestSSHServer) handleSession(ch gossh.Channel, reqs <-chan *gossh.Request) {
	for req := range reqs {
		if req.Type != "subsystem" {
			_ = req.Reply(false, nil)
			continue
		}
		if len(req.Payload) < 4 || string(req.Payload[4:]) != "sftp" {
			_ = req.Reply(false, nil)
			continue
		}
		_ = req.Reply(true, nil)

		srv, err := sftp.NewServer(ch)
		if err != nil {
			s.t.Logf("test sftp server: %v", err)
			return
		}
		if err := srv.Serve(); err != nil && !errors.Is(err, io.EOF) {
			s.t.Logf("test sftp serve: %v", err)
		}
		// Close the channel back: the client's sftp Close() waits on its
		// recv goroutine, which only unblocks once it sees our close.
		_ = ch.Close()
		return
	}
}

func (s *remoteTestSSHServer) close() {
	_ = s.listener.Close()
}

func dialRemoteTestSSHClient(t *testing.T, srv *remoteTestSSHServer) *gossh.Client {
	t.Helper()

	client, err := gossh.Dial("tcp", srv.addr, &gossh.ClientConfig{
		User: "test",
		Auth: []gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)},
		HostKeyCallback: func(hostname string, remote net.Addr, key gossh.PublicKey) error {
			if !bytes.Equal(key.Marshal(), srv.hostSigner.PublicKey().Marshal()) {
				return fmt.Errorf("host key mismatch for %q", hostname)
			}
			return nil
		},
		Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("dial test ssh server: %v", err)
	}
	return client
}

// ---------------------------------------------------------------------------
// EnsureInstalledRemote
// ---------------------------------------------------------------------------

// TestEnsureInstalledRemote_InstallsScriptsAndGates proves the happy path over
// a real SSH/SFTP connection: scripts, both rc gates, and the VERSION marker
// land in the remote home, and a second call short-circuits cleanly.
func TestEnsureInstalledRemote_InstallsScriptsAndGates(t *testing.T) {
	srv := startRemoteTestSSHServer(t)
	defer srv.close()

	remoteHome := t.TempDir()
	ctx := context.Background()
	s := New(testLogger())

	client := dialRemoteTestSSHClient(t, srv)
	defer func() { _ = client.Close() }()

	if err := s.EnsureInstalledRemote(ctx, client, remoteHome); err != nil {
		t.Fatalf("EnsureInstalledRemote: %v", err)
	}

	for name := range scripts {
		if _, err := os.Stat(filepath.Join(remoteHome, dirName, name)); err != nil {
			t.Errorf("script %s missing after install: %v", name, err)
		}
	}

	vf := filepath.Join(remoteHome, dirName, versionFile)
	// #nosec G304 — test-only path built from t.TempDir + fixed constants.
	if data, err := os.ReadFile(vf); err != nil {
		t.Errorf("VERSION missing after install: %v", err)
	} else if strings.TrimSpace(string(data)) != version {
		t.Errorf("VERSION = %q, want %q", strings.TrimSpace(string(data)), version)
	}

	for rcFile, gate := range rcGate {
		// #nosec G304 — test-only path built from t.TempDir + fixed rc filename constants.
		// #nosec G304 — test-only path built from t.TempDir + fixed rc filename constants.
		rc, err := os.ReadFile(filepath.Join(remoteHome, rcFile))
		if err != nil {
			t.Errorf("gate not appended to %s: %v", rcFile, err)
			continue
		}
		if !strings.Contains(string(rc), gate) {
			t.Errorf("%s does not contain the gate line", rcFile)
		}
	}

	// Idempotent: a matching version short-circuits the second run.
	if err := s.EnsureInstalledRemote(ctx, client, remoteHome); err != nil {
		t.Fatalf("second EnsureInstalledRemote: %v", err)
	}
}

// TestEnsureInstalledRemote_SkipsVersionWhenGateFailsThenRetries guards
// nocx-zys2: the VERSION marker must not be recorded when a gate append
// failed, so the next launch retries instead of short-circuiting on a
// matching version. The invariant has both ends — the marker is absent after
// the failed run (a half-fix passes that) and the retry completes the install
// once the obstacle is gone (the assertion the half-fix fails).
func TestEnsureInstalledRemote_SkipsVersionWhenGateFailsThenRetries(t *testing.T) {
	srv := startRemoteTestSSHServer(t)
	defer srv.close()

	remoteHome := t.TempDir()
	ctx := context.Background()
	s := New(testLogger())

	// Force a gate-append failure for one rc file by making its path a
	// directory: opening it succeeds over SFTP, but reading it fails with
	// EISDIR.
	if err := os.Mkdir(filepath.Join(remoteHome, ".bashrc"), 0o750); err != nil {
		t.Fatalf("mkdir bad rc: %v", err)
	}

	client := dialRemoteTestSSHClient(t, srv)
	defer func() { _ = client.Close() }()

	if err := s.EnsureInstalledRemote(ctx, client, remoteHome); err != nil {
		t.Fatalf("EnsureInstalledRemote should stay non-fatal on gate failure: %v", err)
	}

	// Start of the interval: no marker, so no future run can short-circuit.
	vf := filepath.Join(remoteHome, dirName, versionFile)
	if _, err := os.Stat(vf); err == nil {
		t.Fatal("VERSION was written despite a gate-append failure — integration would be stranded")
	}

	// Remove the obstacle and run again: the second call must retry the gate
	// append, not short-circuit, and only then record the version.
	if err := os.Remove(filepath.Join(remoteHome, ".bashrc")); err != nil {
		t.Fatalf("remove bad rc: %v", err)
	}
	if err := s.EnsureInstalledRemote(ctx, client, remoteHome); err != nil {
		t.Fatalf("EnsureInstalledRemote retry: %v", err)
	}

	// End of the interval: the retry completed the install.
	// #nosec G304 — test-only path built from t.TempDir + fixed constants.
	if data, err := os.ReadFile(vf); err != nil {
		t.Fatalf("VERSION still missing after retry — install never recovered: %v", err)
	} else if strings.TrimSpace(string(data)) != version {
		t.Errorf("VERSION = %q, want %q", strings.TrimSpace(string(data)), version)
	}

	// #nosec G304 — test-only path built from t.TempDir + fixed rc filename constants.
	rc, err := os.ReadFile(filepath.Join(remoteHome, ".bashrc"))
	if err != nil {
		t.Fatalf("gate not appended on retry: %v", err)
	}
	if !strings.Contains(string(rc), rcGate[".bashrc"]) {
		t.Error("retry did not append the gate line to .bashrc")
	}
}
