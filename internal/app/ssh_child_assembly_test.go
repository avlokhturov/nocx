package app

// Live-sshd child-domain ASSEMBLY proofs (nocx-u7uh.29): the ssh child
// domain driven as one chain against a REAL sshd — a real ssh client reaches
// a real sshd over the composed grant line (ADR-0022), the -R reverse
// forward terminates at the lifecycle listener transport
// (internal/lifecyclechannel/listener.go), and the remote shell's own hello
// establishes the child (docs/lifecycle-protocol.md §9). The per-piece
// proofs already exist (composed-line quoting, listener transport, in-band
// installer, kernel grant flow); this file is the missing combination.
//
// The parent is harness-driven over the same publisher the production grant
// builder is wired to (internal/app/app.go wires WithGrantBuilder the same
// way), so the chain under test is exactly the production one from a
// validated domain_request to the child's establishment; the parent-shell
// hook behaviour (nested detect → request → suspend → exec → activate) is
// the shell scripts' own proven territory.
//
// Credential mechanism (the decision this bead carries, ADR-0025): OpenSSH
// resolves default identity paths AND known_hosts from the passwd home, not
// $HOME (measured on OpenSSH 10.4), so a fixture key cannot be dropped into
// a hermetic $HOME and the request shape does not need to grow an -i
// pass-through. The fixture's client key rides an in-process ssh agent
// (SSH_AUTH_SOCK), and a temp-dir `ssh` wrapper on PATH execs the real
// client with `-o UserKnownHostsFile=<fixture file>` — both test-scoped,
// neither touching the developer's home.

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclechannel"
	"github.com/shady2k/nocx/internal/lifecyclecodec"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/shellintegration"
	gosshagent "golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// assemblySID is the 32-hex session id the lane is registered with: the
// in-band dispatcher embeds it as NOCX_SESSION_ID (AD-7), and the nested
// shell is treated as the owning session.
const assemblySID = "aabbccddeeff00112233445566778899"

var (
	// childCapRe finds the per-epoch capability as the composed line
	// streams it: `printf '%s\n' '<64 hex>'` (ShellQuote never alters hex).
	childCapRe = regexp.MustCompile(`[0-9a-f]{64}`)
	// childForwardRe pulls the -R ports out of the composed line:
	// -R 127.0.0.1:CPORT:127.0.0.1:LPORT — CPORT is the remote bind, LPORT
	// the listener transport's local port the forward terminates at.
	childForwardRe = regexp.MustCompile(`-R 127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)`)
)

// fixturePort extracts the sshd port from the fixture address.
func (fx *liveSshd) fixturePort() int {
	_, portStr, err := net.SplitHostPort(fx.addr)
	if err != nil {
		panic(fmt.Sprintf("fixture addr %q: %v", fx.addr, err))
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		panic(fmt.Sprintf("fixture port %q: %v", portStr, err))
	}
	return port
}

// startInProcessAgent serves the fixture client key over a unix socket using
// the standard ssh-agent protocol, so the REAL ssh client the composed line
// invokes can authenticate to the fixture sshd without any option. This is
// the test-scoped credential mechanism the option decision (ADR-0025)
// records: OpenSSH resolves default identity paths from the passwd home, not
// $HOME, so a fixture key cannot be placed where the client will find it via
// HOME; the agent is the hermetic alternative that keeps the test off the
// developer's real ~/.ssh.
func startInProcessAgent(t *testing.T, fx *liveSshd) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("agent socket: %v", err)
	}
	keyring := gosshagent.NewKeyring()
	if err := keyring.Add(gosshagent.AddedKey{
		PrivateKey: fx.clientRaw,
		Comment:    "fixture client key",
	}); err != nil {
		t.Fatalf("add fixture key to agent: %v", err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return // listener closed on cleanup
			}
			go func() { _ = gosshagent.ServeAgent(keyring, c) }()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return sock
}

// installSSHWrapper makes the REAL ssh client the composed line invokes
// trust the fixture sshd WITHOUT touching the developer's home: OpenSSH
// resolves known_hosts from the passwd home, not $HOME (measured on
// OpenSSH 10.4, nocx-u7uh.29), so a fixture known_hosts cannot be dropped
// into a hermetic $HOME. The wrapper is a test-scoped mechanism: a temp-dir
// `ssh` on PATH that execs the real ssh binary with `-o UserKnownHostsFile=
// <fixture file>` (the equivalent of a user's own config option); identity
// rides the agent (startInProcessAgent). The client, the server, the -R
// forward and the remote shell are all real.
func installSSHWrapper(t *testing.T, fx *liveSshd) string {
	t.Helper()
	realSSH, err := exec.LookPath("ssh")
	if err != nil {
		t.Fatalf("find the real ssh client: %v", err)
	}
	dir := t.TempDir()
	// The fixture host key, in the canonical bracketed form the client
	// looks up when connecting to a non-default port.
	knownHosts := filepath.Join(dir, "known_hosts")
	line := knownhosts.Line([]string{fmt.Sprintf("[127.0.0.1]:%d", fx.fixturePort())}, fx.hostKey)
	if err := os.WriteFile(knownHosts, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write fixture known_hosts: %v", err)
	}
	wrapper := "#!/bin/sh\nexec " + shellQuoteForSh(realSSH) +
		" -o UserKnownHostsFile=" + shellQuoteForSh(knownHosts) + " \"$@\"\n"
	wrapperPath := filepath.Join(dir, "ssh")
	// #nosec G306 — the stand-in for ssh must be executable to be found
	// through PATH; temp dir, no secret.
	if err := os.WriteFile(wrapperPath, []byte(wrapper), 0o755); err != nil {
		t.Fatalf("write ssh wrapper: %v", err)
	}
	return dir
}

// shellQuoteForSh single-quotes a path for the POSIX wrapper script.
func shellQuoteForSh(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// waitForResult polls cond until it is true or the timeout elapses,
// returning whether the condition was met (unlike waitFor, which fails the
// test). Used where the failure path must inspect the buffer that caused the
// timeout.
func waitForResult(t *testing.T, what string, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

// sshChildHarness wires the PRODUCTION grant composition (the same
// kernel → publisher → grant-builder stack app.go wires) and drives the
// parent side of the protocol over a loopback listener transport, so the
// test controls exactly the frames the parent shell sends (request, suspend,
// activate) and observes the kernel read model in between.
type sshChildHarness struct {
	t           *testing.T
	kernel      *recordingKernel
	lane        lifecycle.LaneID
	parentLn    *lifecyclechannel.Listener
	conn        net.Conn
	dec         *lifecyclecodec.Decoder
	seq         uint64
	parent      lifecycle.DomainID
	parentEpoch uint64
	parentCap   lifecycle.Capability
	// The grant, once requestChild ran.
	child      lifecycle.DomainID
	childEpoch uint64
	bootstrap  string
	childCap   lifecycle.Capability
	childLPort int // the listener transport's local port (the -R target)
	childRPort int // the remote bind the sshd opens (CPORT)
}

func newSSHChildHarness(t *testing.T, fx *liveSshd) *sshChildHarness {
	t.Helper()
	logger := log.NewSlogAdapter(nil)
	k := lifecycle.New(lifecycle.Options{})
	sessions := newSessionRegistry()
	transports := newTransportRegistry()
	lane := lifecycle.LaneID("lane-ssh-child-assembly")
	sessions.register(lane, assemblySID)

	// The production grant wiring (app.go): the grant builder is the single
	// owner of "how do we reach a host"; the closure resolves the publisher
	// lazily, the way the composition root does.
	var pub *lifecyclepub.Publisher
	pub = lifecyclepub.New(k,
		lifecyclepub.WithGrantBuilder(newChildGrantBuilder(logger,
			func() *lifecyclepub.Publisher { return pub },
			shellintegration.New(logger), transports, sessions)))
	pub.SetEmitter(ackingEmitter{pub: pub})
	kernel := &recordingKernel{Publisher: pub}

	parentLn, err := lifecyclechannel.NewListener(logger, pub)
	if err != nil {
		t.Fatalf("parent listener: %v", err)
	}
	t.Cleanup(func() { _ = parentLn.Close() })
	// The parent is a LOCAL adapter (the child's ssh runs on this machine),
	// which is the kind buildSSHChildBootstrap requires.
	transports.register(parentLn.TransportID(), transportKind{local: true})

	h, err := pub.RequestDomain(lane, nil, parentLn.TransportID())
	if err != nil {
		t.Fatalf("mint parent: %v", err)
	}
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", parentLn.Port()))
	if err != nil {
		t.Fatalf("dial parent listener: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &sshChildHarness{
		t:           t,
		kernel:      kernel,
		lane:        lane,
		parentLn:    parentLn,
		conn:        conn,
		dec:         lifecyclecodec.NewDecoder(conn, lifecyclecodec.Config{}, nil),
		parent:      h.Domain,
		parentEpoch: h.Epoch,
		parentCap:   h.Capability,
	}
}

// send writes one authenticated parent frame with the next sequence number.
func (h *sshChildHarness) send(ev lifecycle.Event) {
	h.seq++
	env := lifecycle.Envelope{
		Version:    lifecycle.ProtocolVersion,
		Lane:       h.lane,
		Domain:     h.parent,
		Epoch:      h.parentEpoch,
		Sequence:   h.seq,
		Capability: h.parentCap,
		Event:      ev,
	}
	if _, err := lifecyclecodec.Encode(h.conn, env); err != nil {
		h.t.Fatalf("encode %s: %v", ev.Kind, err)
	}
}

// readFrame reads one kernel→parent envelope (accept, grant).
func (h *sshChildHarness) readFrame(what string) lifecycle.Envelope {
	h.t.Helper()
	env, err := h.dec.ReadFrame()
	if err != nil {
		h.t.Fatalf("read %s: %v", what, err)
	}
	return env
}

// establishParent performs the parent's hello/accept handshake.
func (h *sshChildHarness) establishParent() {
	h.send(lifecycle.Event{
		Kind:  lifecycle.KindHello,
		Hello: &lifecycle.Hello{Shell: "assembly-test"},
	})
	env := h.readFrame("parent accept")
	if env.Event.Kind != lifecycle.KindAccept {
		h.t.Fatalf("parent handshake answered with %s, want accept", env.Event.Kind)
	}
}

// requestChild sends the ssh domain_request and captures the grant: the
// child's identity and the opaque composed line, plus the child's capability
// and listener port parsed out of the line.
func (h *sshChildHarness) requestChild(host string, port int, user string) {
	h.send(lifecycle.Event{
		Kind: lifecycle.KindDomainRequest,
		DomainRequest: &lifecycle.DomainRequest{
			RequestID: "r-assembly-1",
			Env:       lifecycle.EnvSSH,
			Host:      host,
			User:      user,
			Port:      port,
		},
	})
	env := h.readFrame("domain grant")
	grant := env.Event.DomainGrant
	if grant == nil || grant.Domain == "" {
		h.t.Fatalf("domain_request answered without a child domain; empty bootstrap = the refusal")
	}
	if grant.Bootstrap == "" {
		h.t.Fatalf("grant carries no bootstrap: the child was refused")
	}
	h.child = grant.Domain
	h.childEpoch = grant.Epoch
	h.bootstrap = grant.Bootstrap

	capHex := childCapRe.FindString(h.bootstrap)
	if capHex == "" {
		h.t.Fatalf("composed line carries no capability line (nocx-u7uh.29 defect): %s", h.bootstrap)
	}
	raw, err := hex.DecodeString(capHex)
	if err != nil || len(raw) != len(h.childCap) {
		h.t.Fatalf("composed line capability %q does not decode to a capability", capHex)
	}
	copy(h.childCap[:], raw)

	ports := childForwardRe.FindStringSubmatch(h.bootstrap)
	if ports == nil {
		h.t.Fatalf("composed line carries no -R forward: %s", h.bootstrap)
	}
	if _, err := fmt.Sscanf(ports[1], "%d", &h.childRPort); err != nil {
		h.t.Fatalf("remote -R port %q: %v", ports[1], err)
	}
	if _, err := fmt.Sscanf(ports[2], "%d", &h.childLPort); err != nil {
		h.t.Fatalf("local -R port %q: %v", ports[2], err)
	}
}

func (h *sshChildHarness) suspendParent() {
	h.send(lifecycle.Event{
		Kind:            lifecycle.KindDomainSuspended,
		DomainSuspended: &lifecycle.DomainSuspendedEvent{},
	})
}

func (h *sshChildHarness) activateParent() {
	h.send(lifecycle.Event{
		Kind:            lifecycle.KindDomainActivated,
		DomainActivated: &lifecycle.DomainActivatedEvent{},
	})
}

func (h *sshChildHarness) domainState(d lifecycle.DomainID) lifecycle.DomainState {
	d2, ok := h.kernel.Domain(d)
	if !ok {
		h.t.Fatalf("domain %s vanished from the kernel", d)
	}
	return d2.State
}

func (h *sshChildHarness) laneSnapshot() lifecycle.LaneSnapshot {
	st, err := h.kernel.State(h.lane)
	if err != nil {
		h.t.Fatalf("lane state: %v", err)
	}
	return st
}

// composedLineProc is the local bash running the grant's composed line — the
// "parent executes the bootstrap" step, with the real ssh client on PATH and
// the fixture key in an agent. stdin is the keyboard bridge's input: the
// test types through it to the far shell.
type composedLineProc struct {
	t     *testing.T
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *outputBuffer
	err   *outputBuffer
	done  bool
}

// runComposedLine executes the grant bootstrap in a real bash, the way the
// parent shell evals it, with stdin on a pipe (the composed line's ssh ALWAYS
// has a pipe for stdin — the brace group — so the pty-allocation semantics
// are the production ones; -tt forces the remote pty regardless). PATH is
// prefixed with the ssh-wrapper dir so the composed line's `ssh` resolves to
// the wrapper (which execs the real client with the fixture known_hosts).
func (h *sshChildHarness) runComposedLine(agentSock, sshWrapperDir string) *composedLineProc {
	h.t.Helper()
	// #nosec G204 — the line is the production-composed bootstrap this test
	// proves; running it under a real bash is the assertion, not an accident.
	cmd := exec.Command("bash", "-c", h.bootstrap)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		h.t.Fatalf("stdin pipe: %v", err)
	}
	out := &outputBuffer{}
	errBuf := &outputBuffer{}
	cmd.Stdout = out
	cmd.Stderr = errBuf
	path := sshWrapperDir + string(os.PathListSeparator) + os.Getenv("PATH")
	cmd.Env = append(os.Environ(), "SSH_AUTH_SOCK="+agentSock, "PATH="+path)
	if err := cmd.Start(); err != nil {
		h.t.Fatalf("start composed line: %v", err)
	}
	return &composedLineProc{t: h.t, cmd: cmd, stdin: stdin, out: out, err: errBuf}
}

// kill is the failure-path cleanup: never leave the ssh child running.
func (p *composedLineProc) kill() {
	p.t.Helper()
	_ = p.stdin.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.wait()
}

// wait ends the composed line: the far session is already exiting, so close
// the bridge's stdin (cat's EOF) and reap the process.
func (p *composedLineProc) wait() {
	p.t.Helper()
	if p.done {
		return
	}
	p.done = true
	_ = p.stdin.Close()
	_ = p.cmd.Wait()
}

// typeExit sends exit to the far shell through the keyboard bridge and waits
// for the composed line to return.
func (p *composedLineProc) typeExit() {
	p.t.Helper()
	if _, err := p.stdin.Write([]byte("exit\n")); err != nil {
		p.t.Fatalf("type exit: %v", err)
	}
	p.wait()
}

// ---------------------------------------------------------------------------
// The happy path: the assembly, all links live.

// TestLiveSshd_SSHChildAssembly_ChildEstablishesOverComposedLine proves the
// chain the per-piece tests never ran together: a real ssh client reaches the
// real sshd over the composed grant line, the -R forward terminates at the
// listener transport, and the far shell's own hello establishes the child.
// The parent is Suspended for the whole interval and re-activates only
// through its authenticated activation (protocol doc §9).
func TestLiveSshd_SSHChildAssembly_ChildEstablishesOverComposedLine(t *testing.T) {
	fx := startLiveSshd(t, true)
	h := newSSHChildHarness(t, fx)
	h.establishParent()
	h.requestChild("127.0.0.1", fx.fixturePort(), fx.user)

	// The minted child is Pending: it must reach Established only through
	// the far shell's own hello on the reverse-forwarded transport, never
	// at mint time.
	if st := h.domainState(h.child); st != lifecycle.DomainPending {
		t.Fatalf("child state after grant = %d, want Pending", st)
	}
	if cd, ok := h.kernel.Domain(h.child); !ok || cd.Transport == h.parentLn.TransportID() {
		t.Fatalf("child minted on the parent transport; it must ride its own listener transport")
	}

	h.suspendParent()
	// The suspend frame is processed by the listener's pump; wait for it.
	waitFor(t, "parent Suspended", 10*time.Second, func() bool {
		return h.domainState(h.parent) == lifecycle.DomainSuspended
	})
	if ls := h.laneSnapshot(); ls.Domain != "" {
		t.Fatalf("lane has an active domain %q after the parent suspended, want none", ls.Domain)
	}

	agentSock := startInProcessAgent(t, fx)
	wrapperDir := installSSHWrapper(t, fx)
	proc := h.runComposedLine(agentSock, wrapperDir)
	t.Cleanup(proc.kill)

	// The child establishes through the far shell's hello on the -R'd port.
	waitFor(t, "child domain Established via its own hello", 30*time.Second, func() bool {
		return h.domainState(h.child) == lifecycle.DomainEstablished
	})
	// The lane is owned by the child for the whole interval.
	waitFor(t, "lane owned by the child", 10*time.Second, func() bool {
		ls := h.laneSnapshot()
		return ls.Domain == h.child && ls.Lifecycle == lifecycle.LifecyclePromptReady
	})
	// The parent stays Suspended under the live child: no auto-activation.
	if st := h.domainState(h.parent); st != lifecycle.DomainSuspended {
		t.Fatalf("parent = %d while the child is live, want Suspended", st)
	}

	// The user finishes the nested session: exit at the far shell, through
	// the composed line's cat → ssh → far pty. The child's speaker leaves.
	proc.typeExit()
	waitFor(t, "child ended and left the stack", 30*time.Second, func() bool {
		st := h.domainState(h.child)
		return st == lifecycle.DomainClosed || st == lifecycle.DomainLost
	})
	// Still no auto-activation: the parent remains Suspended with the lane
	// empty until the authenticated activation arrives — the exact moment
	// a close alone must not restore it (§9).
	if st := h.domainState(h.parent); st != lifecycle.DomainSuspended {
		t.Fatalf("parent = %d after the child ended, want Suspended until activation", st)
	}
	if ls := h.laneSnapshot(); ls.Domain != "" {
		t.Fatalf("lane has an active domain %q after the child ended, want none", ls.Domain)
	}

	// Activation is the ONLY way back: the authenticated domain_activated
	// frame restores the parent to the lane.
	h.activateParent()
	waitFor(t, "parent re-established and owning the lane", 10*time.Second, func() bool {
		if st := h.domainState(h.parent); st != lifecycle.DomainEstablished {
			return false
		}
		ls := h.laneSnapshot()
		return ls.Domain == h.parent && ls.Lifecycle == lifecycle.LifecyclePromptReady
	})
}

// ---------------------------------------------------------------------------
// The failure paths: forwarding refused → stillborn child, parent still
// activates, late frame rejected.

// TestLiveSshd_SSHChildAssembly_ForwardingRefusedParentStillActivates proves
// the stillborn interval (protocol doc §9): a host whose sshd refuses the -R
// bind leaves the child Pending forever; the parent still activates at its
// next prompt boundary (a Pending child is not on the stack), and a late
// hello from the stillborn child is rejected against the restored parent —
// the reject mutates nothing.
func TestLiveSshd_SSHChildAssembly_ForwardingRefusedParentStillActivates(t *testing.T) {
	fx := startLiveSshd(t, false) // AllowTcpForwarding no
	h := newSSHChildHarness(t, fx)
	h.establishParent()
	h.requestChild("127.0.0.1", fx.fixturePort(), fx.user)
	if st := h.domainState(h.child); st != lifecycle.DomainPending {
		t.Fatalf("child state after grant = %d, want Pending", st)
	}
	h.suspendParent()

	agentSock := startInProcessAgent(t, fx)
	wrapperDir := installSSHWrapper(t, fx)
	proc := h.runComposedLine(agentSock, wrapperDir)
	t.Cleanup(proc.kill)

	// The refusal is observable: sshd rejects the tcpip-forward and the
	// client reports it. This is the test's own stderr buffer, never the
	// user-visible terminal (the refusal-leak contract is asserted by the
	// conventional-session proof, which scans the terminal, not this).
	refused := waitForResult(t, "ssh reporting the refused reverse forward", 30*time.Second, func() bool {
		return strings.Contains(proc.err.String(), "remote port forwarding failed")
	})
	if !refused {
		t.Fatalf("ssh never reported the refused -R; stderr:\n%s", proc.err.String())
	}
	// The stillborn child never establishes: give the far side time to have
	// tried the in-band connect to the refused port and failed open.
	time.Sleep(2 * time.Second)
	if st := h.domainState(h.child); st != lifecycle.DomainPending {
		t.Fatalf("stillborn child = %d, want Pending (never established)", st)
	}

	// The user gives up on the nested session; the far shell exits and the
	// composed line returns.
	proc.typeExit()

	// The parent still activates at its next prompt boundary.
	h.activateParent()
	waitFor(t, "parent re-established after the stillborn child", 10*time.Second, func() bool {
		if st := h.domainState(h.parent); st != lifecycle.DomainEstablished {
			return false
		}
		ls := h.laneSnapshot()
		return ls.Domain == h.parent && ls.Lifecycle == lifecycle.LifecyclePromptReady
	})

	// A late frame from the stillborn child is rejected against the
	// restored parent: its hello cannot establish a child over an active
	// parent, the listener closes the candidate, and nothing mutates.
	h.assertLateChildHelloRejected()
}

// assertLateChildHelloRejected sends the stillborn child's authenticated
// hello over its own listener transport after the parent re-activated: the
// kernel must reject it (the child's parent is not Suspended), the listener
// must close the candidate without any accept, and both domains must keep
// their states.
func (h *sshChildHarness) assertLateChildHelloRejected() {
	h.t.Helper()
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", h.childLPort))
	if err != nil {
		h.t.Fatalf("dial child listener: %v", err)
	}
	defer func() { _ = conn.Close() }()
	env := lifecycle.Envelope{
		Version:    lifecycle.ProtocolVersion,
		Lane:       h.lane,
		Domain:     h.child,
		Epoch:      h.childEpoch,
		Sequence:   1,
		Capability: h.childCap,
		Event:      lifecycle.Event{Kind: lifecycle.KindHello, Hello: &lifecycle.Hello{Shell: "late"}},
	}
	if _, encErr := lifecyclecodec.Encode(conn, env); encErr != nil {
		h.t.Fatalf("encode late hello: %v", encErr)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 256)
	n, err := conn.Read(buf)
	if err == nil {
		h.t.Fatalf("late child hello was answered with %d bytes, want a rejected-and-closed candidate", n)
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		h.t.Fatalf("late child hello left the candidate open: the listener did not close it")
	}
	// The reject mutated nothing.
	if st := h.domainState(h.child); st != lifecycle.DomainPending {
		h.t.Fatalf("child state after the late hello = %d, want Pending", st)
	}
	if st := h.domainState(h.parent); st != lifecycle.DomainEstablished {
		h.t.Fatalf("parent state after the late hello = %d, want Established", st)
	}
}
