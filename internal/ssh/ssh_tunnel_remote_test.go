package ssh

// Real-seam tests for the -R half of TunnelConn (spec §7.2): lease.Listen
// against a server that actually speaks tcpip-forward, delivering accepted
// connections as forwarded-tcpip channels. The shared testSSHServer
// (ssh_real_test.go) deliberately discards global requests — which is what
// makes -R untestable against it — so this file carries its own server that
// implements the forward protocol both directions, with scriptable
// AllowTcpForwarding / PermitListen policy.
//
// What the fake lease models, these tests prove against real gossh: the
// listen reply carries the port the server actually allocated, the accepted
// channel carries bytes, and a policy refusal surfaces as a refusal.
import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// forwardTestSSHServer is an in-process SSH server that speaks the forward
// protocol both directions. It answers tcpip-forward / cancel-tcpip-forward
// global requests — binding a real loopback listener per request and
// honoring a scripted policy — and proxies direct-tcpip channels to their
// target. An accepted connection on a forwarded listener is delivered to
// the client as a forwarded-tcpip channel, the exact -R data path OpenSSH
// provides.
type forwardTestSSHServer struct {
	t          *testing.T
	hostSigner gossh.Signer
	userSigner gossh.Signer
	listener   net.Listener
	addr       string

	mu           sync.Mutex
	allowForward bool // AllowTcpForwarding policy; default true
	permitListen func(host string, port int) bool
	binds        []forwardBind
}

// forwardBind records one successful tcpip-forward bind: what was requested
// and what the server actually bound. A requested port 0 is resolved here,
// so allocatedPort is the truth the reply must have carried.
type forwardBind struct {
	requestedHost string
	requestedPort int
	allocatedPort int
}

// startForwardTestSSHServer starts the server, cleaned up with the test.
func startForwardTestSSHServer(t *testing.T) *forwardTestSSHServer {
	t.Helper()
	hostKey := generateSigner(t)
	userKey := generateSigner(t)
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
		t.Fatalf("forward test server listen: %v", err)
	}
	srv := &forwardTestSSHServer{
		t:            t,
		hostSigner:   hostKey,
		userSigner:   userKey,
		listener:     listener,
		addr:         listener.Addr().String(),
		allowForward: true,
	}
	t.Cleanup(srv.close)
	go srv.acceptLoop(config)
	return srv
}

// setAllowForward scripts the AllowTcpForwarding policy. Call before the
// test's first Listen.
func (s *forwardTestSSHServer) setAllowForward(allow bool) {
	s.mu.Lock()
	s.allowForward = allow
	s.mu.Unlock()
}

// setPermitListen scripts the PermitListen policy: the hook decides whether
// a requested bind is permitted, mirroring sshd's PermitListen. Nil (the
// default) permits everything. Call before the test's first Listen.
func (s *forwardTestSSHServer) setPermitListen(fn func(host string, port int) bool) {
	s.mu.Lock()
	s.permitListen = fn
	s.mu.Unlock()
}

// lastBind returns the most recent successful tcpip-forward bind, or zero
// values when none succeeded. The allocated port is what the server really
// bound — the value the tcpip-forward reply must have carried.
func (s *forwardTestSSHServer) lastBind() (requestedHost string, allocatedPort int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.binds) == 0 {
		return "", 0
	}
	b := s.binds[len(s.binds)-1]
	return b.requestedHost, b.allocatedPort
}

func (s *forwardTestSSHServer) close() {
	_ = s.listener.Close()
}

func (s *forwardTestSSHServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.serveConn(conn, config)
	}
}

func (s *forwardTestSSHServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()

	// Global requests are SERVICED, not discarded: a tcpip-forward request
	// left unanswered hangs the client's Listen forever (the discarded
	// reply is exactly why the shared testSSHServer cannot do -R).
	go func() {
		for req := range reqs {
			switch req.Type {
			case "tcpip-forward":
				s.handleTCPIPForward(sshConn, req)
			case "cancel-tcpip-forward":
				_ = req.Reply(true, nil)
			default:
				_ = req.Reply(false, nil)
			}
		}
	}()

	for newChan := range chans {
		switch newChan.ChannelType() {
		case "direct-tcpip":
			// Dial the target BEFORE accepting the channel: a refused
			// target rejects the open itself ("connect failed: …"), which
			// is the refusal the SOCKS mapping needs to see. Accepting
			// first and closing later would surface as EOF, not a refusal.
			s.handleDirectTCPIP(newChan, newChan.ExtraData())
		default:
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
		}
	}
}

// forwardPayloadReader decodes the forwarding payloads the protocol puts on
// the wire as string/uint32 sequences (RFC 4254 §7). gossh's Unmarshal
// cannot decode them into an external package's struct — the wire field
// names are lowercase and reflection refuses to set unexported fields — so
// the payloads are parsed by hand, the same way the shared testSSHServer
// parses direct-tcpip extraData.
type forwardPayloadReader struct{ r *bytes.Reader }

func newForwardPayloadReader(b []byte) *forwardPayloadReader {
	return &forwardPayloadReader{r: bytes.NewReader(b)}
}

func (p *forwardPayloadReader) str() (string, bool) {
	var l uint32
	if err := binary.Read(p.r, binary.BigEndian, &l); err != nil {
		return "", false
	}
	b := make([]byte, l)
	if _, err := io.ReadFull(p.r, b); err != nil {
		return "", false
	}
	return string(b), true
}

func (p *forwardPayloadReader) u32() (uint32, bool) {
	var v uint32
	if err := binary.Read(p.r, binary.BigEndian, &v); err != nil {
		return 0, false
	}
	return v, true
}

// handleTCPIPForward binds a real loopback listener for the request and
// replies with the allocated port (for a port-0 request). A refused bind —
// the AllowTcpForwarding policy, the PermitListen hook, or the OS — replies
// false, which is the only refusal the client can see.
func (s *forwardTestSSHServer) handleTCPIPForward(sshConn *gossh.ServerConn, req *gossh.Request) {
	// Payload: bind-addr (string), bind-port (uint32).
	p := newForwardPayloadReader(req.Payload)
	addr, ok := p.str()
	rport, okPort := p.u32()
	if !ok || !okPort {
		_ = req.Reply(false, nil)
		return
	}
	s.mu.Lock()
	allow := s.allowForward && (s.permitListen == nil || s.permitListen(addr, int(rport)))
	s.mu.Unlock()
	if !allow {
		_ = req.Reply(false, nil)
		return
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(addr, strconv.Itoa(int(rport))))
	if err != nil {
		_ = req.Reply(false, nil)
		return
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		_ = req.Reply(false, nil)
		return
	}

	s.mu.Lock()
	s.binds = append(s.binds, forwardBind{
		requestedHost: addr,
		requestedPort: int(rport),
		allocatedPort: tcpAddr.Port,
	})
	s.mu.Unlock()

	// The reply carries the allocated port only for a port-0 request
	// (RFC 4254 §7.1): the client parses it only then, and OpenSSH sends
	// nothing for an explicit port.
	if rport == 0 {
		_ = req.Reply(true, gossh.Marshal(struct{ Port uint32 }{uint32(tcpAddr.Port)})) //nolint:gosec // SSH protocol values fit uint32
	} else {
		_ = req.Reply(true, nil)
	}

	// Deliver accepted connections as forwarded-tcpip channels. The
	// payload's Addr is the REQUESTED host and Port the ALLOCATED port,
	// because that is the key the client's listener was registered under.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.relayForwarded(sshConn, addr, tcpAddr.Port, c)
		}
	}()
}

// relayForwarded opens a forwarded-tcpip channel to the client for one
// accepted connection and copies bytes both ways. OriginAddr/OriginPort
// name the "remote machine" that dialed the listener.
func (s *forwardTestSSHServer) relayForwarded(sshConn *gossh.ServerConn, requestedHost string, allocatedPort int, c net.Conn) {
	defer func() { _ = c.Close() }()
	originHost, originPortStr, err := net.SplitHostPort(c.RemoteAddr().String())
	if err != nil {
		return
	}
	originPort, err := strconv.Atoi(originPortStr)
	if err != nil {
		return
	}
	payload := gossh.Marshal(struct {
		Addr       string
		Port       uint32
		OriginAddr string
		OriginPort uint32
	}{
		Addr:       requestedHost,
		Port:       uint32(allocatedPort), //nolint:gosec // SSH protocol values fit uint32
		OriginAddr: originHost,
		OriginPort: uint32(originPort), //nolint:gosec // SSH protocol values fit uint32
	})
	ch, reqs, err := sshConn.OpenChannel("forwarded-tcpip", payload)
	if err != nil {
		return
	}
	defer func() { _ = ch.Close() }()
	go gossh.DiscardRequests(reqs)
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(c, ch); done <- struct{}{} }()
	go func() { _, _ = io.Copy(ch, c); done <- struct{}{} }()
	<-done
}

// handleDirectTCPIP proxies a direct-tcpip channel to its target. The dial
// happens before Accept so a refused target rejects the open (see
// serveConn).
func (s *forwardTestSSHServer) handleDirectTCPIP(newChan gossh.NewChannel, extraData []byte) {
	// Wire payload: dest-addr (string), dest-port (uint32),
	// originator-addr (string), originator-port (uint32). The originator
	// fields are not needed; they are read to validate the payload.
	p := newForwardPayloadReader(extraData)
	raddr, ok := p.str()
	rport, okPort := p.u32()
	if _, okOrigin := p.str(); !ok || !okPort || !okOrigin {
		_ = newChan.Reject(gossh.ConnectionFailed, "connect failed: malformed direct-tcpip payload")
		return
	}
	targetConn, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(raddr, strconv.Itoa(int(rport))),
		5*time.Second,
	)
	if err != nil {
		// OpenSSH surfaces a refused target as a rejected channel open
		// with this text; the client's SOCKS mapping string-matches it.
		_ = newChan.Reject(gossh.ConnectionFailed, "connect failed: "+err.Error())
		return
	}
	defer func() { _ = targetConn.Close() }()

	ch, reqs, err := newChan.Accept()
	if err != nil {
		return
	}
	defer func() { _ = ch.Close() }()
	go gossh.DiscardRequests(reqs)
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(targetConn, ch); done <- struct{}{} }()
	go func() { _, _ = io.Copy(ch, targetConn); done <- struct{}{} }()
	<-done
}

// forwardTestClient builds a RealClient pointed at the server, trusting its
// host key, cleaned up with the test.
func forwardTestClient(t *testing.T, srv *forwardTestSSHServer) *RealClient {
	t.Helper()
	line := knownhosts.Line([]string{srv.addr}, srv.hostSigner.PublicKey())
	dir := t.TempDir()
	path := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	client, err := NewReal(log.NewSlogAdapter(nil), WithKnownHostsFile(path))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func forwardTestOpts(srv *forwardTestSSHServer) []ConnectOption {
	return []ConnectOption{
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
	}
}

func forwardTestLease(t *testing.T, srv *forwardTestSSHServer) TunnelConn {
	t.Helper()
	client := forwardTestClient(t, srv)
	lease, err := client.TunnelConn(t.Context(), srv.addr, forwardTestOpts(srv)...)
	if err != nil {
		t.Fatalf("TunnelConn: %v", err)
	}
	t.Cleanup(func() { _ = lease.Close() })
	return lease
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestTunnelConn_Listen_CarriesBytes proves the -R data path against a
// server that actually implements tcpip-forward: a "remote" dial to the
// server's listener is delivered to the client as a forwarded-tcpip channel
// (ln.Accept), a local dial stands in for the -R strategy's destination
// dial, and the payload arrives intact. It also pins the port-0 contract:
// the listener's Addr reports the port the server actually allocated, and
// the tcpip-forward reply carried exactly that.
func TestTunnelConn_Listen_CarriesBytes(t *testing.T) {
	srv := startForwardTestSSHServer(t)
	lease := forwardTestLease(t, srv)

	ln, err := lease.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer func() { _ = ln.Close() }()

	// The reported port is the server's own allocation — the reply carried
	// it, never a guessed 0.
	actual, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("listener Addr = %T, want *net.TCPAddr", ln.Addr())
	}
	if wantHost, wantPort := srv.lastBind(); wantHost != "127.0.0.1" || wantPort == 0 || actual.Port != wantPort {
		t.Fatalf("listen reported %s but the server bound %q:%d", ln.Addr(), wantHost, wantPort)
	}

	// The "remote machine" dials the server's listener.
	remote, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(actual.Port)))
	if err != nil {
		t.Fatalf("remote dial to server listener: %v", err)
	}
	defer func() { _ = remote.Close() }()

	// The client side accepts the forwarded-tcpip channel and dials the
	// local destination — the two halves of the -R strategy's relay.
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	defer func() { _ = accepted.Close() }()

	local, err := net.Dial("tcp", startEchoTarget(t))
	if err != nil {
		t.Fatalf("local destination dial: %v", err)
	}
	defer func() { _ = local.Close() }()

	relayed := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(local, accepted); relayed <- struct{}{} }()
	go func() { _, _ = io.Copy(accepted, local); relayed <- struct{}{} }()

	// Payload round trip: remote → server → channel → relay → local echo
	// → back.
	payload := []byte("ping through the real tcpip-forward seam")
	if _, err := remote.Write(payload); err != nil {
		t.Fatalf("write from remote side: %v", err)
	}
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(remote, buf); err != nil {
		t.Fatalf("read echo on remote side: %v", err)
	}
	if !bytes.Equal(buf, payload) {
		t.Fatalf("round trip = %q, want %q", buf, payload)
	}
	_ = remote.Close()
	_ = accepted.Close()
	_ = local.Close()
}

// TestTunnelConn_Listen_RefusedByPolicy proves the refusal path: both an
// AllowTcpForwarding=no and a PermitListen-mismatch bind are refused by the
// server, and the client sees the refusal — the same wire signal in both
// cases, which is why the -R strategy's error names both policies.
func TestTunnelConn_Listen_RefusedByPolicy(t *testing.T) {
	t.Run("allow-forwarding-off", func(t *testing.T) {
		srv := startForwardTestSSHServer(t)
		srv.setAllowForward(false)
		lease := forwardTestLease(t, srv)

		_, err := lease.Listen("127.0.0.1:0")
		if err == nil {
			t.Fatal("Listen: expected a refusal, got a listener")
		}
		if !bytes.Contains([]byte(err.Error()), []byte("denied by peer")) {
			t.Fatalf("Listen error = %q, want the refusal", err)
		}
	})

	t.Run("permit-listen-mismatch", func(t *testing.T) {
		srv := startForwardTestSSHServer(t)
		srv.setPermitListen(func(host string, port int) bool { return false })
		lease := forwardTestLease(t, srv)

		_, err := lease.Listen("127.0.0.1:0")
		if err == nil {
			t.Fatal("Listen: expected a refusal, got a listener")
		}
		if !bytes.Contains([]byte(err.Error()), []byte("denied by peer")) {
			t.Fatalf("Listen error = %q, want the refusal", err)
		}
	})
}

// TestTunnelConn_Listen_HostnameReportsZeroIP pins the transport's answer
// for a hostname bind: the server resolves it, the listener's Addr reports
// 0.0.0.0 (gossh cannot know what the server bound), and the port is still
// the allocated one. This is the behavior the -R bind caveat exists for —
// the requested host is never verified on the wire.
func TestTunnelConn_Listen_HostnameReportsZeroIP(t *testing.T) {
	srv := startForwardTestSSHServer(t)
	lease := forwardTestLease(t, srv)

	ln, err := lease.Listen("localhost:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer func() { _ = ln.Close() }()

	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("parse listener Addr: %v", err)
	}
	port, _ := strconv.Atoi(portStr)
	if host != "0.0.0.0" {
		t.Fatalf("hostname bind Addr host = %q, want 0.0.0.0 (unverifiable on the wire)", host)
	}
	if wantHost, wantPort := srv.lastBind(); wantHost != "localhost" || port != wantPort {
		t.Fatalf("listener reported %s but the server bound %q:%d", ln.Addr(), wantHost, wantPort)
	}
}
