package ssh

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"github.com/shady2k/nocx/internal/log"
	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ---------------------------------------------------------------------------
// FSConn — the owned SFTP lease for the file manager (spec §3, D3)
// ---------------------------------------------------------------------------

func TestFSConn_ImplementsInterface(t *testing.T) {
	var _ FSConn = (*fsConn)(nil)
}

// ---------------------------------------------------------------------------
// In-process SSH test server with an SFTP subsystem
// ---------------------------------------------------------------------------

// fsServerMode selects how the test server answers the sftp subsystem.
type fsServerMode int

const (
	// fsModeReal serves a real SFTP server over a temp directory.
	fsModeReal fsServerMode = iota
	// fsModeRefuseSubsystem replies false to the sftp subsystem request.
	fsModeRefuseSubsystem
	// fsModeNeverReply answers the version handshake, then swallows every
	// request without ever answering one.
	fsModeNeverReply
	// fsModeNeverInit accepts the subsystem and never answers the version
	// handshake either — FSConn construction itself must time out.
	fsModeNeverInit
)

// fsTestServer is the FSConn test double for testSSHServer: the existing
// fixture has no SFTP subsystem, so this one exists beside it, in this file
// only, with just the surface the FSConn tests need.
type fsTestServer struct {
	t          *testing.T
	mode       fsServerMode
	rootDir    string // served as the SFTP root in fsModeReal
	hostSigner gossh.Signer
	userSigner gossh.Signer
	listener   net.Listener
	addr       string

	mu          sync.Mutex
	maxSessions int
	sessions    int
	// requestSeen is signaled once per SFTP request the never-reply server
	// has swallowed, so a test knows a call is genuinely in flight before
	// it acts. Buffered; drops when full.
	requestSeen chan struct{}

	liveMu    sync.Mutex
	liveConns map[*gossh.ServerConn]struct{}
}

func startFSTestServer(t *testing.T, mode fsServerMode) *fsTestServer {
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
		t.Fatalf("test server listen: %v", err)
	}
	srv := &fsTestServer{
		t:           t,
		mode:        mode,
		rootDir:     t.TempDir(),
		hostSigner:  hostKey,
		userSigner:  userKey,
		listener:    listener,
		addr:        listener.Addr().String(),
		requestSeen: make(chan struct{}, 16),
		liveConns:   make(map[*gossh.ServerConn]struct{}),
	}
	t.Cleanup(func() { _ = listener.Close() })
	go srv.acceptLoop(config)
	return srv
}

func (s *fsTestServer) setMaxSessions(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxSessions = n
}

// killConns closes every established server-side connection, simulating
// transport loss for the clients.
func (s *fsTestServer) killConns() {
	s.liveMu.Lock()
	conns := make([]*gossh.ServerConn, 0, len(s.liveConns))
	for c := range s.liveConns {
		conns = append(conns, c)
	}
	s.liveMu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

func (s *fsTestServer) acceptLoop(config *gossh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.serveConn(conn, config)
	}
}

func (s *fsTestServer) serveConn(conn net.Conn, config *gossh.ServerConfig) {
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
		case "session":
			s.mu.Lock()
			maxSessions := s.maxSessions
			if maxSessions > 0 && s.sessions >= maxSessions {
				s.mu.Unlock()
				_ = newChan.Reject(gossh.ResourceShortage, "too many sessions")
				continue
			}
			s.sessions++
			s.mu.Unlock()
			ch, reqs, err := newChan.Accept()
			if err != nil {
				return
			}
			go s.handleSession(ch, reqs)
		default:
			_ = newChan.Reject(gossh.UnknownChannelType, "unknown channel type")
		}
	}
	_ = sshConn.Close()
}

// handleSession serves one session channel. Each session runs exactly one
// inline loop, so the SFTP server never competes with the echo loop for the
// channel's bytes: a shell request enters the echo loop (the tab's
// interactive session, mirroring testSSHServer), a subsystem request enters
// the SFTP dispatcher, everything else is refused.
func (s *fsTestServer) handleSession(ch gossh.Channel, reqs <-chan *gossh.Request) {
	for req := range reqs {
		switch req.Type {
		case "shell":
			_ = req.Reply(true, nil)
			s.echoLoop(ch)
			return
		case "subsystem":
			var m struct{ Subsystem string }
			if err := gossh.Unmarshal(req.Payload, &m); err != nil || m.Subsystem != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			if s.mode == fsModeRefuseSubsystem {
				_ = req.Reply(false, nil)
				return
			}
			_ = req.Reply(true, nil)
			switch s.mode {
			case fsModeNeverReply:
				s.serveNeverReply(ch, false)
			case fsModeNeverInit:
				s.serveNeverReply(ch, true)
			default:
				s.serveSFTP(ch)
			}
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
	_ = ch.Close()
}

// echoLoop mirrors testSSHServer's interactive session: whatever the tab
// writes comes back prefixed with "echo:".
func (s *fsTestServer) echoLoop(ch gossh.Channel) {
	buf := make([]byte, 4096)
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			reply := append([]byte("echo:"), buf[:n]...)
			_, _ = ch.Write(reply)
		}
		if err != nil {
			return
		}
	}
}

func (s *fsTestServer) serveSFTP(ch gossh.Channel) {
	defer func() { _ = ch.Close() }()
	srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(s.rootDir))
	if err != nil {
		return
	}
	_ = srv.Serve()
}

// serveNeverReply is the server half of the close-to-cancel proof: it
// answers the client's version handshake (or not, when neverInit) and then
// swallows every request without ever answering. A call against this server
// can only be unblocked by closing the subsystem — or by the lane's hard
// timeout, which does exactly that.
func (s *fsTestServer) serveNeverReply(ch gossh.Channel, neverInit bool) {
	defer func() { _ = ch.Close() }()
	// The first packet is SSH_FXP_INIT (type 1). Answer it unless the mode
	// wants the handshake to hang too.
	typ, _, err := readSFTPPacket(ch)
	if err != nil {
		return
	}
	if !neverInit && typ == 1 {
		// SSH_FXP_VERSION (type 2), protocol version 3: 4-byte length 5,
		// 1-byte type, 4-byte version.
		if _, err := ch.Write([]byte{0, 0, 0, 5, 2, 0, 0, 0, 3}); err != nil {
			return
		}
	}
	for {
		if _, _, err := readSFTPPacket(ch); err != nil {
			return
		}
		select {
		case s.requestSeen <- struct{}{}:
		default:
		}
	}
}

// readSFTPPacket reads one length-prefixed SFTP packet, returning its type
// byte and payload (type stripped).
func readSFTPPacket(r io.Reader) (byte, []byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(lenBuf[:])
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

// fsTestClient builds a RealClient pointed at the test server, cleaned up
// with the test (clone of tunnelTestClient, which is typed to testSSHServer).
func fsTestClient(t *testing.T, srv *fsTestServer) *RealClient {
	t.Helper()
	khPath := fsWriteKnownHosts(t, srv, srv.addr)
	client, err := NewReal(log.NewSlogAdapter(nil), WithKnownHostsFile(khPath))
	if err != nil {
		t.Fatalf("NewReal: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func fsConnectOpts(srv *fsTestServer) []ConnectOption {
	return []ConnectOption{
		WithUser("test"),
		WithAuthMethods([]gossh.AuthMethod{gossh.PublicKeys(srv.userSigner)}),
	}
}

func fsWriteKnownHosts(t *testing.T, srv *fsTestServer, addr string) string {
	t.Helper()
	line := knownhosts.Line([]string{addr}, srv.hostSigner.PublicKey())
	dir := t.TempDir()
	path := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	return path
}

// waitPoolEmpty polls the pool count down to zero, so a regression that
// leaves a lease's reference behind fails the test instead of hanging it.
func waitPoolEmpty(t *testing.T, client *RealClient) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for client.pool.Count() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("pool count = %d, want 0", client.pool.Count())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// Ordinary success — every operation works against a real SFTP server
// ---------------------------------------------------------------------------

func TestFSConn_ReadDir_ReturnsEntries(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	if err := os.WriteFile(filepath.Join(srv.rootDir, "alpha.txt"), []byte("a"), 0o600); err != nil {
		t.Fatalf("write alpha: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srv.rootDir, "beta.txt"), []byte("b"), 0o600); err != nil {
		t.Fatalf("write beta: %v", err)
	}
	if err := os.Mkdir(filepath.Join(srv.rootDir, "sub"), 0o750); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	entries, err := fc.ReadDir(context.Background(), ".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	names := make(map[string]bool, len(entries))
	for _, e := range entries {
		names[e.Name()] = true
	}
	for _, want := range []string{"alpha.txt", "beta.txt", "sub"} {
		if !names[want] {
			t.Errorf("ReadDir missing %q (got %v)", want, entries)
		}
	}

	if err := fc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	waitPoolEmpty(t, client)
}

func TestFSConn_Stat_Lstat_RealPath(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	if err := os.WriteFile(filepath.Join(srv.rootDir, "data.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatalf("write data: %v", err)
	}
	if err := os.Symlink("data.txt", filepath.Join(srv.rootDir, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}
	defer func() { _ = fc.Close() }()

	info, err := fc.Stat("data.txt")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Name() != "data.txt" || info.Size() != 5 {
		t.Errorf("Stat = %v (size %d), want data.txt size 5", info.Name(), info.Size())
	}

	// Stat follows the symlink; Lstat does not.
	info, err = fc.Stat("link")
	if err != nil {
		t.Fatalf("Stat(link): %v", err)
	}
	if info.Size() != 5 {
		t.Errorf("Stat(link) size = %d, want 5 (followed)", info.Size())
	}
	lst, err := fc.Lstat("link")
	if err != nil {
		t.Fatalf("Lstat(link): %v", err)
	}
	if lst.Mode()&os.ModeSymlink == 0 {
		t.Errorf("Lstat(link) mode = %v, want symlink", lst.Mode())
	}

	rp, err := fc.RealPath(".")
	if err != nil {
		t.Fatalf("RealPath: %v", err)
	}
	if rp == "" {
		t.Error("RealPath returned an empty path")
	}
}

func TestFSConn_ReadFile_ContentAndTruncation(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	if err := os.WriteFile(filepath.Join(srv.rootDir, "data.txt"), []byte("hello world"), 0o600); err != nil {
		t.Fatalf("write data: %v", err)
	}
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}
	defer func() { _ = fc.Close() }()

	data, truncated, err := fc.ReadFile(context.Background(), "data.txt", 100)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "hello world" || truncated {
		t.Errorf("ReadFile = %q truncated=%v, want %q false", data, truncated, "hello world")
	}

	data, truncated, err = fc.ReadFile(context.Background(), "data.txt", 5)
	if err != nil {
		t.Fatalf("ReadFile bounded: %v", err)
	}
	if string(data) != "hello" || !truncated {
		t.Errorf("ReadFile(5) = %q truncated=%v, want %q true", data, truncated, "hello")
	}

	// maxBytes <= 0 means the lease default cap; the file is well under it.
	data, truncated, err = fc.ReadFile(context.Background(), "data.txt", 0)
	if err != nil || string(data) != "hello world" || truncated {
		t.Errorf("ReadFile(0) = %q truncated=%v err=%v, want full content", data, truncated, err)
	}

	if _, _, err := fc.ReadFile(context.Background(), "missing.txt", 10); err == nil {
		t.Error("ReadFile(missing) = nil error, want the remote status error")
	}
}

// ---------------------------------------------------------------------------
// Construction failures — three different facts, three different errors
// ---------------------------------------------------------------------------

// TestFSConn_Handshake_SessionRefused_MaxSessions proves the MaxSessions-1
// case over a real channel open: the interactive shell holds the only
// session channel, FSConn's NewSession is rejected with ResourceShortage,
// and the shell stays fully usable.
func TestFSConn_Handshake_SessionRefused_MaxSessions(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	srv.setMaxSessions(1)
	client := fsTestClient(t, srv)
	opts := fsConnectOpts(srv)

	tab, err := client.Connect(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = tab.Close() }()

	fc, err := client.FSConn(context.Background(), srv.addr, opts...)
	if !errors.Is(err, ErrFSSessionRefused) {
		t.Fatalf("FSConn error = %v, want ErrFSSessionRefused", err)
	}
	if fc != nil {
		t.Fatal("FSConn returned a lease alongside the refusal error")
	}

	// The interactive session survived the refusal.
	if _, err := tab.Write([]byte("hi")); err != nil {
		t.Fatalf("tab write after refusal: %v", err)
	}
	if got := readWithTimeout(t, tab); got != "echo:hi" {
		t.Errorf("tab echo = %q, want %q", got, "echo:hi")
	}
}

func TestFSConn_Handshake_SubsystemRefused(t *testing.T) {
	srv := startFSTestServer(t, fsModeRefuseSubsystem)
	client := fsTestClient(t, srv)

	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if !errors.Is(err, ErrFSSubsystemRefused) {
		t.Fatalf("FSConn error = %v, want ErrFSSubsystemRefused", err)
	}
	if fc != nil {
		t.Fatal("FSConn returned a lease alongside the refusal error")
	}
	// The refused lease must not linger in the pool.
	waitPoolEmpty(t, client)
}

// TestFSConn_Connect_Refused proves the dial-level failure: no connection
// exists, so FSConn reports the dial error and no lease.
func TestFSConn_Connect_Refused(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	client := fsTestClient(t, srv)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	closedAddr := ln.Addr().String()
	_ = ln.Close()

	if _, err := client.FSConn(context.Background(), closedAddr, fsConnectOpts(srv)...); err == nil {
		t.Fatal("FSConn to a refused port = nil error, want the dial error")
	}
	waitPoolEmpty(t, client)
}

// TestFSConn_Handshake_NeverInit_TimesOut proves construction cannot hang:
// a server that accepts the subsystem and never answers the version
// handshake is closed down by the hard timeout — closing the session is what
// unblocks the handshake — and FSConn reports ErrFSTimedOut, releasing the
// pooled reference.
func TestFSConn_Handshake_NeverInit_TimesOut(t *testing.T) {
	srv := startFSTestServer(t, fsModeNeverInit)
	client := fsTestClient(t, srv)

	acq, err := client.acquirePooled(context.Background(), srv.addr, fsConnectOpts(srv))
	if err != nil {
		t.Fatalf("acquirePooled: %v", err)
	}
	fc, err := newFSConnLane(acq.client, func() { client.pool.Release(acq.handle) }, context.Background(), 300*time.Millisecond)
	if !errors.Is(err, ErrFSTimedOut) {
		t.Fatalf("FSConn error = %v, want ErrFSTimedOut", err)
	}
	if fc != nil {
		t.Fatal("FSConn returned a lease alongside the timeout")
	}
	waitPoolEmpty(t, client)
}

// ---------------------------------------------------------------------------
// Lease semantics — the three properties DiscoveryConn's failures bought
// ---------------------------------------------------------------------------

// TestFSConn_Close_DoesNotCloseDone proves property 3: an intentional Close
// must not read as connection loss, and a real transport loss must. Done
// closes only on the latter.
func TestFSConn_Close_DoesNotCloseDone(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	client := fsTestClient(t, srv)
	opts := fsConnectOpts(srv)

	tab, err := client.Connect(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = tab.Close() }()
	fc, err := client.FSConn(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	if err := fc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-fc.Done():
		t.Fatal("Done closed on Close — an intentional stop read as connection loss")
	default:
	}
	// The connection is still shared with the tab and fully usable.
	if _, err := tab.Write([]byte("alive")); err != nil {
		t.Fatalf("tab write after lease close: %v", err)
	}
	if got := readWithTimeout(t, tab); got != "echo:alive" {
		t.Errorf("tab echo = %q, want %q", got, "echo:alive")
	}

	srv.killConns()
	select {
	case <-fc.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done did not close after connection loss")
	}
	if fc.LostErr() == nil {
		t.Fatal("LostErr = nil after connection loss, want the transport error")
	}
}

// TestFSConn_Close_ReleasesReference proves the interval invariant with both
// ends named: from FSConn returning until Close returns, the pooled
// reference is held; after Close returns it is released and the shared
// connection survives for the tab.
func TestFSConn_Close_ReleasesReference(t *testing.T) {
	srv := startFSTestServer(t, fsModeReal)
	client := fsTestClient(t, srv)
	opts := fsConnectOpts(srv)

	tab, err := client.Connect(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = tab.Close() }()
	fc, err := client.FSConn(context.Background(), srv.addr, opts...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	// Held: tab + lease on one shared connection.
	if got := client.pool.Count(); got != 1 {
		t.Fatalf("pool count = %d, want 1", got)
	}
	if err := fc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Released, but the connection stays up for the tab.
	if got := client.pool.Count(); got != 1 {
		t.Errorf("pool count after lease close = %d, want 1 (tab still holds it)", got)
	}
	if _, err := tab.Write([]byte("still-alive")); err != nil {
		t.Fatalf("tab write after lease close: %v", err)
	}
	if got := readWithTimeout(t, tab); got != "echo:still-alive" {
		t.Errorf("tab echo = %q, want %q", got, "echo:still-alive")
	}
}

// TestFSConn_Loss_MidCall proves a transport dying while a call is in flight
// unblocks the call (the channel read fails, pkg/sftp broadcasts the loss to
// every in-flight request), reports ErrFSLost, closes Done and reclaims the
// pool.
func TestFSConn_Loss_MidCall(t *testing.T) {
	srv := startFSTestServer(t, fsModeNeverReply)
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	outCh := make(chan error, 1)
	go func() {
		_, err := fc.Stat("/wedged")
		outCh <- err
	}()
	select {
	case <-srv.requestSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("server never received the STAT request")
	}

	srv.killConns()
	select {
	case err := <-outCh:
		if !errors.Is(err, ErrFSLost) {
			t.Fatalf("Stat error = %v, want ErrFSLost", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stat did not return after transport loss")
	}
	select {
	case <-fc.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done did not close after connection loss")
	}
	if fc.LostErr() == nil {
		t.Fatal("LostErr = nil after connection loss, want the transport error")
	}
	waitPoolEmpty(t, client)
}

// ---------------------------------------------------------------------------
// Cancellation: listing by context, everything else by closing
// ---------------------------------------------------------------------------

// TestFSConn_ReadDir_Cancel_DoesNotPoison proves the lane's reason for
// existing: ReadDirContext is natively cancellable, so cancelling a listing
// returns ctx.Err() WITHOUT closing the client out from under a concurrent
// call. The concurrent Stat stays in flight, and only Close unblocks it.
func TestFSConn_ReadDir_Cancel_DoesNotPoison(t *testing.T) {
	srv := startFSTestServer(t, fsModeNeverReply)
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	rdCh := make(chan error, 1)
	go func() {
		_, err := fc.ReadDir(ctx, "/wedged")
		rdCh <- err
	}()
	select {
	case <-srv.requestSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("server never received the OPENDIR request")
	}

	statCh := make(chan error, 1)
	go func() {
		_, err := fc.Stat("/wedged")
		statCh <- err
	}()
	select {
	case <-srv.requestSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("server never received the STAT request")
	}

	cancel()
	select {
	case err := <-rdCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ReadDir error = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ReadDir did not return after cancel — ReadDirContext is not context-cancellable")
	}

	// The lease is NOT poisoned: the concurrent Stat is still in flight.
	select {
	case err := <-statCh:
		t.Fatalf("Stat returned %v while the lease should still be alive", err)
	case <-time.After(200 * time.Millisecond):
	}

	// Closing the lease is what unblocks the non-context call.
	if err := fc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case err := <-statCh:
		if !errors.Is(err, ErrFSClosed) {
			t.Fatalf("Stat error = %v, want ErrFSClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stat did not return after Close")
	}
}

// TestFSConn_HardTimeout_PoisonsLease proves the lane's backstop: a call a
// server will never answer is killed by the hard timeout, which closes the
// subsystem (unblocking the call), releases the pooled reference and reports
// the lease dead — a visible terminal state, not a silent retry loop.
func TestFSConn_HardTimeout_PoisonsLease(t *testing.T) {
	srv := startFSTestServer(t, fsModeNeverReply)
	client := fsTestClient(t, srv)

	acq, err := client.acquirePooled(context.Background(), srv.addr, fsConnectOpts(srv))
	if err != nil {
		t.Fatalf("acquirePooled: %v", err)
	}
	fc, err := newFSConnLane(acq.client, func() { client.pool.Release(acq.handle) }, context.Background(), 300*time.Millisecond)
	if err != nil {
		t.Fatalf("newFSConnLane: %v", err)
	}

	outCh := make(chan error, 1)
	go func() {
		_, err := fc.Stat("/wedged")
		outCh <- err
	}()
	select {
	case <-srv.requestSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("server never received the STAT request")
	}

	start := time.Now()
	select {
	case err := <-outCh:
		if !errors.Is(err, ErrFSDead) {
			t.Fatalf("Stat error = %v, want ErrFSDead", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stat did not return after the hard timeout — closing did not unblock it")
	}
	t.Logf("wedged Stat returned ErrFSDead after %s", time.Since(start))

	// Dead is terminal and observable: every call, context-aware or not,
	// reports ErrFSDead.
	if _, err := fc.Stat("/x"); !errors.Is(err, ErrFSDead) {
		t.Fatalf("Stat after poison = %v, want ErrFSDead", err)
	}
	if _, err := fc.ReadDir(context.Background(), "/x"); !errors.Is(err, ErrFSDead) {
		t.Fatalf("ReadDir after poison = %v, want ErrFSDead", err)
	}

	// The poisoned lease released its pooled reference, so the connection
	// is reclaimed and the transport shuts down — Done closes for real.
	waitPoolEmpty(t, client)
	select {
	case <-fc.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done did not close after the poisoned lease released the connection")
	}
}

// TestFSConn_Close_UnblocksNonContextCalls is the acceptance condition the
// design records as a promise to prove, not assert: against a server that
// accepts requests and never replies, closing the subsystem unblocks every
// non-context call we make. Each call is genuinely in flight — its request
// packet has reached the server — when Close fires, so the close, not a
// state check, is what releases it.
func TestFSConn_Close_UnblocksNonContextCalls(t *testing.T) {
	srv := startFSTestServer(t, fsModeNeverReply)
	client := fsTestClient(t, srv)
	fc, err := client.FSConn(context.Background(), srv.addr, fsConnectOpts(srv)...)
	if err != nil {
		t.Fatalf("FSConn: %v", err)
	}

	baseline := runtime.NumGoroutine()
	const nCalls = 4
	outCh := make(chan error, nCalls)
	calls := []func(){
		func() {
			_, err := fc.Stat("/wedged")
			outCh <- err
		},
		func() {
			_, err := fc.Lstat("/wedged")
			outCh <- err
		},
		func() {
			_, err := fc.RealPath("/wedged")
			outCh <- err
		},
		func() {
			_, _, err := fc.ReadFile(context.Background(), "/wedged", 16)
			outCh <- err
		},
	}
	for _, c := range calls {
		go c()
	}
	// All four requests must be in flight server-side before Close: a call
	// that had not started would fail its state check, which proves nothing
	// about close-to-cancel.
	for i := 0; i < nCalls; i++ {
		select {
		case <-srv.requestSeen:
		case <-time.After(5 * time.Second):
			t.Fatalf("server saw only %d/%d requests", i, nCalls)
		}
	}

	start := time.Now()
	if err := fc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	for i := 0; i < nCalls; i++ {
		select {
		case err := <-outCh:
			if !errors.Is(err, ErrFSClosed) {
				t.Errorf("call %d error = %v, want ErrFSClosed", i, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("call %d did not return after Close — closing the subsystem did not unblock it", i)
		}
	}
	t.Logf("all %d non-context calls returned within %s of Close", nCalls, time.Since(start))

	// No goroutine from this lease outlives Close: the lease was the only
	// reference, so closing it reclaimed the connection and the loss
	// watcher exited with it. The allowance of baseline+1 matches the
	// discovery cancel test; the deadline loop tolerates the watcher's
	// asynchronous exit.
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseline+1 {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines = %d, want <= %d (lease goroutine outlived Close)", runtime.NumGoroutine(), baseline+1)
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitPoolEmpty(t, client)
}
