package app

// Child-domain bootstrap composition (nocx-u7uh.11): the composition-root
// half of the domain_request/domain_grant flow (docs/lifecycle-protocol.md
// §9). The kernel validates the request and answers a grant echo; this file
// mints the child (through the publisher's kernel.RequestDomain — the
// kernel stays the sole minter of capabilities), picks the child's
// transport, and composes the opaque, already-substituted bootstrap the
// parent shell executes verbatim.
//
// Delivery is per environment, exactly as the protocol doc §9 records:
//
//   - sudo/su (same machine): the bootstrap is the child's bash rcfile; the
//     parent stages it into a preserved descriptor and launches
//     `sudo --preserve-fds=3,N -i env -u BASH_ENV bash --rcfile /dev/fd/N
//     -i` — ADR-0024's own preferred answer (recorded in its open-questions
//     section): the per-epoch capability never enters a filesystem object.
//   - ssh: the bootstrap is a rewritten command line the parent executes —
//     ADR-0022, "the ssh command line is the carrier" — carrying the child's
//     forwarded lifecycle port as a -R reverse forward on that same ssh
//     connection plus the in-band install payload (wrapper, capability as
//     the first streamed line, payload, terminator) piped into `ssh -t`.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclechannel"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/shellintegration"
)

// transportKind describes how a lifecycle transport's domains reach the
// kernel, so the grant builder can compose the child's launch: a local
// adapter's domains ride the inherited descriptor (fd 3); a remote
// adapter's ride the forwarded loopback port; a listener transport's ride a
// loopback TCP listener (the ssh child's -R endpoint).
type transportKind struct {
	local bool // domains ride the inherited descriptor (fd 3)
	port  int  // remote: the forwarded loopback port; listener: the local listener port
}

type transportRegistry struct {
	mu    sync.Mutex
	kinds map[lifecycle.TransportID]transportKind
}

func newTransportRegistry() *transportRegistry {
	return &transportRegistry{kinds: make(map[lifecycle.TransportID]transportKind)}
}

func (r *transportRegistry) register(t lifecycle.TransportID, k transportKind) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.kinds[t] = k
}

func (r *transportRegistry) lookup(t lifecycle.TransportID) (transportKind, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	k, ok := r.kinds[t]
	return k, ok
}

// sessionRegistry maps a lifecycle lane to the session that owns it, so the
// grant builder can anchor the child's bootstrap (NOCX_SESSION_ID, AD-7) to
// the same session the parent reports into. It is fed by the same
// registerLane closure that binds lanes to the transport's session registry.
type sessionRegistry struct {
	mu     sync.Mutex
	byLane map[lifecycle.LaneID]string
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{byLane: make(map[lifecycle.LaneID]string)}
}

func (r *sessionRegistry) register(lane lifecycle.LaneID, sid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byLane[lane] = sid
}

func (r *sessionRegistry) lookup(lane lifecycle.LaneID) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sid, ok := r.byLane[lane]
	return sid, ok
}

// newChildGrantBuilder wires the child-domain bootstrap builder behind the
// domain_grant outbound. It is the single owner of "how do we reach a
// host" (ADR-0022): the composition root decides the transport and the
// launch, and the shell never parses the bootstrap.
func newChildGrantBuilder(lg log.Logger, pub *lifecyclepub.Publisher, shint *shellintegration.Impl, transports *transportRegistry, sessions *sessionRegistry) lifecyclepub.GrantBuilder {
	return func(req lifecyclepub.GrantRequest) (lifecyclepub.GrantBootstrap, error) {
		parent, ok := pub.Domain(req.Parent)
		if !ok {
			return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: unknown parent %s", req.Parent)
		}
		kind, ok := transports.lookup(parent.Transport)
		if !ok {
			return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: transport %s has no recorded kind", parent.Transport)
		}
		switch req.Env {
		case lifecycle.EnvSudo, lifecycle.EnvSu:
			return buildLocalChildBootstrap(pub, sessions, req, parent.Transport, kind)
		case lifecycle.EnvSSH:
			return buildSSHChildBootstrap(lg, pub, shint, sessions, req, kind)
		default:
			return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: unsupported environment %q", req.Env)
		}
	}
}

// buildLocalChildBootstrap composes the sudo/su child: the child's bash
// rcfile, minted on the parent's own transport (locally the child inherits
// the preserved descriptor fd 3; remotely it connects to the parent's
// forwarded port). The rcfile is the opaque bootstrap the parent stages
// into the preserved fd; its final line closes the descriptor once bash has
// read it, so the per-epoch capability it carries cannot be re-read by a
// descendant.
func buildLocalChildBootstrap(pub *lifecyclepub.Publisher, sessions *sessionRegistry, req lifecyclepub.GrantRequest, parentTransport lifecycle.TransportID, kind transportKind) (lifecyclepub.GrantBootstrap, error) {
	sid, ok := sessions.lookup(req.Lane)
	if !ok {
		return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: no session registered for lane %s", req.Lane)
	}
	h, err := pub.RequestDomain(req.Lane, &req.Parent, parentTransport)
	if err != nil {
		return lifecyclepub.GrantBootstrap{}, err
	}
	opts := shellintegration.LaunchOptions{
		SessionID:  sid,
		Enhanced:   true,
		Capability: hex.EncodeToString(h.Capability[:]),
		Recovery:   hex.EncodeToString(h.Recovery[:]),
		Lane:       string(req.Lane),
		Domain:     string(h.Domain),
		Epoch:      h.Epoch,
	}
	if kind.local {
		opts.LifecycleFD = 3 // the inherited socketpair descriptor
	} else {
		opts.LifecyclePort = kind.port
	}
	rc, err := shellintegration.LocalBashRcfile(opts)
	if err != nil {
		return lifecyclepub.GrantBootstrap{}, err
	}
	// The child reads the rcfile from the preserved bootstrap descriptor
	// (sudo --preserve-fds=3,N ... --rcfile /dev/fd/N, ADR-0024's preferred
	// answer: the per-epoch capability never enters a filesystem object).
	// The descriptor NUMBER is chosen by the parent at launch from the free
	// single-digit range (4-9, the POSIX-sh guarantee — a busy user fd is
	// never clobbered), so the rcfile closes the descriptor it was READ
	// FROM — BASH_SOURCE[0] is /dev/fd/N inside the rcfile — once bash has
	// finished with it: its contents must not stay reachable to the child's
	// descendants. The eval is bash-3.2-safe (no {var} close in 3.2); the
	// suffix is validated by the fd the shell itself opened.
	rc += "\neval \"exec ${BASH_SOURCE[0]##*/}<&-\" 2>/dev/null\n"
	return lifecyclepub.GrantBootstrap{Domain: h.Domain, Epoch: h.Epoch, Bootstrap: rc}, nil
}

// buildSSHChildBootstrap composes the ssh child: a loopback listener
// transport (the local endpoint of the child's -R reverse forward), the
// child minted on it, and the rewritten command line the parent executes —
// the in-band install payload piped into `ssh -t` with the -R. The remote
// port is pre-picked because the payload must name it before ssh runs; a
// server that refuses the bind (PermitListen) fails the forward, the child
// never establishes, and the session is the honest conventional fallback.
func buildSSHChildBootstrap(lg log.Logger, pub *lifecyclepub.Publisher, shint *shellintegration.Impl, sessions *sessionRegistry, req lifecyclepub.GrantRequest, parentKind transportKind) (lifecyclepub.GrantBootstrap, error) {
	if !parentKind.local {
		// A remote parent runs ssh on the far host: the -R forward would
		// terminate at that host, not at this backend's listener. The
		// mechanism does not preclude it — the far host's own remote
		// adapter listener is the natural endpoint — but it is not built
		// in this bead. Refuse honestly: the parent runs its command
		// conventionally.
		return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: ssh nested inside a remote parent is not implemented")
	}
	sid, ok := sessions.lookup(req.Lane)
	if !ok {
		return lifecyclepub.GrantBootstrap{}, fmt.Errorf("child domain: no session registered for lane %s", req.Lane)
	}
	ln, err := lifecyclechannel.NewListener(lg, pub)
	if err != nil {
		return lifecyclepub.GrantBootstrap{}, err
	}
	h, err := pub.RequestDomain(req.Lane, &req.Parent, ln.TransportID())
	if err != nil {
		_ = ln.Close()
		return lifecyclepub.GrantBootstrap{}, err
	}
	remotePort, err := randomPort()
	if err != nil {
		_ = ln.Close()
		return lifecyclepub.GrantBootstrap{}, err
	}
	plan, err := shint.InBandBootstrap(sid, &shellintegration.ChannelConfig{
		Lane:   string(req.Lane),
		Domain: string(h.Domain),
		Epoch:  h.Epoch,
		Port:   remotePort,
	})
	if err != nil {
		_ = ln.Close()
		return lifecyclepub.GrantBootstrap{}, err
	}
	line := composeSSHChildLine(plan, remotePort, ln.Port(), req)
	return lifecyclepub.GrantBootstrap{Domain: h.Domain, Epoch: h.Epoch, Bootstrap: line}, nil
}

// composeSSHChildLine builds the rewritten command line the parent executes
// (ADR-0022: the ssh command line is the carrier). The shape:
//
//	stty-save; { printf wrapper; printf cap; printf payload; printf terminator;
//	             stty raw -echo; cat; } | ssh -t -R 127.0.0.1:CPORT:127.0.0.1:LPORT dst;
//	rc=$?; stty-restore; (exit rc)
//
// The in-band stream (wrapper, capability as the first line, payload,
// terminator) is typed into the remote login shell at its prompt; `cat`
// bridges the user's keyboard after it and keeps the pipe open, and the
// local raw-mode window makes the remote pty's echo authoritative. The
// capability never touches a filesystem object (it rides the stream, as the
// in-band contract requires).
func composeSSHChildLine(plan shellintegration.InBandPlan, remotePort, localPort int, req lifecyclepub.GrantRequest) string {
	var b strings.Builder
	b.WriteString("__nocx_ssh_saved=$(stty -g); { ")
	b.WriteString("printf '%s\\n' ")
	b.WriteString(shellintegration.ShellQuote(plan.Wrapper))
	b.WriteString(" ")
	b.WriteString(shellintegration.ShellQuote(plan.Capability))
	b.WriteString("; printf '%s\\n' ")
	b.WriteString(shellintegration.ShellQuote(plan.Payload))
	b.WriteString("; printf '%s\\n' ")
	b.WriteString(shellintegration.ShellQuote(plan.Terminator))
	b.WriteString("; stty raw -echo; cat; } | ssh -t -R 127.0.0.1:")
	b.WriteString(fmt.Sprintf("%d:127.0.0.1:%d", remotePort, localPort))
	if req.Port != 0 {
		b.WriteString(fmt.Sprintf(" -p %d", req.Port))
	}
	b.WriteString(" ")
	dest := req.Host
	if req.User != "" {
		dest = req.User + "@" + dest
	}
	b.WriteString(shellintegration.ShellQuote(dest))
	b.WriteString("; __nocx_ssh_rc=$?; stty \"$__nocx_ssh_saved\" 2>/dev/null; (exit $__nocx_ssh_rc)")
	return b.String()
}

// randomPort picks a high loopback port for the -R bind. A collision with
// an occupied remote port makes the forward fail and the child fall back
// conventionally — the honest degrade, never a silent one.
func randomPort() (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(20000))
	if err != nil {
		return 0, err
	}
	return 40000 + int(n.Int64()), nil
}
