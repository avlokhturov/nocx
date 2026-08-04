package tunnel_test

// Real-seam tests for the production -R and -D strategies: a real SSH
// server in this process, the real ssh.RealClient as the connector, and the
// actual strategy code. What the fake connector models, these prove: -R
// delivers bytes from a remote-side dial to a local destination, port 0 is
// resolved by the SERVER and reported, a refused listen surfaces the
// policy-worded reason, the bind caveat is set for non-loopback requests,
// and a real SOCKS5 client reaches a target through -D over a real
// direct-tcpip channel.
//
// The server lives here (not in internal/ssh) because internal/ssh's test
// server is not importable from this package, and because the strategy-level
// proof needs the production connector, which only a test in this package
// can drive.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/tunnel"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ---------------------------------------------------------------------------
// Real seam server
// ---------------------------------------------------------------------------

// realSeamServer is the tunnel tests' in-process SSH server: it answers
// tcpip-forward / cancel-tcpip-forward global requests (binding a real
// loopback listener and delivering accepted connections to the client as
// forwarded-tcpip channels) and proxies direct-tcpip channels to their
// target. A scripted AllowTcpForwarding policy stands in for sshd's config.
type realSeamServer struct {
	t          *testing.T
	hostSigner gossh.Signer
	userSigner gossh.Signer
	listener   net.Listener
	addr       string

	mu           sync.Mutex
	allowForward bool
	binds        []realSeamBind
}

type realSeamBind struct {
	requestedHost string
	allocatedPort int
}

func startRealSeamServer(t *testing.T) *realSeamServer {
	t.Helper()
	hostSigner := realSeamSigner(t)
	userSigner := realSeamSigner(t)
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
		t.Fatalf("real seam server listen: %v", err)
	}
	srv := &realSeamServer{
		t:            t,
		hostSigner:   hostSigner,
		userSigner:   userSigner,
		listener:     listener,
		addr:         listener.Addr().String(),
		allowForward: true,
	}
	t.Cleanup(func() { _ = srv.listener.Close() })
	go srv.acceptLoop(config)
	return srv
}

func (s *realSeamServer) setAllowForward(allow bool) {
	s.mu.Lock()
	s.allowForward = allow
	s.mu.Unlock()
}

// lastAllocatedPort is the port the server really bound for the most recent
// tcpip-forward — what the reply must have carried.
func (s *realSeamServer) lastAllocatedPort() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.binds) == 0 {
		return 0
	}
	return s.binds[len(s.binds)-1].allocatedPort
}

func (s *realSeamServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.serveConn(conn, config)
	}
}

func (s *realSeamServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
	sshConn, chans, reqs, err := gossh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()

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
			// Dial the target BEFORE accepting: a refused target rejects
			// the open ("connect failed: …"), the signal the SOCKS reply
			// mapping needs. Accepting and closing later would read as EOF.
			s.handleDirectTCPIP(newChan, newChan.ExtraData())
		default:
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
		}
	}
}

func (s *realSeamServer) handleTCPIPForward(sshConn *gossh.ServerConn, req *gossh.Request) {
	// Payload: bind-addr (string), bind-port (uint32).
	p := newRealSeamPayloadReader(req.Payload)
	addr, ok := p.str()
	rport, okPort := p.u32()
	if !ok || !okPort {
		_ = req.Reply(false, nil)
		return
	}
	s.mu.Lock()
	allow := s.allowForward
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
	s.binds = append(s.binds, realSeamBind{requestedHost: addr, allocatedPort: tcpAddr.Port})
	s.mu.Unlock()

	if rport == 0 {
		_ = req.Reply(true, gossh.Marshal(struct{ Port uint32 }{uint32(tcpAddr.Port)})) //nolint:gosec // SSH protocol values fit uint32
	} else {
		_ = req.Reply(true, nil)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// The forwarded-tcpip payload's Addr is the REQUESTED host and
			// Port the ALLOCATED port — the key the client registered.
			s.relayForwarded(sshConn, addr, tcpAddr.Port, c)
		}
	}()
}

func (s *realSeamServer) relayForwarded(sshConn *gossh.ServerConn, requestedHost string, allocatedPort int, c net.Conn) {
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

func (s *realSeamServer) handleDirectTCPIP(newChan gossh.NewChannel, extraData []byte) {
	// Wire payload: dest-addr, dest-port, originator-addr, originator-port
	// (RFC 4254 §7.2). The originator fields are not needed; they are read
	// to validate the payload.
	p := newRealSeamPayloadReader(extraData)
	raddr, ok := p.str()
	rport, okPort := p.u32()
	if _, okOrigin := p.str(); !ok || !okPort || !okOrigin {
		_ = newChan.Reject(gossh.ConnectionFailed, "connect failed: malformed direct-tcpip payload")
		return
	}
	if _, okOriginPort := p.u32(); !okOriginPort {
		_ = newChan.Reject(gossh.ConnectionFailed, "connect failed: malformed direct-tcpip payload")
		return
	}
	targetConn, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(raddr, strconv.Itoa(int(rport))),
		5*time.Second,
	)
	if err != nil {
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

// realSeamPayloadReader decodes string/uint32 payloads by hand: gossh's
// Unmarshal refuses the protocol's lowercase field names from an external
// package (reflection cannot set unexported fields).
type realSeamPayloadReader struct{ r *bytes.Reader }

func newRealSeamPayloadReader(b []byte) *realSeamPayloadReader {
	return &realSeamPayloadReader{r: bytes.NewReader(b)}
}

func (p *realSeamPayloadReader) str() (string, bool) {
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

func (p *realSeamPayloadReader) u32() (uint32, bool) {
	var v uint32
	if err := binary.Read(p.r, binary.BigEndian, &v); err != nil {
		return 0, false
	}
	return v, true
}

// deadTarget returns an address on which nothing listens (the listener is
// closed before returning) — the refused-CONNECT target.
func deadTarget(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("dead target listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func realSeamSigner(t *testing.T) gossh.Signer {
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

// realSeamClient builds a real ssh.RealClient pointed at the server,
// trusting its host key, cleaned up with the test.
func realSeamClient(t *testing.T, srv *realSeamServer) *ssh.RealClient {
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

func realSeamOpts(srv *realSeamServer) []ssh.ConnectOption {
	return []ssh.ConnectOption{
		ssh.WithUser("test"),
		ssh.WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
	}
}

// startRealSeamTunnel creates and starts a tunnel through the real client
// and server.
func startRealSeamTunnel(t *testing.T, srv *realSeamServer, spec tunnel.Spec) *tunnel.Tunnel {
	t.Helper()
	client := realSeamClient(t, srv)
	tun, err := tunnel.New(spec, client)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := tun.Start(context.Background(), srv.addr, realSeamOpts(srv)...); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return tun
}

// ---------------------------------------------------------------------------
// SOCKS5 client
// ---------------------------------------------------------------------------

// socks5Connect dials proxyAddr, performs the no-auth SOCKS5 greeting and a
// CONNECT to target, and returns the relayed connection plus the reply code.
// The address type follows the host: an IP is sent as ATYP IPv4, anything
// else as ATYP domain — mirroring what real SOCKS5 clients do.
func socks5Connect(t *testing.T, proxyAddr, target string) (net.Conn, byte) {
	t.Helper()
	conn, dialErr := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if dialErr != nil {
		t.Fatalf("dial proxy: %v", dialErr)
	}
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil { // VER, NMETHODS=1, no-auth
		t.Fatalf("socks greeting write: %v", err)
	}
	var method [2]byte
	if _, err := io.ReadFull(conn, method[:]); err != nil {
		t.Fatalf("socks method reply: %v", err)
	}
	if method[0] != 0x05 || method[1] != 0x00 {
		_ = conn.Close()
		t.Fatalf("socks method reply = %x %x, want 05 00", method[0], method[1])
	}

	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		_ = conn.Close()
		t.Fatalf("target %q: %v", target, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		_ = conn.Close()
		t.Fatalf("target port %q: %v", portStr, err)
	}
	req := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host).To4(); ip != nil {
		req = append(req, 0x01)
		req = append(req, ip...)
	} else {
		req = append(req, 0x03, byte(len(host)))
		req = append(req, host...)
	}
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		_ = conn.Close()
		t.Fatalf("socks connect write: %v", err)
	}
	var rep [10]byte
	if _, err := io.ReadFull(conn, rep[:]); err != nil {
		_ = conn.Close()
		t.Fatalf("socks connect reply: %v", err)
	}
	if rep[0] != 0x05 {
		_ = conn.Close()
		t.Fatalf("socks reply VER = %d, want 5", rep[0])
	}
	return conn, rep[1]
}

// socksRoundTrip writes payload through a relayed SOCKS connection and reads
// the echo back.
func socksRoundTrip(t *testing.T, conn net.Conn, payload string) {
	t.Helper()
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("write through socks: %v", err)
	}
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read through socks: %v", err)
	}
	if string(buf) != payload {
		t.Fatalf("socks round trip = %q, want %q", buf, payload)
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestRemoteStrategy_RealServer_CarriesBytes is the -R proof the fake seam
// cannot give: the production remote strategy, over a real SSH connection,
// with the server actually binding a tcpip-forward listener. A "remote"
// dial to that listener reaches the local destination and the payload
// arrives intact. It also pins port 0: the reported bind carries the port
// the SERVER allocated, and the server's own record agrees.
func TestRemoteStrategy_RealServer_CarriesBytes(t *testing.T) {
	srv := startRealSeamServer(t)
	dest := echoTarget(t)

	tun := startRealSeamTunnel(t, srv, tunnel.Spec{
		Direction:   tunnel.DirectionRemote,
		Bind:        tunnel.Bind{Host: "127.0.0.1", Port: 0},
		Destination: dest,
	})
	defer tun.Stop()

	actual := tun.Actual()
	if actual.Port == 0 || actual.Port != srv.lastAllocatedPort() {
		t.Fatalf("reported port %d, server bound %d", actual.Port, srv.lastAllocatedPort())
	}
	if actual.Host != "127.0.0.1" {
		t.Fatalf("reported host %q, want 127.0.0.1", actual.Host)
	}

	// The "remote machine" dials the server's listener.
	addr := net.JoinHostPort(actual.Host, strconv.Itoa(actual.Port))
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("remote dial to server listener: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	payload := "ping through the real -R seam"
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("write from remote side: %v", err)
	}
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo on remote side: %v", err)
	}
	if string(buf) != payload {
		t.Fatalf("round trip = %q, want %q", buf, payload)
	}
}

// TestRemoteStrategy_RealServer_RefusedListen proves the refusal surfaces
// the policy-worded reason against the real server: AllowTcpForwarding off
// comes back as the tcpip-forward refusal, and the strategy names both
// possible causes because the wire cannot tell them apart.
func TestRemoteStrategy_RealServer_RefusedListen(t *testing.T) {
	srv := startRealSeamServer(t)
	srv.setAllowForward(false)

	client := realSeamClient(t, srv)
	tun, err := tunnel.New(tunnel.Spec{
		Direction:   tunnel.DirectionRemote,
		Bind:        tunnel.Bind{Host: "127.0.0.1", Port: 0},
		Destination: "127.0.0.1:1",
	}, client)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	err = tun.Start(context.Background(), srv.addr, realSeamOpts(srv)...)
	if err == nil {
		t.Fatal("Start: expected a refusal, got a running forward")
	}
	for _, want := range []string{"refused by server", "AllowTcpForwarding", "PermitListen"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("Start error %q does not name %q", err, want)
		}
	}
	if tun.State() != tunnel.StateStopped || tun.StopReason() != tunnel.StopReasonError {
		t.Fatalf("after refused start: state %q reason %q, want stopped/error", tun.State(), tun.StopReason())
	}
}

// TestRemoteStrategy_RealServer_Caveat pins the bind caveat: a requested
// non-loopback bind (0.0.0.0) carries it — the address is unverified, the
// URL may only work on the server — while a loopback request is clean.
func TestRemoteStrategy_RealServer_Caveat(t *testing.T) {
	t.Run("non-loopback-request-caveated", func(t *testing.T) {
		srv := startRealSeamServer(t)
		tun := startRealSeamTunnel(t, srv, tunnel.Spec{
			Direction:   tunnel.DirectionRemote,
			Bind:        tunnel.Bind{Host: "0.0.0.0", Port: 0},
			Destination: "127.0.0.1:1",
		})
		defer tun.Stop()

		caveat := tun.Caveat()
		if caveat == "" {
			t.Fatal("Caveat = empty for a non-loopback remote bind")
		}
		for _, want := range []string{"not verified", "may only work on the server"} {
			if !strings.Contains(caveat, want) {
				t.Fatalf("Caveat %q does not say %q", caveat, want)
			}
		}
	})

	t.Run("loopback-request-clean", func(t *testing.T) {
		srv := startRealSeamServer(t)
		tun := startRealSeamTunnel(t, srv, tunnel.Spec{
			Direction:   tunnel.DirectionRemote,
			Bind:        tunnel.Bind{Host: "127.0.0.1", Port: 0},
			Destination: "127.0.0.1:1",
		})
		defer tun.Stop()

		if caveat := tun.Caveat(); caveat != "" {
			t.Fatalf("Caveat = %q for a loopback remote bind, want empty", caveat)
		}
	})
}

// TestDynamicStrategy_RealServer_RealSOCKS5Client is the -D proof: a real
// SOCKS5 client (wire handshake on a socket) through the production dynamic
// strategy, over a real SSH connection, reaches a real target via a real
// direct-tcpip channel. Both address forms are exercised — IP and domain,
// the domain resolved by the server, which is the point of -D. Then a
// refused CONNECT answers 0x05 and the proxy keeps serving.
func TestDynamicStrategy_RealServer_RealSOCKS5Client(t *testing.T) {
	srv := startRealSeamServer(t)
	tun := startRealSeamTunnel(t, srv, tunnel.Spec{
		Direction: tunnel.DirectionDynamic,
		Bind:      tunnel.Bind{Host: "127.0.0.1", Port: 0},
	})
	defer tun.Stop()

	actual := tun.Actual()
	if actual.Port == 0 {
		t.Fatal("dynamic proxy reported port 0")
	}
	proxyAddr := net.JoinHostPort(actual.Host, strconv.Itoa(actual.Port))

	// CONNECT to the echo target by IP.
	target := echoTarget(t)
	conn, rep := socks5Connect(t, proxyAddr, target)
	if rep != 0x00 {
		_ = conn.Close()
		t.Fatalf("CONNECT reply = 0x%02x, want 0x00", rep)
	}
	socksRoundTrip(t, conn, "ping over a real direct-tcpip channel")
	_ = conn.Close()

	// CONNECT by domain name: the name is forwarded verbatim and resolved
	// by the server — the far-end resolution -D exists for.
	host, portStr, _ := net.SplitHostPort(target)
	domainTarget := net.JoinHostPort("localhost", portStr)
	conn2, rep2 := socks5Connect(t, proxyAddr, domainTarget)
	if rep2 != 0x00 {
		_ = conn2.Close()
		t.Fatalf("domain CONNECT reply = 0x%02x, want 0x00", rep2)
	}
	socksRoundTrip(t, conn2, "ping through the far-end name resolution")
	_ = conn2.Close()
	_ = host

	// A refused target answers 0x05 on its own stream; the proxy is still
	// serving afterwards.
	dead, rep3 := socks5Connect(t, proxyAddr, deadTarget(t))
	if rep3 != 0x05 {
		t.Fatalf("refused CONNECT reply = 0x%02x, want 0x05 (connection refused)", rep3)
	}
	_ = dead.Close()

	conn4, rep4 := socks5Connect(t, proxyAddr, target)
	if rep4 != 0x00 {
		_ = conn4.Close()
		t.Fatalf("CONNECT after refused stream reply = 0x%02x, want 0x00", rep4)
	}
	socksRoundTrip(t, conn4, "still serving after a refused CONNECT")
	_ = conn4.Close()
}
