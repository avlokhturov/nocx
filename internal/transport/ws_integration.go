package transport

// The session.integrationChanged control plane (nocx-dvql; contracts/
// session.integrationChanged.schema.json): whether a session's shell
// integration is live, and when it is not, why.
//
// It replaces the shellIntegrationReason field of the session-open ack, which
// could only answer once, at open, and therefore could never report the two
// failures that matter most — a handshake that expires ten seconds later, and
// a channel lost mid-session. Keeping the field beside this notification would
// leave two places answering "is this session integrated", which is the defect
// AD-8 names, so the field is gone rather than deprecated (greenfield,
// clean-only).
//
// This is NOT lifecycle.changed and does not duplicate it. That fact is what
// the authenticated kernel concluded about a DOMAIN; this one is about a
// SESSION and carries what only the launcher and the transport know: which
// shell was actually started, and why integration was refused, declined or
// lost. The two are combined here and nowhere else:
//
//   - the launch side (the local pty factory, and the ssh connect path)
//     reports what it started and whether it was refused outright —
//     RegisterIntegration;
//   - the kernel's published facts say when a domain went live —
//     PublishLifecycle calls noteIntegrationLive;
//   - the adapter says which path ended a transport — NoteIntegrationLoss.
//
// The split is not cosmetic. A handshake that times out never establishes a
// domain, so the lane's projection never moves and the publisher emits
// nothing at all: a status derived from published facts alone could not
// report the dominant local failure, which is the whole defect. Conversely
// "the domain is live" is the kernel's word and must not be re-derived from
// the transport's. One owner per question, on each side of the seam.

import (
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
)

// Wire values of the status axis (contracts/session.integrationChanged.schema
// .json). The renderer keys its badge and its card on these exact strings.
const (
	// IntegrationStarting is the honest interval before the shell has
	// proved itself: a session that asked for integration begins here and
	// stays until it either integrates or gives up, so the product never
	// claims either outcome early.
	IntegrationStarting = "starting"
	// IntegrationIntegrated means an authenticated domain is live.
	IntegrationIntegrated = "integrated"
	// IntegrationConventional means integration was attempted and did not
	// happen: a working terminal with a native prompt, and a reason.
	IntegrationConventional = "conventional"
	// IntegrationLost means it was integrated and is not any more.
	IntegrationLost = "lost"
)

// integrationStatus is one session's integration axis as the backend
// currently knows it. It is deliberately small: everything in it is either
// the launch side's own record or the kernel's conclusion, and nothing is
// derived from the byte stream (AD-6).
type integrationStatus struct {
	// shell is what the backend started, absolute where the launch had a
	// path. Fixed at registration and never revised: a later correction
	// would be a second answer to "what did nocx start".
	shell string
	// status is the wire value above.
	status string
	// reason is why, present exactly when status is conventional or lost.
	reason ssh.RefusalReason
	// everLive records that an authenticated domain WAS live on this
	// session. It is what separates "never integrated" from "integrated and
	// then lost" — the same transport loss means different things either
	// side of it, and only the session knows which side it is on.
	everLive bool
	// observedProcess is the best-effort process observation for the
	// details surface. Always a guess, never authority, and never derived
	// from the byte stream; empty when the backend observed nothing.
	observedProcess string
}

// integrationChangedParams is the params object of the
// session.integrationChanged notification. Contracted like every other
// unsolicited notification, because a server-initiated frame has no request
// to correlate against and nothing checking its shape at the call site.
type integrationChangedParams struct {
	SessionID string             `json:"sessionId"`
	Status    string             `json:"status"`
	Reason    string             `json:"reason,omitempty"`
	Shell     string             `json:"shell"`
	Detail    *integrationDetail `json:"detail,omitempty"`
}

// integrationDetail is the best-effort half. Marked as a guess by the
// product, never by omission here.
type integrationDetail struct {
	ObservedProcess string `json:"observedProcess"`
}

// RegisterIntegration records what a session's launch started and what it
// already knows about the outcome, and is the only way a session enters the
// integration axis at all. A session that never asked for integration is
// never registered and therefore emits nothing — absence is how "conventional
// by design" is expressed, so the surface has nothing to nag about.
//
// It does not emit. The open ack must precede the session's own traffic in
// both directions (AD-7), and the launch runs inside the open call, so the
// first notification is sent by the open handler after the ack —
// emitIntegration below.
func (s *WSServer) RegisterIntegration(sid session.ID, shell string, status string, reason ssh.RefusalReason) {
	if sid == "" || shell == "" {
		return
	}
	s.integrationMu.Lock()
	defer s.integrationMu.Unlock()
	if s.integrations == nil {
		s.integrations = make(map[session.ID]*integrationStatus)
	}
	s.integrations[sid] = &integrationStatus{shell: shell, status: status, reason: reason}
}

// registerRemoteIntegration enters a REMOTE session into the integration
// axis from what the ssh connect path already decided. A local session is
// registered by the pty factory instead — it is the only thing that knows
// which binary it exec'd — and returns early here rather than being answered
// twice.
//
// A session that asked for nothing and was refused nothing is not registered
// at all, and so emits nothing: absence is how "conventional by design" is
// expressed (the schema says so in as many words), and a raw-mode connection
// has no integration to nag about.
func (s *WSServer) registerRemoteIntegration(sess session.Session, cfg session.Config) {
	if sess.Kind() != session.KindRemote {
		return
	}
	reason := sess.ShellIntegrationReason()
	// script is the only mode that attempts integration (nocx-mlm7): raw
	// publishes nothing, and relay is inert. A configured RemoteCommand is
	// refused in every mode, so a reason outranks the mode.
	requested := desiredModeForAck(cfg.Remote) == "script"
	if reason == ssh.ReasonNone && !requested {
		return
	}
	status := IntegrationStarting
	if reason != ssh.ReasonNone {
		status = IntegrationConventional
	}
	s.RegisterIntegration(sess.ID(), remoteShellName(cfg.Remote), status, reason)
}

// remoteShellName is what the connect path asked the far host to run. A
// profile pin is a real shell name; unpinned, the launcher emits a POSIX
// dispatcher that detects the login shell AT THE FAR END, so the honest
// answer this side has is "auto" — nocx did not choose one. Reporting a
// guess instead would be exactly the invented confidence the details surface
// exists to avoid; the far shell's real name is authenticated only in the
// hello, which a refused or expired session never sends.
func remoteShellName(cfg *ssh.ConnectConfig) string {
	if cfg != nil && cfg.Shell != "" {
		return string(cfg.Shell)
	}
	return string(ssh.ShellAuto)
}

// unregisterIntegration drops a session's axis, called from the same teardown
// that drops its lanes so the map cannot grow with dead sessions.
func (s *WSServer) unregisterIntegration(sid session.ID) {
	s.integrationMu.Lock()
	defer s.integrationMu.Unlock()
	delete(s.integrations, sid)
}

// NoteIntegrationLoss records why a session's lifecycle transport ended and
// publishes the resulting status. The cause is the adapter's
// lifecyclechannel.LossCause, passed as its string so the transport does not
// depend on the adapter package; the composition root is what joins them.
//
// This is an emission trigger in its own right, and it has to be. A handshake
// that expires never established a domain, so the kernel's projection for
// that lane never changes and no lifecycle.changed fact is published — the
// publisher announces only lanes whose projection moved. Waiting for a fact
// here would reproduce the silence this whole notification exists to end.
func (s *WSServer) NoteIntegrationLoss(lane lifecycle.LaneID, cause string) {
	s.lifecycleMu.Lock()
	sid, ok := s.lifecycleLanes[lane]
	s.lifecycleMu.Unlock()
	if !ok {
		return
	}
	status, reason, changed := s.applyIntegrationLoss(sid, cause)
	if !changed {
		return
	}
	s.log.Info("session integration degraded",
		"session", sid, "status", status, "reason", string(reason), "cause", cause)
	s.emitIntegration(sid)
}

// applyIntegrationLoss maps a transport loss onto the session's axis under
// the lock, and reports whether anything changed.
func (s *WSServer) applyIntegrationLoss(sid session.ID, cause string) (string, ssh.RefusalReason, bool) {
	s.integrationMu.Lock()
	defer s.integrationMu.Unlock()
	st, ok := s.integrations[sid]
	if !ok {
		return "", "", false
	}
	// The session's own disposal path is not a degrade: the tab is going
	// away and the product has nothing to say about it. Emitting here would
	// paint every closing tab as broken on its way out.
	if cause == LossCauseClosed {
		return "", "", false
	}
	next := integrationStatus{shell: st.shell, everLive: st.everLive, observedProcess: st.observedProcess}
	switch {
	case st.everLive:
		// It was integrated and is not any more. Which of the transport's
		// paths noticed does not change the answer the user needs.
		next.status = IntegrationLost
		next.reason = ssh.ReasonChannelLost
	case cause == LossCauseHelloTimeout:
		next.status = IntegrationConventional
		next.reason = ssh.ReasonHandshakeTimeout
	default:
		// The descriptor ended or broke before the shell ever proved
		// itself. The backend genuinely cannot say why, and "unknown" is a
		// real visible answer rather than a synonym for success — inventing
		// handshake-timeout here would claim a bound expired when it did
		// not.
		next.status = IntegrationConventional
		next.reason = ssh.ReasonUnknown
	}
	if next.status == st.status && next.reason == st.reason {
		return "", "", false
	}
	*st = next
	return next.status, next.reason, true
}

// Loss causes as the adapter spells them. Declared here as plain strings so
// the transport does not import internal/lifecyclechannel; the composition
// root passes lifecyclechannel.LossCause through, and the adapter's own
// constants are the single source of the spelling. A conformance test in the
// app package pins the two together.
const (
	LossCauseHelloTimeout = "hello-timeout"
	LossCauseClosed       = "closed"
)

// noteIntegrationLive records that an authenticated domain went live on a
// session and publishes the resulting status. Called from PublishLifecycle:
// the kernel is the sole authority on "is a domain live", and this is the
// transport reading that conclusion rather than re-deriving it.
func (s *WSServer) noteIntegrationLive(sid session.ID) {
	s.integrationMu.Lock()
	st, ok := s.integrations[sid]
	if !ok {
		s.integrationMu.Unlock()
		return
	}
	changed := st.status != IntegrationIntegrated
	st.everLive = true
	st.status = IntegrationIntegrated
	st.reason = ssh.ReasonNone
	s.integrationMu.Unlock()
	if changed {
		s.emitIntegration(sid)
	}
}

// emitIntegration writes the session's current integration status to its
// current subscriber. The destination is resolved at emit time and never
// stored, exactly like files.changed and lifecycle.changed — which is what
// survives an AD-9 reconnect; with no subscriber the notification is dropped
// and replayIntegration re-sends it on the next attach.
func (s *WSServer) emitIntegration(sid session.ID) {
	s.integrationMu.Lock()
	st, ok := s.integrations[sid]
	var snap integrationStatus
	if ok {
		snap = *st
	}
	s.integrationMu.Unlock()
	if !ok {
		return
	}
	rx := s.getRx(sid)
	if rx == nil {
		return
	}
	wconn, _ := rx.getSubscriber()
	if wconn == nil {
		return
	}
	params := integrationChangedParams{
		SessionID: string(sid),
		Status:    snap.status,
		Shell:     snap.shell,
	}
	// Present exactly when the status is conventional or lost, absent
	// otherwise — the schema pins both halves, so a reason on a 'starting'
	// fact would fail the contract rather than reach a renderer.
	if snap.status == IntegrationConventional || snap.status == IntegrationLost {
		params.Reason = string(snap.reason)
		if params.Reason == "" {
			params.Reason = string(ssh.ReasonUnknown)
		}
	}
	if snap.observedProcess != "" {
		params.Detail = &integrationDetail{ObservedProcess: snap.observedProcess}
	}
	if err := wconn.TryNotify("session.integrationChanged", mustMarshal(params)); err != nil {
		s.log.Debug("write session.integrationChanged", "session", sid, "error", err)
	}
}

// replayIntegration re-sends the session's current integration status on
// reattach — the AD-9 resume, beside replayLifecycleFacts. A status is a
// state, not an event: a frontend that reconnects after the handshake expired
// must learn it is in a conventional terminal, and no further transition is
// coming to tell it.
func (s *WSServer) replayIntegration(sid session.ID) {
	s.emitIntegration(sid)
}

// integrationLiveFromFact answers whether a published lifecycle fact means an
// authenticated domain is live on that lane. PromptReady and Running are the
// two states that require one; Desynchronized still HAS a domain but has
// revoked the editor's authority, and Native and Lost have none. Reading the
// published fact rather than the kernel's internals keeps the transport on
// the publication boundary (ADR-0024 decision 7).
func integrationLiveFromFact(f lifecyclepub.Fact) bool {
	return f.Lifecycle == lifecyclepub.LifecyclePromptReady ||
		f.Lifecycle == lifecyclepub.LifecycleRunning
}
