package transport

// The lifecycle.changed control plane (ADR-0024 decision 7; bead nocx-u7uh.5):
// the publication boundary of the authenticated lifecycle protocol.
//
// Authentication terminates in the backend. internal/lifecyclepub wraps the
// kernel, and every mutation an adapter drives is projected into a
// schema-checked Fact; this file is the transport's half of that boundary —
// routing each fact to the lane's session's current subscriber and framing it
// as the lifecycle.changed JSON-RPC notification (contracts/
// lifecycle.changed.schema.json). The destination is resolved at emit time,
// never stored, which is what survives an AD-9 reconnect; with no subscriber
// the fact is dropped and the projection re-syncs on the next attach (the
// publisher's ReplayLane).
//
// The composition root wires WithLifecyclePublisher so the shell-spawn path
// (internal/transport/ws_shell.go) can create lifecycle adapters against the
// publisher, and calls pub.SetEmitter(tp) once the server exists. A session
// whose shell spawns an adapter registers its lane with RegisterLifecycleLane;
// until then the lane is unknown and facts about it are dropped with a debug
// log — the renderer keys enhanced mode on the published fact, so an
// unregistered lane is a conventional terminal, which is the safe direction.

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/session"
)

// lifecycleChangedNotification is the server-initiated lifecycle.changed
// frame — contracted like the files.changed and git.changed notifications
// because an unsolicited notification is exactly where an addressing or shape
// defect hides. Its schema covers the params object only; the params are the
// lifecyclepub.Fact, declared once (AD-8: one owner per behaviour).
type lifecycleChangedNotification struct {
	JSONRPC string            `json:"jsonrpc"`
	Method  string            `json:"method"`
	Params  lifecyclepub.Fact `json:"params"`
}

// WithLifecyclePublisher wires the lifecycle publication boundary into the
// server: the shell-spawn path reads the publisher to create lifecycle
// adapters against it, and every fact the publisher emits is routed to the
// lane's session by this server. When nil, no lifecycle adapters can be
// created and no facts are routed — sessions stay conventional.
func WithLifecyclePublisher(pub *lifecyclepub.Publisher) WSServerOption {
	return func(s *WSServer) { s.lifecyclePub = pub }
}

// RegisterLifecycleLane records that a lane belongs to a session, so facts
// about it route to that session's current subscriber. Called by the shell
// spawn path when it creates a lifecycle adapter; the lane is the one the
// adapter minted. Re-registering a lane moves it to the new session.
func (s *WSServer) RegisterLifecycleLane(lane lifecycle.LaneID, sid session.ID) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.lifecycleLanes == nil {
		s.lifecycleLanes = make(map[lifecycle.LaneID]session.ID)
	}
	s.lifecycleLanes[lane] = sid
}

// unregisterLifecycleLanes drops every lane bound to a session, called from
// closeSession so the registry cannot grow with dead sessions.
func (s *WSServer) unregisterLifecycleLanes(sid session.ID) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	for lane, cur := range s.lifecycleLanes {
		if cur == sid {
			delete(s.lifecycleLanes, lane)
		}
	}
}

// PublishLifecycle routes one published fact to the lane's session's current
// subscriber and writes the notification. This is the Emitter half of
// internal/lifecyclepub.Emitter: the composition root binds the server as the
// publisher's emitter after construction. The destination is resolved at emit
// time, exactly like files.changed — with no subscriber the fact is dropped
// and the projection re-syncs on the next attach.
func (s *WSServer) PublishLifecycle(f lifecyclepub.Fact) {
	lane := lifecycle.LaneID(f.Lane)
	s.lifecycleMu.Lock()
	sid, ok := s.lifecycleLanes[lane]
	s.lifecycleMu.Unlock()
	if !ok {
		s.log.Debug("lifecycle.changed for unregistered lane", "lane", f.Lane)
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
	n := lifecycleChangedNotification{
		JSONRPC: "2.0",
		Method:  "lifecycle.changed",
		Params:  f,
	}
	if err := wconn.writeJSON(n); err != nil {
		s.log.Debug("write lifecycle.changed", "lane", f.Lane, "error", err)
	}
}

// replayLifecycleFacts re-emits the current lifecycle projection of every
// lane bound to the session — the AD-9 reconnect resume (protocol §12). Runs
// from handleAttach after the attach response so the reattached frontend
// receives the current state of its domains, whether or not a transition
// happened while it was away. Lanes of the session with no state yet derive
// nothing and are skipped.
func (s *WSServer) replayLifecycleFacts(sid session.ID) {
	if s.lifecyclePub == nil {
		return
	}
	s.lifecycleMu.Lock()
	var lanes []lifecycle.LaneID
	for lane, cur := range s.lifecycleLanes {
		if cur == sid {
			lanes = append(lanes, lane)
		}
	}
	s.lifecycleMu.Unlock()
	for _, lane := range lanes {
		s.lifecyclePub.ReplayLane(lane)
	}
}

// ── lifecycle.submitAttempt (ADR-0024 decision 5) ────────────────────────

// submitAttemptParams is the payload of the "lifecycle.submitAttempt" RPC:
// the app-owned half of a command's execution, declared before the bytes
// that can cause the shell's own start event are written to the pty. The
// command text is the reference-intact record line — never the resolved
// send line (decision 5's privacy rule).
type submitAttemptParams struct {
	Domain  string `json:"domain"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	Host    string `json:"host"`
}

// lifecycleSubmitAttemptResult is the result of lifecycle.submitAttempt:
// the attempt as the kernel created it. The state is always "open" and the
// origin always "app" — the schema pins both. The domain's post-submit
// lifecycle (the move to running) is NOT echoed here: the publisher emits
// the running lifecycle.changed fact for the same mutation, and the
// renderer keys its state machine on that fact alone (AD-8: one owner per
// behaviour).
type lifecycleSubmitAttemptResult struct {
	ID        string    `json:"id"`
	Domain    string    `json:"domain"`
	State     string    `json:"state"`
	Command   string    `json:"command"`
	Cwd       string    `json:"cwd"`
	Host      string    `json:"host"`
	Origin    string    `json:"origin"`
	StartedAt time.Time `json:"startedAt"`
}

// handleLifecycleSubmitAttempt opens an app-originated attempt on a live
// domain at a ready prompt, synchronously, before the renderer writes the
// command bytes to the pty.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"lifecycle.submitAttempt","params":{"domain":"dom-1","command":"make","cwd":"/srv/app","host":"build.example.com"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"id":"att-…","domain":"dom-1","state":"open","command":"make","cwd":"/srv/app","host":"build.example.com","origin":"app","startedAt":"2026-08-08T12:00:00.123456Z"}}
//
// Ownership is enforced exactly like the git/files bindings: the domain's
// lane must be registered to a session THIS connection opened or reattached
// to. This is a mutating call, and it must not be addressable by a domain
// id guessed from another session.
func (s *WSServer) handleLifecycleSubmitAttempt(wconn *wsConn, state *connState, req jsonrpcRequest) {
	if s.lifecyclePub == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "lifecycle not available"))
		return
	}
	var params submitAttemptParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Domain == "" || params.Command == "" {
		// An empty command is a bare newline, not an execution: it never
		// opens an attempt (an unstarted attempt would hold the domain
		// and poison the next attach).
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: domain and command required"))
		return
	}
	dom, ok := s.lifecyclePub.Domain(lifecycle.DomainID(params.Domain))
	if !ok {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, lifecycleSubmitErrorCode(lifecycle.ErrUnknownDomain), lifecycle.ErrUnknownDomain.Error()))
		return
	}
	s.lifecycleMu.Lock()
	sid, registered := s.lifecycleLanes[dom.Lane]
	s.lifecycleMu.Unlock()
	if !registered || !state.has(sid) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, lifecycleSubmitErrorCode(lifecycle.ErrUnknownDomain), lifecycle.ErrUnknownDomain.Error()))
		return
	}
	att, err := s.lifecyclePub.SubmitAttempt(lifecycle.DomainID(params.Domain), params.Command, params.Cwd, params.Host)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, lifecycleSubmitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(lifecycleSubmitAttemptResult{
		ID:        string(att.ID),
		Domain:    string(att.Domain),
		State:     lifecyclepub.AttemptOpen,
		Command:   att.Command,
		Cwd:       att.Cwd,
		Host:      att.Host,
		Origin:    lifecyclepub.OriginApp,
		StartedAt: att.StartedAt,
	})))
}

// lifecycleSubmitErrorCode maps a lifecycle.SubmitAttempt refusal to a
// JSON-RPC code, mirroring the gitErrorCode convention: caller-side
// conditions (no live domain, no ready prompt, an oversize command) are
// invalid params; everything else is an internal error. The renderer treats
// every refusal the same way — fail-open, the command still reaches the
// pty and the session stays conventional — so the code is a diagnostic, not
// a branch.
func lifecycleSubmitErrorCode(err error) int {
	switch {
	case errors.Is(err, lifecycle.ErrUnknownDomain),
		errors.Is(err, lifecycle.ErrNoActiveDomain),
		errors.Is(err, lifecycle.ErrDomainNotLive),
		errors.Is(err, lifecycle.ErrDomainDesynchronized),
		errors.Is(err, lifecycle.ErrNotPromptReady),
		errors.Is(err, lifecycle.ErrAttemptOpen),
		errors.Is(err, lifecycle.ErrOversizeCommand):
		return -32602
	default:
		return -32603
	}
}
