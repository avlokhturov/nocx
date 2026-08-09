package shellintegration

// The nested-environment acceptance test (nocx-u7uh.11): a real integrated
// bash parent on a pty, the user typing `sudo -i`, the parent requesting a
// child domain over the authenticated channel, receiving the grant (built
// by the same code path the composition root uses — LocalBashRcfile plus
// the preserved-fd close), suspending, and launching the child through a
// REAL passwordless sudo with --preserve-fds. The child bash reads its
// rcfile from the preserved descriptor (/dev/fd/4), establishes its own
// domain over the SAME inherited socketpair, and the parent re-activates
// only after the child closes. The kernel is a two-domain fake that
// enforces the §9 ordering: the child's hello is answered only after the
// parent suspended, and the parent's activation is recorded only after the
// child closed.

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclecodec"
)

const (
	nestedChildDom   = "dom-child-test"
	nestedChildEpoch = 7
	nestedChildCap   = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
)

// nestedKernel plays the kernel's transport side for ONE lane with TWO
// domains (parent + child) over ONE socketpair, enforcing the §9 ordering:
// the child hello is accepted only after the parent suspended, and the
// grant answers the parent's request with the child's identity and the
// opaque bootstrap the parent executes.
type nestedKernel struct {
	t               *testing.T
	conn            net.Conn
	mu              sync.Mutex
	seq             map[string]uint64
	accepted        []kernelEvent
	order           []string
	parentSuspended bool
	childClosed     bool
	childHeard      bool // the child ever established (a hello was accepted)
	parentActivated bool
	// refuseChild answers the parent's domain_request with an EMPTY
	// bootstrap — the §9 refusal. The parent then runs its command
	// conventionally and still activates at its next prompt (the stillborn
	// interval). A refused child never sends hello.
	refuseChild bool
}

func newNestedKernel(t *testing.T) *nestedKernel {
	return &nestedKernel{t: t, seq: map[string]uint64{}}
}

func (k *nestedKernel) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	k.mu.Lock()
	k.conn = conn
	k.mu.Unlock()
	r := bufio.NewReader(conn)
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n == 0 || n > 65536 {
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		var f frame
		if err := json.Unmarshal(body, &f); err != nil {
			continue
		}
		k.accept(f, body)
	}
}

// accept validates the frame against the right domain and enforces the
// §9 ordering. Runs under k.mu.
func (k *nestedKernel) accept(f frame, body []byte) {
	k.mu.Lock()
	defer k.mu.Unlock()
	switch {
	case f.Dom == testDom && f.Epoch == testEpoch && f.Cap == testCap:
	case f.Dom == nestedChildDom && f.Epoch == nestedChildEpoch && f.Cap == nestedChildCap:
	default:
		return // wrong tuple: not one of the two domains
	}
	if f.Seq <= k.seq[f.Dom] {
		return
	}
	k.seq[f.Dom] = f.Seq
	ev := kernelEvent{Seq: f.Seq, Evt: f.Evt}
	_ = json.Unmarshal(body, &ev.Body)
	k.accepted = append(k.accepted, ev)
	k.order = append(k.order, f.Dom+" "+f.Evt)
	switch f.Evt {
	case "hello":
		if f.Dom == nestedChildDom {
			// The §9 interval, this end: a child hello before the parent
			// suspended, or after the child closed, is an ordering
			// violation. A child that never establishes (refused bootstrap)
			// sends no hello at all — the stillborn interval is not an
			// ordering violation, it is the expected path.
			k.childHeard = true
			if !k.parentSuspended {
				k.t.Errorf("child hello before the parent suspended — §9 ordering violated")
			}
			if k.childClosed {
				k.t.Errorf("child hello after the child closed — a late frame slipped through")
			}
		}
		k.sendAcceptLocked(f.Dom, f.Epoch, f.Cap)
	case "domain_request":
		k.grantLocked()
	case "domain_suspended":
		k.parentSuspended = true
	case "domain_closed":
		if f.Dom == nestedChildDom {
			k.childClosed = true
		}
	case "domain_activated":
		// The parent may activate only once the child closed — or once it
		// became clear the child never established (a refused bootstrap:
		// the real kernel accepts an activation of a parent whose Pending
		// child never reached the stack, §9).
		if k.childHeard && !k.childClosed {
			k.t.Errorf("parent activated while the child was still live; order=%v", k.order)
		}
		k.parentActivated = true
	}
}

// grantLocked answers the parent's request: the child's identity plus an
// opaque bootstrap built EXACTLY as the composition root builds it
// (buildLocalChildBootstrap's shape: LocalBashRcfile with the child's
// addressing and the preserved-fd close).
func (k *nestedKernel) grantLocked() {
	bootstrap := ""
	if !k.refuseChild {
		rc, err := LocalBashRcfile(LaunchOptions{
			SessionID:   "chansess",
			Enhanced:    true,
			Capability:  nestedChildCap,
			Lane:        testLane,
			Domain:      nestedChildDom,
			Epoch:       nestedChildEpoch,
			LifecycleFD: 3,
		})
		if err != nil {
			k.t.Fatalf("child rcfile: %v", err)
		}
		// The child reads the rcfile from the preserved bootstrap descriptor
		// chosen by the PARENT at launch (bash's free 4-9 scan, zsh's {var}
		// allocation >= 10 — never a fixed 4), so the close names the fd it
		// was READ FROM the way the composition root's closing line does:
		// BASH_SOURCE[0] is /dev/fd/N inside the rcfile, so ##*/ yields N
		// for either tier's descriptor number.
		rc += "\neval \"exec ${BASH_SOURCE[0]##*/}<&-\" 2>/dev/null\n"
		bootstrap = rc
	}
	env := lifecycle.Envelope{
		Version:    lifecycle.ProtocolVersion,
		Lane:       lifecycle.LaneID(testLane),
		Domain:     lifecycle.DomainID(testDom),
		Epoch:      testEpoch,
		Capability: capBytes(k.t, testCap),
		Event: lifecycle.Event{Kind: lifecycle.KindDomainGrant, DomainGrant: &lifecycle.DomainGrant{
			RequestID: "r-" + testDom + "-0",
			Env:       lifecycle.EnvSudo,
			Domain:    lifecycle.DomainID(nestedChildDom),
			Epoch:     nestedChildEpoch,
			Bootstrap: bootstrap,
		}},
	}
	if _, err := lifecyclecodec.Encode(k.conn, env); err != nil {
		k.t.Fatalf("encode grant: %v", err)
	}
}

// sendAcceptLocked answers a hello with the accept for THAT domain (the
// parent's accept carries the parent's addressing, the child's the child's).
func (k *nestedKernel) sendAcceptLocked(dom string, epoch uint64, capHex string) {
	env := lifecycle.Envelope{
		Version:    lifecycle.ProtocolVersion,
		Lane:       lifecycle.LaneID(testLane),
		Domain:     lifecycle.DomainID(dom),
		Epoch:      epoch,
		Capability: capBytes(k.t, capHex),
		Event:      lifecycle.Event{Kind: lifecycle.KindAccept, Accept: &lifecycle.Accept{}},
	}
	k.t.Logf("kernel sending accept for dom=%s epoch=%d", dom, epoch)
	if _, err := lifecyclecodec.Encode(k.conn, env); err != nil {
		k.t.Fatalf("encode accept: %v", err)
	}
	k.t.Logf("kernel accept sent for dom=%s", dom)
}

// sendRefresh pushes a refresh_request envelope at the parent's connection,
// exactly what the adapter's Send would frame when the kernel
// desynchronizes the parent domain (protocol §10).
func (k *nestedKernel) sendRefresh(rid string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	env := lifecycle.Envelope{
		Version:    lifecycle.ProtocolVersion,
		Lane:       lifecycle.LaneID(testLane),
		Domain:     lifecycle.DomainID(testDom),
		Epoch:      testEpoch,
		Capability: capBytes(k.t, testCap),
		Event: lifecycle.Event{Kind: lifecycle.KindRefreshRequest, RefreshRequest: &lifecycle.RefreshRequest{
			RequestID: lifecycle.RequestID(rid),
		}},
	}
	if _, err := lifecyclecodec.Encode(k.conn, env); err != nil {
		k.t.Fatalf("encode refresh: %v", err)
	}
}

// rejectedCount reports frames rejected by the kernel (the nested kernel
// currently rejects nothing observable; the harness needs the method).
func (k *nestedKernel) rejectedCount() int {
	return 0
}

// count returns how many accepted events of one kind arrived across both
// domains.
func (k *nestedKernel) count(evt string) int {
	k.mu.Lock()
	defer k.mu.Unlock()
	n := 0
	for _, e := range k.accepted {
		if e.Evt == evt {
			n++
		}
	}
	return n
}

// events returns the accepted events.
func (k *nestedKernel) events() []kernelEvent {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]kernelEvent(nil), k.accepted...)
}

func (k *nestedKernel) serveFile(f *os.File) {
	c, err := net.FileConn(f)
	if err != nil {
		return
	}
	k.serve(c)
}

func capBytes(t *testing.T, hexCap string) lifecycle.Capability {
	var c lifecycle.Capability
	if _, err := hex.Decode(c[:], []byte(hexCap)); err != nil {
		t.Fatalf("decode cap: %v", err)
	}
	return c
}

// TestBashNestedChildDomain is the NESTED acceptance criterion's local
// half, proven end to end on a real pty: the child gets its own
// authenticated domain, the parent suspends before the child hello, and
// closing the child restores the parent only through its authenticated
// activation. The launch uses a fake `sudo` on PATH that stands in for a
// preserve-fds-capable sudo (the real one on this host lacks
// --preserve-fds — the brief's named fallback case): it preserves every fd
// (plain exec does) and runs the child bash that reads its rcfile from the
// preserved descriptor. The shell-side flow — request, grant, suspend,
// preserved-fd launch, child establish, activate — is what this test
// proves; the platform's sudo flag support is the container's job.
func TestBashNestedChildDomain(t *testing.T) {
	bash := requireShell(t, "bash")

	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("socketpair: %v", err)
	}
	kernelFile := os.NewFile(uintptr(fds[0]), "kernel-end")
	shellFile := os.NewFile(uintptr(fds[1]), "shell-end")

	home := t.TempDir()
	script := writeScriptFile(t, "nocx.bash", bashScript)
	gate := filepath.Join(t.TempDir(), "gate")
	gateBody := "export -n __nocx_cap 2>/dev/null\n__nocx_cap='" + testCap + "'\nexport -n __nocx_cap 2>/dev/null\n. " + ShellQuote(script) + "\n"
	if werr := os.WriteFile(gate, []byte(gateBody), 0o600); werr != nil {
		t.Fatalf("write gate: %v", werr)
	}
	if werr := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(". "+ShellQuote(gate)+"\n"), 0o600); werr != nil {
		t.Fatalf("write .bashrc: %v", werr)
	}

	// The fake sudo: the launch line is
	// `sudo --preserve-fds=3,4 -i env -u BASH_ENV bash --rcfile /dev/fd/4 -i`;
	// a preserve-fds sudo would keep fds 3 and 4 and run that command. The
	// fake ignores the sudo-specific prefix and execs the same child bash.
	binDir := t.TempDir()
	fakeSudo := "#!/bin/sh\n" +
		"# Test stand-in for a preserve-fds-capable sudo: plain exec preserves\n" +
		"# every fd, and the launch names the rcfile descriptor the parent\n" +
		"# allocated ({var} may choose any free fd, never a fixed 4).\n" +
		"for a in \"$@\"; do case \"$a\" in /dev/fd/[0-9]*) rc=\"$a\";; esac; done\n" +
		"exec " + ShellQuote(bash) + " --rcfile \"${rc:-/dev/fd/4}\" -i\n"
	// #nosec G306 — a stand-in for sudo must be executable to be found and
	// run through PATH; it lives in the test's own temp dir and holds no
	// secret. 0600 would make the fixture unable to do the one thing it exists
	// for.
	if werr := os.WriteFile(filepath.Join(binDir, "sudo"), []byte(fakeSudo), 0o755); werr != nil {
		t.Fatalf("write fake sudo: %v", werr)
	}

	// #nosec G204 — bash is the requireShell-resolved path, not input; an
	// interactive shell with an inherited descriptor is the only way to
	// exercise the local transport shape.
	cmd := exec.Command(bash, "-i")
	cmd.ExtraFiles = []*os.File{shellFile} // becomes fd 3
	cmd.Env = append(
		cleanEnv("HOME="+home, "TMPDIR="+t.TempDir(), "TERM=xterm", "HISTFILE=/dev/null", "PATH="+binDir+":"+os.Getenv("PATH")),
		"NOCX_SHELL_INTEGRATION=1",
		"NOCX_PROMPT_MODE=marker-only",
		"NOCX_SESSION_ID=chansess",
		"NOCX_LIFECYCLE_LANE="+testLane,
		"NOCX_LIFECYCLE_DOMAIN="+testDom,
		fmt.Sprintf("NOCX_LIFECYCLE_EPOCH=%d", testEpoch),
		"NOCX_LIFECYCLE_FD=3",
		"NOCX_LIFECYCLE_TIMEOUT_MS=3000",
	)

	k := newNestedKernel(t)
	go k.serveFile(kernelFile)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("pty start: %v", err)
	}
	s := &channelShell{t: t, cmd: cmd, ptmx: ptmx, kernel: k}
	go s.readPump()
	defer func() { _ = ptmx.Close(); _ = cmd.Process.Kill() }()

	// The parent handshake completes.
	s.waitForHandshake()

	// The user enters sudo -i. The parent requests the child, suspends, and
	// launches the child through the fake sudo with the preserved
	// descriptor.
	_, _ = s.ptmx.Write([]byte("sudo -i\n"))

	// The child establishes its own domain and reaches a prompt.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if k.count("hello") >= 2 && childPromptReady(t, k) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if k.count("hello") < 2 {
		t.Fatalf("no child hello; order=%v output=%q", k.order, s.output())
	}

	// The child is a working shell: run a command inside it. The assertion
	// is the child DOMAIN's accepted complete — not the echo text, which
	// readline also mirrors into the pty.
	_, _ = s.ptmx.Write([]byte("echo CHILD-SHELL-OK\n"))
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		childRan := false
		for _, e := range k.events() {
			if e.Body["dom"] == nestedChildDom && e.Evt == "complete" {
				childRan = true
			}
		}
		if childRan {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var childCompleted bool
	for _, e := range k.events() {
		if e.Body["dom"] == nestedChildDom && e.Evt == "complete" {
			childCompleted = true
		}
	}
	if !childCompleted {
		t.Fatalf("the child never completed a command through its own domain; order=%v output=%q", k.order, s.output())
	}

	// The child closes; the parent re-activates at its next prompt.
	_, _ = s.ptmx.Write([]byte("exit\n"))
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		k.mu.Lock()
		done := k.parentActivated
		k.mu.Unlock()
		if done {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.parentActivated {
		t.Fatalf("parent never re-activated; order=%v output=%q", k.order, s.output())
	}
	// The §9 interval, both ends: the parent suspended before the child
	// hello, the child closed before the parent's activation, and the
	// parent's own lifecycle resumed (a complete and prompt_ready for the
	// parent domain follow the activation).
	if !k.parentSuspended {
		t.Fatalf("parent never suspended; order=%v", k.order)
	}
	var sawParentComplete, sawParentReady bool
	for _, e := range k.accepted {
		if e.Body["dom"] == testDom && e.Evt == "complete" {
			sawParentComplete = true
		}
		if e.Body["dom"] == testDom && e.Evt == "prompt_ready" {
			sawParentReady = true
		}
	}
	if !sawParentComplete || !sawParentReady {
		t.Fatalf("parent lifecycle did not resume after activation; order=%v", k.order)
	}
}

// childPromptReady reports whether the child domain reached a prompt.
func childPromptReady(t *testing.T, k *nestedKernel) bool {
	for _, e := range k.events() {
		if e.Evt == "prompt_ready" && e.Body["dom"] == nestedChildDom {
			return true
		}
	}
	return false
}

// startZshParent boots a real interactive zsh on a pty with the lifecycle
// socketpair on fd 3, the nested machinery sourced through a gate, and a
// fake `sudo` on PATH (the nestedKernel plays the kernel's transport side).
// The fake sudo stands in for a preserve-fds-capable sudo (the real one on
// this host lacks --preserve-fds): it preserves every fd (plain exec does)
// and runs the child shell that reads its rcfile from the preserved
// descriptor. The shell-side flow — request, grant, suspend, preserved-fd
// launch, child establish, activate — is what this proves; the platform's
// sudo flag support is the container's job (same division as the bash
// twin). fakeSudoBody is the whole fixture script; the happy-path body
// execs the child shell named in it (bash for the local tier: the app-side
// grant builder composes the child's BASH rcfile — LocalBashRcfile — so
// the launch line is the bash tier's, and the zsh parent is the thing
// under test), while the stillborn body just reports and exits.
func startZshParent(t *testing.T, k *nestedKernel, fakeSudoBody string) *channelShell {
	t.Helper()
	zsh := requireShell(t, "zsh")

	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("socketpair: %v", err)
	}
	kernelFile := os.NewFile(uintptr(fds[0]), "kernel-end")
	shellFile := os.NewFile(uintptr(fds[1]), "shell-end")

	home := t.TempDir()
	script := writeScriptFile(t, "nocx.zsh", zshScript)
	gate := filepath.Join(t.TempDir(), "gate")
	gateBody := "typeset +x __nocx_cap 2>/dev/null\n__nocx_cap='" + testCap + "'\ntypeset +x __nocx_cap 2>/dev/null\n. " + ShellQuote(script) + "\n"
	if werr := os.WriteFile(gate, []byte(gateBody), 0o600); werr != nil {
		t.Fatalf("write gate: %v", werr)
	}
	if werr := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(". "+ShellQuote(gate)+"\n"), 0o600); werr != nil {
		t.Fatalf("write .zshrc: %v", werr)
	}

	binDir := t.TempDir()
	// #nosec G306 — a stand-in for sudo must be executable to be found and
	// run through PATH; it lives in the test's own temp dir and holds no
	// secret. 0600 would make the fixture unable to do the one thing it exists
	// for.
	if werr := os.WriteFile(filepath.Join(binDir, "sudo"), []byte(fakeSudoBody), 0o755); werr != nil {
		t.Fatalf("write fake sudo: %v", werr)
	}
	// #nosec G204 — zsh is the requireShell-resolved path, not input; an
	// interactive shell with an inherited descriptor is the only way to
	// exercise the local transport shape.
	cmd := exec.Command(zsh, "-i")
	cmd.ExtraFiles = []*os.File{shellFile} // becomes fd 3
	cmd.Env = append(
		cleanEnv("HOME="+home, "TMPDIR="+t.TempDir(), "TERM=xterm", "HISTFILE=/dev/null", "ZDOTDIR="+home, "PATH="+binDir+":"+os.Getenv("PATH")),
		"NOCX_SHELL_INTEGRATION=1",
		"NOCX_PROMPT_MODE=marker-only",
		"NOCX_SESSION_ID=chansess",
		"NOCX_LIFECYCLE_LANE="+testLane,
		"NOCX_LIFECYCLE_DOMAIN="+testDom,
		fmt.Sprintf("NOCX_LIFECYCLE_EPOCH=%d", testEpoch),
		"NOCX_LIFECYCLE_FD=3",
		"NOCX_LIFECYCLE_TIMEOUT_MS=3000",
	)

	go k.serveFile(kernelFile)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("pty start: %v", err)
	}
	s := &channelShell{t: t, cmd: cmd, ptmx: ptmx, kernel: k}
	go s.readPump()
	t.Cleanup(func() { _ = ptmx.Close(); _ = cmd.Process.Kill() })
	s.waitForHandshake()
	return s
}

// TestZshNestedChildDomain is the zsh twin of TestBashNestedChildDomain —
// the NESTED acceptance criterion's zsh half, proven end to end on a real
// pty (nocx-u7uh.28): a zsh parent entering sudo -i requests a child
// domain over the authenticated channel, receives the grant, suspends, and
// launches the child through the fake sudo; the child bash (the app-side
// bootstrap is a bash rcfile) establishes its own domain over the SAME
// inherited socketpair, and the parent re-activates only after the child
// closes — through its authenticated activation, never by a close alone.
func TestZshNestedChildDomain(t *testing.T) {
	bash := requireShell(t, "bash")
	k := newNestedKernel(t)
	fakeSudo := "#!/bin/sh\n" +
		"# Test stand-in for a preserve-fds-capable sudo: plain exec preserves\n" +
		"# every fd, and the launch names the rcfile descriptor the parent\n" +
		"# allocated (zsh's {var} chooses any free fd >= 10, never a fixed 4).\n" +
		"for a in \"$@\"; do case \"$a\" in /dev/fd/[0-9]*) rc=\"$a\";; esac; done\n" +
		"exec " + ShellQuote(bash) + " --rcfile \"${rc:-/dev/fd/4}\" -i\n"
	s := startZshParent(t, k, fakeSudo)
	// The user enters sudo -i. The accept-line widget intercepts it (zsh's
	// DEBUG trap cannot suppress a command), the parent requests the child,
	// suspends, and launches the child through the fake sudo with the
	// preserved descriptor.
	_, _ = s.ptmx.Write([]byte("sudo -i\n"))
	_, _ = s.ptmx.Write([]byte("echo CHILD-SHELL-OK\n"))

	// The child establishes its own domain and reaches a prompt.
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		if k.count("hello") >= 2 && childPromptReady(t, k) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if k.count("hello") < 2 {
		t.Fatalf("no child hello; order=%v output=%q", k.order, s.output())
	}

	// The child is a working shell: run a command inside it. The assertion
	// is the child DOMAIN's accepted complete — not the echo text, which
	// readline also mirrors into the pty.
	_, _ = s.ptmx.Write([]byte("echo CHILD-SHELL-OK\n"))
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		childRan := false
		for _, e := range k.events() {
			if e.Body["dom"] == nestedChildDom && e.Evt == "complete" {
				childRan = true
			}
		}
		if childRan {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var childCompleted bool
	for _, e := range k.events() {
		if e.Body["dom"] == nestedChildDom && e.Evt == "complete" {
			childCompleted = true
		}
	}
	if !childCompleted {
		t.Fatalf("the child never completed a command through its own domain; order=%v", k.order)
	}

	// The child closes; the parent re-activates at its next prompt.
	_, _ = s.ptmx.Write([]byte("exit\n"))
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		k.mu.Lock()
		done := k.parentActivated
		k.mu.Unlock()
		if done {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.parentActivated {
		t.Fatalf("parent never re-activated; order=%v output=%q", k.order, s.output())
	}
	// The §9 interval, both ends: the parent suspended before the child
	// hello, the child closed before the parent's activation, and the
	// parent's own lifecycle resumed (a complete and prompt_ready for the
	// parent domain follow the activation).
	if !k.parentSuspended {
		t.Fatalf("parent never suspended; order=%v", k.order)
	}
	var sawParentComplete, sawParentReady bool
	for _, e := range k.accepted {
		if e.Body["dom"] == testDom && e.Evt == "complete" {
			sawParentComplete = true
		}
		if e.Body["dom"] == testDom && e.Evt == "prompt_ready" {
			sawParentReady = true
		}
	}
	if !sawParentComplete || !sawParentReady {
		t.Fatalf("parent lifecycle did not resume after activation; order=%v", k.order)
	}
}

// TestZshNestedChildStillborn covers the §9 failure interval on the zsh
// tier: the kernel REFUSES the request (an empty bootstrap — forwarding
// refused, sudo policy), the parent sends domain_suspended and runs the
// command conventionally, and still re-activates at its next prompt. The
// child never establishes — no child hello — and the parent's activation
// is accepted against the stillborn child (a Pending child is not on the
// stack). A late frame from that never-established child is rejected
// against the restored parent by the real kernel; the fake kernel here
// proves the shell half: the parent neither hangs nor stays suspended.
func TestZshNestedChildStillborn(t *testing.T) {
	k := newNestedKernel(t)
	k.refuseChild = true
	// The refused child never launches a shell: the fake sudo just reports
	// and exits, so the parent's conventional run of `sudo -i` terminates
	// immediately instead of opening a nested shell.
	fakeSudo := "#!/bin/sh\necho STILLBORN-SUDO-RAN\nexit 0\n"
	s := startZshParent(t, k, fakeSudo)

	// The user enters sudo -i. The parent requests the child, receives the
	// REFUSAL (an empty bootstrap), sends domain_suspended, and runs the
	// command conventionally — the fake sudo reports and exits.
	_, _ = s.ptmx.Write([]byte("sudo -i\n"))

	// The parent still re-activates at its next prompt — the §9 stillborn
	// interval is the expected path, not an error, and never a hang.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		k.mu.Lock()
		done := k.parentActivated
		k.mu.Unlock()
		if done {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.parentSuspended {
		t.Fatalf("parent never suspended before the refused launch; order=%v output=%q", k.order, s.output())
	}
	if k.childHeard {
		t.Fatalf("a refused child still established (hello accepted); order=%v", k.order)
	}
	if !k.parentActivated {
		t.Fatalf("parent never re-activated after the stillborn child; order=%v output=%q", k.order, s.output())
	}
	if !strings.Contains(s.output(), "STILLBORN-SUDO-RAN") {
		t.Fatalf("the refused command did not run conventionally; output=%q", s.output())
	}
}
