package discovery

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// TestDetector_OverWire_NormalHost is the composition check the fake tests
// cannot give: a real pooled SSH connection, a real DiscoveryConn lease, and
// the real Detector, against an in-process SSH server that answers exec
// requests the way a normal Linux host's shell would. The server returns the
// REAL measured ss fixture; the detector must select ss once, parse 9
// listeners, and classify the mixed evidence correctly.
func TestDetector_OverWire_NormalHost(t *testing.T) {
	srv := startDiscoveryServer(t, func(cmd string) (stdout, stderr string, exit int) {
		if cmd != ssCmd {
			t.Errorf("exec command = %q, want the ss probe command", cmd)
		}
		return "NOCX-PD/1\n" + ssMixedFixture + "\nNOCX-PD/1\n", "", 0
	})
	client := discoveryTestClient(t, srv)
	opts := discoveryTestOpts(srv)

	conn, err := client.DiscoveryConn(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("DiscoveryConn: %v", err)
	}
	d := NewDetector(adaptSSH(conn), log.NewSlogAdapter(nil), WithSampleTimeout(5*time.Second))
	defer func() { _ = d.Close() }()

	s := d.Sample(context.Background())
	if s.Canceled {
		t.Fatal("sample canceled unexpectedly")
	}
	if s.State != StateAvailable {
		t.Fatalf("state = %v, want available; classification=%q probes=%v", s.State, s.Classification, s.ProbesTried)
	}
	if s.Probe != "ss" {
		t.Fatalf("probe = %q, want ss (ladder selected once)", s.Probe)
	}
	if len(s.Listeners) != 9 {
		t.Fatalf("listeners = %d, want 9", len(s.Listeners))
	}
	known, denied := 0, 0
	for _, l := range s.Listeners {
		switch l.Process.Evidence {
		case EvidenceKnown:
			known++
		case EvidencePermissionDenied:
			denied++
		}
	}
	if known != 3 || denied != 6 {
		t.Errorf("known = %d, denied = %d, want 3/6", known, denied)
	}

	// A second sample reuses the selected probe — no re-selection execs.
	s2 := d.Sample(context.Background())
	if s2.State != StateAvailable {
		t.Fatalf("second state = %v, want available", s2.State)
	}
}

// ---------------------------------------------------------------------------
// Minimal in-process SSH server with scripted exec. The internal/ssh test
// server is not importable across packages; this is a trimmed version for
// the composition check only.
// ---------------------------------------------------------------------------

type discoveryServer struct {
	t        *testing.T
	hostKey  gossh.Signer
	userKey  gossh.Signer
	addr     string
	listener net.Listener
	handler  func(cmd string) (stdout, stderr string, exit int)
}

func startDiscoveryServer(t *testing.T, handler func(cmd string) (stdout, stderr string, exit int)) *discoveryServer {
	t.Helper()
	hostKey := generateSigner(t)
	userKey := generateSigner(t)

	config := &gossh.ServerConfig{
		PublicKeyCallback: func(meta gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			if string(key.Marshal()) == string(userKey.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, os.ErrPermission
		},
	}
	config.AddHostKey(hostKey)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &discoveryServer{
		t:        t,
		hostKey:  hostKey,
		userKey:  userKey,
		addr:     listener.Addr().String(),
		listener: listener,
		handler:  handler,
	}
	t.Cleanup(func() { _ = listener.Close() })
	go srv.acceptLoop(config)
	return srv
}

func (s *discoveryServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.serveConn(conn, config)
	}
}

func (s *discoveryServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()
	go gossh.DiscardRequests(reqs)

	for newChan := range chans {
		switch newChan.ChannelType() {
		case "session":
			ch, reqs, err := newChan.Accept()
			if err != nil {
				return
			}
			go s.handleSession(ch, reqs)
		default:
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
		}
	}
}

func (s *discoveryServer) handleSession(ch gossh.Channel, reqs <-chan *gossh.Request) {
	for req := range reqs {
		switch req.Type {
		case "exec":
			var m struct{ Command string }
			if err := gossh.Unmarshal(req.Payload, &m); err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			stdout, stderr, exit := s.handler(m.Command)
			_, _ = ch.Write([]byte(stdout))
			_, _ = ch.Stderr().Write([]byte(stderr))
			_, _ = ch.SendRequest("exit-status", false, gossh.Marshal(struct{ Status uint32 }{uint32(exit)})) //nolint:gosec // SSH exit statuses are 0-255
			_ = ch.Close()
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}

func discoveryTestClient(t *testing.T, srv *discoveryServer) *ssh.RealClient {
	t.Helper()
	khPath := filepath.Join(t.TempDir(), "known_hosts")
	line := knownhosts.Line([]string{srv.addr}, srv.hostKey.PublicKey())
	if err := os.WriteFile(khPath, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	client, err := ssh.NewReal(log.NewSlogAdapter(nil), ssh.WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func discoveryTestOpts(srv *discoveryServer) []ssh.ConnectOption {
	return []ssh.ConnectOption{
		ssh.WithUser("test"),
		ssh.WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userKey)}),
	}
}

func generateSigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("create signer: %v", err)
	}
	return signer
}
