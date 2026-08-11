package lifecycle

import "time"

// Identifiers are opaque strings. Nothing in this package ever obtains them
// from a singleton: lane, domain, epoch and transport travel in every envelope
// and are passed to every call, which is the property that keeps the future
// relay a third adapter instead of a protocol rewrite (ADR-0024 decision 2).
type (
	LaneID      string
	DomainID    string
	TransportID string
	AttemptID   string
	RequestID   string
)

// Capability is the per-epoch bearer: at least 256 random bits, minted by the
// kernel, substituted into the integration script text, never exported to the
// environment. Possession of the transport is not possession of the domain.
type Capability [32]byte

// FenceNonce is the unpredictable render fence a completion carries and the
// shell also writes to the pty after the command's output. It is a rendezvous
// for render ordering and carries no authority.
type FenceNonce [32]byte

// ProtocolVersion is the version carried by every envelope.
const ProtocolVersion uint8 = 1

// Wire names of the event kinds (docs/lifecycle-protocol.md §3).
const (
	KindHello             EventKind = "hello"
	KindAccept            EventKind = "accept"
	KindStart             EventKind = "start"
	KindComplete          EventKind = "complete"
	KindPromptReady       EventKind = "prompt_ready"
	KindRefreshRequest    EventKind = "refresh_request"
	KindSnapshot          EventKind = "snapshot"
	KindDomainEstablished EventKind = "domain_established"
	KindDomainActivated   EventKind = "domain_activated"
	KindDomainSuspended   EventKind = "domain_suspended"
	KindDomainClosed      EventKind = "domain_closed"
	// KindDomainRequest asks the kernel for a child domain for a nested
	// environment (sudo/su/ssh) the parent shell is about to enter. The
	// shell-visible answer is KindDomainGrant; the two are one
	// request/response pair (protocol doc §9).
	KindDomainRequest EventKind = "domain_request"
	// KindDomainGrant is the kernel's answer to a domain_request: the
	// child's domain id, epoch and the opaque, already-substituted
	// bootstrap the parent executes to launch the child. It travels the
	// authenticated channel to the PARENT (its envelope addresses the
	// parent); the bootstrap is opaque text the parent never parses.
	KindDomainGrant EventKind = "domain_grant"
)

// Nested environment kinds a domain_request may name. The kernel validates
// the kind and rejects anything else outright; the bootstrap the grant
// carries is built per kind by the composition root (a preserved-fd launch
// for sudo/su, a rewritten ssh line for ssh — ADR-0022).
const (
	EnvSudo = "sudo"
	EnvSu   = "su"
	EnvSSH  = "ssh"
)

// Envelope is the protocol unit. Every envelope carries the full addressing
// tuple — version, lane, domain, epoch, sequence, capability — and one event.
// The sequence rule (§11 of the protocol doc) applies to inbound envelopes;
// outbound envelopes (accept, refresh_request, domain_grant) carry
// Sequence 0.
type Envelope struct {
	Version    uint8
	Lane       LaneID
	Domain     DomainID
	Epoch      uint64
	Sequence   uint64
	Capability Capability
	Event      Event
}

type Event struct {
	Kind              EventKind
	Hello             *Hello
	Accept            *Accept
	Start             *Start
	Complete          *Complete
	PromptReady       *PromptReady
	RefreshRequest    *RefreshRequest
	Snapshot          *Snapshot
	DomainEstablished *DomainEstablishedEvent
	DomainActivated   *DomainActivatedEvent
	DomainSuspended   *DomainSuspendedEvent
	DomainClosed      *DomainClosedEvent
	DomainRequest     *DomainRequest
	DomainGrant       *DomainGrant
}

// EventKind is the wire name of an event kind.
type EventKind string

// validInbound reports whether the event is a legal shell→kernel event with
// its payload present. Kernel-originated kinds (accept, refresh_request,
// domain_established) are never inbound.
func (e Event) validInbound() bool {
	switch e.Kind {
	case KindHello:
		return e.Hello != nil
	case KindStart:
		return e.Start != nil
	case KindComplete:
		return e.Complete != nil
	case KindPromptReady:
		return e.PromptReady != nil
	case KindSnapshot:
		return e.Snapshot != nil
	case KindDomainActivated:
		return e.DomainActivated != nil
	case KindDomainSuspended:
		return e.DomainSuspended != nil
	case KindDomainClosed:
		return e.DomainClosed != nil
	case KindDomainRequest:
		return e.DomainRequest != nil
	}
	return false
}

// Event payloads. Field names follow the wire contract in
// docs/lifecycle-protocol.md; the wire encoding itself is the adapter's
// (length-delimited JSON — see the doc's framing section).
type (
	// Hello is the first frame of a connection. The capability is in the
	// envelope; the payload names the shell.
	Hello struct {
		Shell string `json:"shell"`
	}

	// Accept is the kernel's answer: the domain is live, and only now may
	// the shell suppress its prompt or emit lifecycle events.
	Accept struct{}

	// Start opens an attempt. AttemptID is present when the shell can name
	// its own attempt; Command is the shell's view of the line and is
	// ignored when the attempt attaches to an app-owned one.
	Start struct {
		AttemptID *AttemptID `json:"attempt,omitempty"`
		Command   string     `json:"command,omitempty"`
	}

	// Complete closes an attempt with an exit status and the render fence.
	Complete struct {
		// AttemptID is optional: a shell that attached to an app-submitted
		// attempt never learns the app-minted id, so it names nothing and the
		// kernel resolves the domain's single open attempt by context. When
		// present it must match that attempt. The kernel already permits at
		// most one open attempt per domain, so there is nothing to
		// disambiguate — and a required id here made completion unreachable
		// from the shell for the primary (editor-submit) path.
		AttemptID *AttemptID `json:"attempt,omitempty"`
		ExitCode  *int       `json:"exit_code,omitempty"`
		Fence     FenceNonce `json:"fence"`
	}

	// PromptReady declares the shell is at a prompt; the editor may own
	// keys only in the PromptReady lifecycle.
	PromptReady struct{}

	// RefreshRequest is the kernel's demand for an authenticated snapshot.
	RefreshRequest struct {
		RequestID RequestID `json:"request"`
	}

	// Snapshot answers a refresh request and reconciles the kernel's state.
	Snapshot struct {
		RequestID       RequestID     `json:"request"`
		ShellState      ShellState    `json:"shell_state"`
		ActiveAttemptID *AttemptID    `json:"active_attempt,omitempty"`
		LastCompleted   *CompletedRef `json:"last_completed,omitempty"`
		NextSequence    uint64        `json:"next_seq"`
	}

	// CompletedRef names a completed attempt and its exit code.
	CompletedRef struct {
		AttemptID AttemptID `json:"attempt"`
		ExitCode  *int      `json:"exit_code,omitempty"`
	}

	// DomainEstablishedEvent is the fact published when the handshake
	// completes; the frontend keys enhanced mode on it. It is never a
	// transport envelope (see the protocol doc §3 boundary note).
	DomainEstablishedEvent struct{}

	// DomainActivatedEvent restores a suspended domain to the lane.
	DomainActivatedEvent struct{}

	// DomainSuspendedEvent yields the active domain to a nested environment.
	DomainSuspendedEvent struct{}

	// DomainClosedEvent ends the top-of-stack domain.
	DomainClosedEvent struct{}

	// DomainRequest asks the kernel to mint a child domain for a nested
	// environment the parent shell is about to enter. The request must
	// carry the environment kind; host/user/port are the ssh destination
	// the backend composes the rewritten line from (ADR-0022: the ssh
	// command line is the carrier). RequestID is the shell's own nonce:
	// the grant echoes it, so a stale grant from an earlier request can
	// never be mistaken for the answer to this one.
	DomainRequest struct {
		RequestID RequestID `json:"request"`
		Env       string    `json:"env"`
		Host      string    `json:"host,omitempty"`
		User      string    `json:"user,omitempty"`
		Port      int       `json:"port,omitempty"`
		// Opts are the ssh options the user typed, in the order they typed
		// them, with their arguments — everything between `ssh` and the
		// destination that the composer does not model itself.
		//
		// They are here because the composer rebuilds the line from scratch
		// and had nothing else to rebuild it from. The shell's detector
		// NAMES -i, -o, -F, -J, -l, -e, -b, -c and -m, accepts a line
		// carrying them, and used to keep only host/user/port — so
		// `ssh -i ~/.ssh/prod -J bastion host` ran with the wrong key and no
		// jump host, and the block still showed the line the user typed
		// (nocx-c6z0). An option the shell cannot model still refuses the
		// whole interception; dropping one silently is the defect.
		//
		// -p is absent by construction (it is Port above) and so is -t (the
		// composer adds its own, and ssh reads a second one as -tt).
		Opts []string `json:"opts,omitempty"`
	}

	// DomainGrant is the kernel's answer to a domain_request: the child's
	// domain id and epoch, plus the opaque, already-substituted bootstrap
	// the parent executes to launch the child (a rewritten command line
	// for ssh, a preserved-fd launch for sudo/su). The bootstrap is opaque
	// text — the parent never parses it; the per-epoch capability rides
	// inside it, never in the environment. The envelope addresses the
	// PARENT (its lane/domain/epoch/capability): the grant is delivered
	// to the parent's connection on the parent's transport. An empty
	// bootstrap is the refusal: the parent runs its command conventionally
	// (no suspension), the honest fallback when no child could be minted.
	DomainGrant struct {
		RequestID RequestID `json:"request"`
		// Env/Host/User/Port are the request's context, echoed by the
		// kernel so the bootstrap builder can compose the right launch
		// without state of its own.
		Env  string `json:"env,omitempty"`
		Host string `json:"host,omitempty"`
		User string `json:"user,omitempty"`
		Port int    `json:"port,omitempty"`
		// Opts rides with them for the same reason: the builder composes
		// the launch line and needs everything the line is made of.
		Opts []string `json:"opts,omitempty"`
		// Domain/Epoch/Bootstrap are the answer, filled by the publisher's
		// grant seam (which mints via kernel.RequestDomain — the kernel
		// stays the sole minter) before delivery.
		Domain    DomainID `json:"domain"`
		Epoch     uint64   `json:"epoch"`
		Bootstrap string   `json:"bootstrap,omitempty"`
	}
)

// ShellState is the shell's answer about where it is.
type ShellState string

const (
	ShellAtPrompt ShellState = "at_prompt"
	ShellRunning  ShellState = "running"
)

// Frame and budget constants — the concrete numbers the protocol doc §5–§6
// promises. MaxFrameBytes, MaxHelloBytes and HelloTimeout are enforced by the
// transport adapter; the kernel enforces the handshake and desync budgets and
// MaxCommandBytes itself.
const (
	// MaxFrameBytes bounds one JSON frame in either direction. It is 256
	// KiB because the kernel→shell direction carries the child domain's
	// opaque bootstrap (§9), and that bootstrap is a full remote launcher:
	// the publish prelude embeds the integration bundle, which measures
	// ~77 KiB today and grows with the scripts. At the original 64 KiB the
	// grant was not truncated and not refused — Encode returned
	// ErrFrameTooLarge, the frame was never written, and the parent shell
	// waited out its five-second grant timeout, lost the channel and ran
	// the user's ssh conventionally, with no diagnostic anywhere
	// (nocx-beib). The shells declare the same number in their hello;
	// lifecyclecodec's TestMaxFrameBytes_ShellsDeclareTheSameBound is what
	// keeps the two from drifting.
	MaxFrameBytes          = 256 * 1024
	MaxHelloBytes          = 1024
	HelloTimeout           = 10 * time.Second
	HandshakeFailureBudget = 8
	HandshakeFailureWindow = 30 * time.Second
	ScanBudgetBytes        = 64 * 1024
	ScanBudgetFrames       = 128
	ScanBudgetDuration     = 30 * time.Second
	MaxDesyncEpisodes      = 3
	MaxCommandBytes        = 4096
)

// Budgets carries the kernel-enforced limits. A zero value field falls back to
// the constant above.
type Budgets struct {
	HandshakeFailures int
	HandshakeWindow   time.Duration
	ScanBytes         int
	ScanFrames        int
	ScanDuration      time.Duration
	MaxDesyncEpisodes int
	MaxCommandBytes   int
}

// DefaultBudgets returns the normative budgets from the constants above.
func DefaultBudgets() Budgets {
	return Budgets{
		HandshakeFailures: HandshakeFailureBudget,
		HandshakeWindow:   HandshakeFailureWindow,
		ScanBytes:         ScanBudgetBytes,
		ScanFrames:        ScanBudgetFrames,
		ScanDuration:      ScanBudgetDuration,
		MaxDesyncEpisodes: MaxDesyncEpisodes,
		MaxCommandBytes:   MaxCommandBytes,
	}
}

func (b Budgets) withDefaults() Budgets {
	d := DefaultBudgets()
	if b.HandshakeFailures == 0 {
		b.HandshakeFailures = d.HandshakeFailures
	}
	if b.HandshakeWindow == 0 {
		b.HandshakeWindow = d.HandshakeWindow
	}
	if b.ScanBytes == 0 {
		b.ScanBytes = d.ScanBytes
	}
	if b.ScanFrames == 0 {
		b.ScanFrames = d.ScanFrames
	}
	if b.ScanDuration == 0 {
		b.ScanDuration = d.ScanDuration
	}
	if b.MaxDesyncEpisodes == 0 {
		b.MaxDesyncEpisodes = d.MaxDesyncEpisodes
	}
	if b.MaxCommandBytes == 0 {
		b.MaxCommandBytes = d.MaxCommandBytes
	}
	return b
}
