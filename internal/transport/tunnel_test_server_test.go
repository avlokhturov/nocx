package transport

// In-process SSH server for the tunnel.* transport tests, modeled on the
// server internal/ssh tests use (ssh_real_test.go). It supports only what
// a forward needs: the handshake and direct-tcpip channels. The tunnel path
// never opens a session channel — RealClient.TunnelConn acquires the pooled
// connection and the lease dials direct-tcpip channels — so a session
// handler is deliberately absent: a test that opened one would fail loudly
// instead of silently passing.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type tunnelTestSSHServer struct {
	t          *testing.T
	hostSigner gossh.Signer
	userSigner gossh.Signer
	listener   net.Listener
	addr       string

	liveMu    sync.Mutex
	liveConns map[*gossh.ServerConn]struct{}
}

// startTunnelTestSSHServer starts an in-process SSH server authenticating
// userSigner's key, cleaned up with the test.
func startTunnelTestSSHServer(t *testing.T) *tunnelTestSSHServer {
	t.Helper()
	hostKey := tunnelTestSigner(t)
	userKey := tunnelTestSigner(t)

	config := &gossh.ServerConfig{
		PublicKeyCallback: func(meta gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			if bytes.Equal(key.Marshal(), userKey.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("gossh: unknown public key for %q", meta.User())
		},
	}
	config.AddHostKey(hostKey)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("test server listen: %v", err)
	}
	srv := &tunnelTestSSHServer{
		t:          t,
		hostSigner: hostKey,
		userSigner: userKey,
		listener:   listener,
		addr:       listener.Addr().String(),
		liveConns:  make(map[*gossh.ServerConn]struct{}),
	}
	t.Cleanup(srv.close)
	go srv.acceptLoop(config)
	return srv
}

func (s *tunnelTestSSHServer) close() {
	_ = s.listener.Close()
}

func (s *tunnelTestSSHServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.serveConn(conn, config)
	}
}

func (s *tunnelTestSSHServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	s.liveMu.Lock()
	s.liveConns[sshConn] = struct{}{}
	s.liveMu.Unlock()
	defer func() {
		s.liveMu.Lock()
		delete(s.liveConns, sshConn)
		s.liveMu.Unlock()
	}()

	go gossh.DiscardRequests(reqs)

	for newChan := range chans {
		switch newChan.ChannelType() {
		case "direct-tcpip":
			ch, reqs, err := newChan.Accept()
			if err != nil {
				continue
			}
			go s.handleDirectTCPIP(ch, reqs, newChan.ExtraData())
		default:
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
		}
	}
	_ = sshConn.Close()
}

// handleDirectTCPIP proxies the channel to the target in extraData: the
// "remote destination" side of a local forward.
func (s *tunnelTestSSHServer) handleDirectTCPIP(ch gossh.Channel, reqs <-chan *gossh.Request, extraData []byte) {
	defer func() { _ = ch.Close() }()

	// extraData: dest-addr (string), dest-port (uint32),
	// originator-addr (string), originator-port (uint32).
	r := bytes.NewReader(extraData)
	hostLen := tunnelReadUint32(r)
	hostBytes := make([]byte, hostLen)
	if _, err := r.Read(hostBytes); err != nil {
		return
	}
	host := string(hostBytes)
	port := tunnelReadUint32(r)

	targetAddr := net.JoinHostPort(host, strconv.Itoa(int(port)))
	targetConn, err := net.Dial("tcp", targetAddr)
	if err != nil {
		return
	}
	defer func() { _ = targetConn.Close() }()

	go gossh.DiscardRequests(reqs)

	done := make(chan struct{}, 2)
	go func() {
		defer func() { _ = targetConn.Close() }()
		_, _ = io.Copy(targetConn, ch)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(ch, targetConn)
		done <- struct{}{}
	}()
	<-done
}

func tunnelReadUint32(r *bytes.Reader) uint32 {
	var v uint32
	_ = binary.Read(r, binary.BigEndian, &v)
	return v
}

func tunnelTestSigner(t *testing.T) gossh.Signer {
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

// tunnelTestClient builds a RealClient pointed at the test server, trusting
// its host key, cleaned up with the test.
func tunnelTestClient(t *testing.T, srv *tunnelTestSSHServer) *ssh.RealClient {
	t.Helper()
	line := knownhosts.Line([]string{srv.addr}, srv.hostSigner.PublicKey())
	dir := t.TempDir()
	path := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	client, err := ssh.NewReal(log.NewSlogAdapter(nil), ssh.WithKnownHostsFile(path))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// tunnelResolveConfig is the ConnectConfig a forward to the test server
// needs: user test, public-key auth with the server's user key. The
// transport's tunnel.open copies the WHOLE resolved config into the
// connector's options, so this is what exercises that path.
func tunnelResolveConfig(srv *tunnelTestSSHServer) *ssh.ConnectConfig {
	return &ssh.ConnectConfig{
		User:        "test",
		AuthMethods: []gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)},
	}
}

// fixedProfileResolver resolves every non-empty profile id to one host and
// config — the transport's ProfileResolver seam for tests.
type fixedProfileResolver struct {
	host string
	cfg  *ssh.ConnectConfig
}

func (f *fixedProfileResolver) Resolve(profileID string) (string, *ssh.ConnectConfig, error) {
	if profileID == "" {
		return "", nil, fmt.Errorf("no profile id")
	}
	return f.host, f.cfg, nil
}

// startEchoTarget listens on a loopback port and echoes every accepted
// connection back — the "remote destination" a forward reaches over the
// SSH connection.
func startEchoTarget(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo target listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln.Addr().String()
}

// busyPort returns a port that is already bound (the listener stays open),
// standing in for EADDRINUSE.
func busyPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("busy port listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("busy port: not a TCP address: %T", ln.Addr())
	}
	return tcpAddr.Port
}
