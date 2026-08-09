// Package lifecyclechannel implements the local descriptor transport of the
// authenticated lifecycle protocol (docs/lifecycle-protocol.md; ADR-0024
// decision 2): a socketpair whose child end the shell inherits as fd 3 via
// exec.Cmd.ExtraFiles, and an adapter that pumps envelopes between that
// descriptor and the kernel.
//
// The adapter is a pipe, not a policy. It mints one lane and one Pending
// domain on the kernel, frames inbound bytes with the shared codec, delivers
// every mapped envelope to Kernel.Ingest, forwards every skipped garbage
// region to Kernel.NotifyGap, and reports loss to Kernel.TransportLost. It
// has no CurrentDomain accessor and assumes nothing about how many domains a
// transport carries — the kernel's registry is the authority (the future
// relay is a third adapter, not a protocol rewrite). The shell owns the
// event stream; the adapter never synthesizes an event.
//
// The descriptor is deliberately not private: bash's {var} redirection is
// not close-on-exec, so descendants inherit fd 3 (ADR-0024 decision 2,
// measured). That is survivable only because every frame must carry the
// epoch's capability, which the kernel verifies before consulting any state.
// A shell that execs another shell therefore needs no adapter action: the
// new image keeps speaking for the same domain (same capability, same
// epoch), and a re-hello within the epoch is a reconnect the kernel accepts
// (protocol §5).
package lifecyclechannel

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclecodec"
	"github.com/shady2k/nocx/internal/log"
)

// ErrClosed is returned by Send once the adapter has been closed or lost.
var ErrClosed = errors.New("lifecyclechannel: adapter closed")

// writeTimeout bounds one outbound envelope write. The kernel's outbound
// sends are best-effort (the shell times out its handshake and the session
// stays conventional — the safe direction), so a shell that has stopped
// reading must never wedge the kernel's flush.
const writeTimeout = 5 * time.Second

// Kernel is the slice of the lifecycle kernel the adapter drives. The
// concrete *lifecycle.Kernel satisfies it; the seam exists so the adapter is
// testable and the composition root decides the kernel.
type Kernel interface {
	BindTransport(t lifecycle.TransportID, port lifecycle.Port) error
	RequestDomain(lane lifecycle.LaneID, parent *lifecycle.DomainID, t lifecycle.TransportID) (lifecycle.DomainHandle, error)
	Ingest(t lifecycle.TransportID, env lifecycle.Envelope) error
	NotifyGap(t lifecycle.TransportID, d lifecycle.DomainID, garbageBytes, garbageFrames int) error
	TransportLost(t lifecycle.TransportID) error
	Domain(id lifecycle.DomainID) (lifecycle.Domain, bool)
}

// Option configures an Adapter.
type Option func(*options)

type options struct {
	helloTimeout time.Duration
}

// WithHelloTimeout bounds the handshake: unless an authenticated hello is
// accepted within the window, the domain is abandoned (TransportLost) and
// the session stays conventional (protocol §5). Zero uses
// lifecycle.HelloTimeout. Test-only in practice; the default is the
// protocol constant.
func WithHelloTimeout(d time.Duration) Option {
	return func(o *options) { o.helloTimeout = d }
}

// Adapter is one local descriptor transport. It implements lifecycle.Port
// (the outbound half the kernel sends accept and refresh_request over) and
// drives the inbound half through the kernel.
type Adapter struct {
	log        log.Logger
	kernel     Kernel
	id         lifecycle.TransportID
	lane       lifecycle.LaneID
	domain     lifecycle.DomainID
	epoch      uint64
	capability lifecycle.Capability
	recovery   lifecycle.FenceNonce // one-shot recovery fence
	conn       *os.File             // parent end of the socketpair
	dec        *lifecyclecodec.Decoder

	helloTimeout time.Duration

	mu     sync.Mutex
	closed bool
	loss   sync.Once
	timer  *time.Timer
}

// arrives).
//
// Failure to establish the transport leaves the session conventional: New
// returns an error and the caller spawns the shell without a channel.
func New(log log.Logger, k Kernel, opts ...Option) (*Adapter, *os.File, error) {
	o := options{helloTimeout: lifecycle.HelloTimeout}
	for _, opt := range opts {
		opt(&o)
	}

	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("lifecycle socketpair: %w", err)
	}
	parent := os.NewFile(uintptr(fds[0]), "lifecycle-channel-parent")
	child := os.NewFile(uintptr(fds[1]), "lifecycle-channel-child")

	a := &Adapter{
		log:          log,
		kernel:       k,
		id:           lifecycle.TransportID("tpt-" + randHex(8)),
		lane:         lifecycle.LaneID("lane-" + randHex(8)),
		conn:         parent,
		helloTimeout: o.helloTimeout,
	}
	a.dec = lifecyclecodec.NewDecoder(parent, lifecyclecodec.Config{}, a.reportGap)

	cleanup := func() {
		_ = parent.Close()
		_ = child.Close()
	}
	if berr := k.BindTransport(a.id, a); berr != nil {
		cleanup()
		return nil, nil, fmt.Errorf("bind lifecycle transport: %w", berr)
	}
	h, err := k.RequestDomain(a.lane, nil, a.id)
	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("request lifecycle domain: %w", err)
	}
	a.domain = h.Domain
	a.epoch = h.Epoch
	a.capability = h.Capability
	a.recovery = h.Recovery
	log.Info("lifecycle channel established",
		"transport", a.id, "lane", a.lane, "domain", h.Domain, "epoch", h.Epoch)

	// The timer may fire before New returns (a short hello timeout), so the
	// field is stored under the same mutex stopHelloTimer reads: the
	// callback's read is then ordered against this write and never races.
	t := time.AfterFunc(a.helloTimeout, a.lose)
	a.mu.Lock()
	a.timer = t
	a.mu.Unlock()
	go a.pump()
	return a, child, nil
}

// Lane returns the adapter's own lane — the addressing tuple it minted and
// bound to the kernel. The session/app wiring uses it to register the lane
// against a session id so published facts route to the right subscriber.
// It is the adapter's own identity, not a current-domain singleton: the
// transport may carry several domains, and this is the one this adapter
// established.
func (a *Adapter) Lane() lifecycle.LaneID {
	return a.lane
}

// Launch carries the addressing tuple the shell's bootstrap must embed: the
// non-secret names (lane, domain, epoch, fd) travel as environment, and the
// capability plus the one-shot recovery fence ride the rcfile TEXT — never
// the environment (ADR-0024 decision 2; protocol §4).
type Launch struct {
	Lane       lifecycle.LaneID
	Domain     lifecycle.DomainID
	Epoch      uint64
	Capability string // 64 lowercase hex chars
	Recovery   string // 64 lowercase hex chars; the one-shot recovery fence
}

// Launch returns the adapter's own addressing tuple, for the session/app
// wiring to build the shell's bootstrap (the local tier's rcfile). It is
// the adapter's own identity, not a current-domain singleton: the transport
// may carry several domains, and this is the one this adapter established.
func (a *Adapter) Launch() Launch {
	return Launch{
		Lane:       a.lane,
		Domain:     a.domain,
		Epoch:      a.epoch,
		Capability: hex.EncodeToString(a.capability[:]),
		Recovery:   hex.EncodeToString(a.recovery[:]),
	}
}

// Send implements lifecycle.Port: it frames one outbound envelope (accept,
// refresh_request — the only two kinds the kernel sends) onto the
// descriptor. Failures are best-effort: the kernel ignores them and the
// shell times out its handshake in the safe direction.
func (a *Adapter) Send(env lifecycle.Envelope) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return ErrClosed
	}
	_ = a.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := lifecyclecodec.Encode(a.conn, env)
	a.mu.Unlock()
	if err != nil {
		a.log.Debug("lifecycle outbound send failed", "kind", env.Event.Kind, "error", err)
		return err
	}
	// The accept reached the shell: the handshake is complete, and ONLY
	// now does the hello bound stop (decision 9). The accept is gated on
	// the renderer's acknowledgement, so a publication/ack failure leaves
	// the timer running and the domain times out — it must never sit
	// Established forever.
	if env.Event.Kind == lifecycle.KindAccept {
		a.stopHelloTimer()
	}
	return nil
}

// Close tears the transport down: the domain ends (TransportLost), the hello
// timer stops, and the pump stops. It is the session-end disposal path.
func (a *Adapter) Close() error {
	a.lose()
	return nil
}

// lose is the single loss path, executed once: notify the kernel, mark the
// adapter closed, and close the descriptor so the pump unblocks. Idempotent
// under concurrent callers (pump EOF, hello timeout, explicit Close).
func (a *Adapter) lose() {
	a.loss.Do(func() {
		a.stopHelloTimer()
		if err := a.kernel.TransportLost(a.id); err != nil {
			a.log.Warn("lifecycle transport lost notification failed", "error", err)
		}
		a.mu.Lock()
		a.closed = true
		a.mu.Unlock()
		_ = a.conn.Close()
	})
}

func (a *Adapter) stopHelloTimer() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
}

// reportGap is the codec's gap sink: every skipped garbage region reaches
// the kernel so the desync budgets are enforced in one place (protocol §6).
// NotifyGap rejects regions for domains that are not live (e.g. garbage
// before the handshake); those are expected and ignored.
func (a *Adapter) reportGap(bytes, frames int) {
	if err := a.kernel.NotifyGap(a.id, a.domain, bytes, frames); err != nil {
		a.log.Debug("lifecycle gap notification rejected",
			"domain", a.domain, "bytes", bytes, "frames", frames, "error", err)
	}
}

// pump moves inbound envelopes and loss into the kernel until the stream
// ends. It is the sole reader of the descriptor.
func (a *Adapter) pump() {
	defer func() { _ = a.conn.Close() }()
	for {
		env, err := a.dec.ReadFrame()
		if err == nil {
			if ierr := a.kernel.Ingest(a.id, env); ierr != nil {
				// Quarantine (a Desynchronized domain), a rejected
				// candidate, an illegal event: the kernel mutates nothing
				// and this adapter records nothing but the fact.
				a.log.Debug("lifecycle envelope rejected",
					"domain", env.Domain, "kind", env.Event.Kind, "error", ierr)
				continue
			}
			// The hello bound is NOT stopped here: the accept is gated on
			// the renderer's acknowledgement (decision 9) and may be
			// flushed later, so the timer keeps bounding the whole
			// handshake and stops only in Send, when the accept actually
			// goes out.
			continue
		}
		switch {
		case errors.Is(err, io.EOF):
			// The shell closed its end. A clean exit sends domain_closed
			// first (stream ordering guarantees it precedes EOF); the
			// kernel's read model is the authority on whether the domain
			// ended.
			a.endOfStream()
			return
		case errors.Is(err, lifecyclecodec.ErrScanBudgetExhausted):
			// The kernel revoked the domain (the final gap report crossed
			// a budget). Drain the socket so the shell never blocks on a
			// full buffer; the end-of-stream policy applies when it closes.
			_, _ = io.Copy(io.Discard, a.conn)
			a.endOfStream()
			return
		default:
			// A read error: the transport broke.
			a.log.Warn("lifecycle transport read error", "error", err)
			a.lose()
			return
		}
	}
}

// endOfStream applies the end-of-stream policy: a domain the shell already
// closed (domain_closed, or a revoked one) ends cleanly; a domain that is
// still live lost its speaker without saying goodbye, so the kernel marks it
// Lost and its open attempts unknown (protocol §12).
func (a *Adapter) endOfStream() {
	d, ok := a.kernel.Domain(a.domain)
	if ok {
		switch d.State {
		case lifecycle.DomainClosed, lifecycle.DomainLost:
			a.log.Info("lifecycle transport ended cleanly", "domain", a.domain)
			a.mu.Lock()
			a.closed = true
			a.mu.Unlock()
			return
		}
	}
	a.log.Info("lifecycle transport ended with a live domain; marking lost", "domain", a.domain)
	a.lose()
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = io.ReadFull(rand.Reader, b)
	return hex.EncodeToString(b)
}
