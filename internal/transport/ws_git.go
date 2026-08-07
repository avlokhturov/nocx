package transport

// The git.* control plane (spec §5.2): ten JSON-RPC methods backed by
// internal/git, plus the git.changed notification.
//
// Two guards, and they are the point of this file, exactly as in ws_files.go:
//
//  1. git.open is authorised by connState (D15) — a connection can open a
//     repository only for a session it has opened or reattached to. The
//     global session registry is never the answer: resolving a sessionId
//     through it would let any authenticated socket that learned another
//     connection's session id open that session's repository — and a
//     Commit button aimed at the wrong repository is a corrupted history,
//     not a nuisance (design §0).
//  2. Every later call re-checks, in exactly one place: Registry.Acquire
//     re-checks that the binding's session is in the REQUESTING
//     connection's connState, and takes the use-guard that keeps the
//     binding alive for the call. A handler cannot forget a check it
//     never performs.
//
// The change notification's addressing is the interesting half: the
// destination is resolved at emit time — the binding's session's current
// subscriber, never the connection that opened the binding, which is
// destroyed on a WebSocket drop. That is what survives an AD-9 reconnect:
// bindings are bounded by the session, not the WebSocket, so a reconnect
// changes nothing and the client keeps using its bindingId. The ONE
// exception is session teardown, where emit-time lookup finds nobody —
// both teardown paths remove the session's receiver before they clean up
// bindings — so the subscriber is captured BEFORE removal and handed to
// gitSessionClosed as a parameter (spec §5.2; this is the mechanism
// behind the open bug nocx-lzfb, and the fix its notification needs).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/shady2k/nocx/internal/git"
	"github.com/shady2k/nocx/internal/session"
)

// gitBinding is the transport's bookkeeping for one binding it issued.
// internal/git exposes neither a binding's session nor anything else the
// notification addressing needs, so the transport records what it itself
// handed to Register at git.open.
type gitBinding struct {
	sessionID session.ID
}

// ── wire shapes (contracts/git.*.schema.json) ──────────────────────────

type gitOpenParams struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd,omitempty"`
}

// gitOpenResult is the open outcome table (spec §5.1). state is the
// discriminator: every outcome is a RESULT state, never a JSON-RPC error,
// because each one is something the panel can render. The optional fields
// are present iff their state needs them; status rides the open result so
// an open is one round trip (spec §5.2).
type gitOpenResult struct {
	State      string         `json:"state"`
	BindingID  string         `json:"bindingId,omitempty"`  // present iff ok
	Toplevel   string         `json:"toplevel,omitempty"`   // present iff ok
	GitVersion string         `json:"gitVersion,omitempty"` // present when the probe ran
	EnvState   string         `json:"envState,omitempty"`   // "resolved" | "degraded" (D6)
	EnvReason  string         `json:"envReason,omitempty"`  // why degraded; present when degraded
	Status     *gitStatusWire `json:"status,omitempty"`     // first status; absent when the inline read failed
}

type gitBindingParams struct {
	BindingID string `json:"bindingId"`
}

type gitStageParams struct {
	BindingID string   `json:"bindingId"`
	Paths     []string `json:"paths"`
}

// gitStatusResult is the {status} shape git.status, git.stage, git.stageAll
// and git.unstageAll answer with (spec §5.2).
type gitStatusResult struct {
	Status gitStatusWire `json:"status"`
}

// gitUnstageResult is git.unstage's shape, which is a union where
// git.stage's is not: individual unstaging on an unborn branch fails with
// git's own error, and that failure must arrive as a state the panel can
// render rather than as a transport error (brief, worker A's item 2; D19
// only guarantees unstage-all there). Both branches carry the fresh status
// so the panel repaints from reality.
type gitUnstageResult struct {
	State  string        `json:"state"` // "ok" | "unborn"
	Status gitStatusWire `json:"status"`
}

type gitDiffParams struct {
	BindingID string `json:"bindingId"`
	Path      string `json:"path"`
	Side      string `json:"side"` // enum staged | unstaged | untracked
	MaxBytes  int64  `json:"maxBytes"`
}

type gitDiffResult struct {
	State     string `json:"state"` // enum ok | binary | tooLarge | empty | gone
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

type gitCommitParams struct {
	BindingID string `json:"bindingId"`
	Message   string `json:"message"`
	Amend     bool   `json:"amend"`
}

type gitCommitResult struct {
	State           string         `json:"state"` // "ok" | "failed"
	Head            string         `json:"head,omitempty"`
	Output          string         `json:"output,omitempty"`
	OutputTruncated bool           `json:"outputTruncated"`
	Status          *gitStatusWire `json:"status,omitempty"` // absent when failed or stale
	StatusStale     bool           `json:"statusStale,omitempty"`
}

type gitHeadMessageResult struct {
	State   string `json:"state"` // "ok" | "none"
	Message string `json:"message,omitempty"`
}

type gitCloseResult struct {
	Closed bool `json:"closed"`
}

// gitRemoteResult is git.remote's shape (brief, nocx-hc0m): the URL of the
// remote the current branch tracks, or the none state. none is the ordinary
// answer — detached HEAD, no upstream, a deleted remote, a local-path
// remote — and the panel draws no link (D14); it is never an error.
type gitRemoteResult struct {
	State string `json:"state"` // "ok" | "none"
	URL   string `json:"url,omitempty"`
}

// gitChangedNotification is the server-initiated git.changed frame —
// contracted like the methods because an unsolicited notification is
// exactly where an addressing defect hides (spec §5.3). Its schema covers
// the params object only, exactly as files.changed's does.
type gitChangedNotification struct {
	JSONRPC string           `json:"jsonrpc"`
	Method  string           `json:"method"`
	Params  gitChangedParams `json:"params"`
}

type gitChangedParams struct {
	BindingID string `json:"bindingId"`
	Reason    string `json:"reason"` // exactly one value: "sessionClosed"
}

// ── the status wire shape ────────────────────────────────────────────────

type gitEntryWire struct {
	Path string `json:"path"`
	X    string `json:"x"`
	Y    string `json:"y"`
	// Added and Deleted are the numstat line counts for this entry on its
	// side, omitted when no count exists — an untracked file, a binary
	// file, a conflicted entry, or a count read that was bounded out
	// (design D9, brief nocx-i4ki). Omitted is NOT zero: a real 0/0 answer
	// (a pure rename, an empty file) marshals as 0, so the wire uses
	// pointers, never omitempty on an int.
	Added   *int `json:"added,omitempty"`
	Deleted *int `json:"deleted,omitempty"`
}

type gitStatusWire struct {
	Branch       string         `json:"branch"`
	Detached     bool           `json:"detached"`
	Unborn       bool           `json:"unborn"`
	Head         string         `json:"head"`
	Upstream     string         `json:"upstream"`
	Ahead        int            `json:"ahead"`
	Behind       int            `json:"behind"`
	Staged       []gitEntryWire `json:"staged"`
	Unstaged     []gitEntryWire `json:"unstaged"`
	Conflicted   []gitEntryWire `json:"conflicted"`
	Total        int            `json:"total"`
	Completeness string         `json:"completeness"`
}

type gitLogEntryWire struct {
	Hash       string   `json:"hash"`
	ShortHash  string   `json:"shortHash"`
	Subject    string   `json:"subject"`
	AuthorName string   `json:"authorName"`
	AuthoredAt string   `json:"authoredAt"`
	Refs       []string `json:"refs"`
}

type gitLogWire struct {
	Entries      []gitLogEntryWire `json:"entries"`
	Total        int               `json:"total"`
	Completeness string            `json:"completeness"`
}

type gitLogResult struct {
	Log gitLogWire `json:"log"`
}

// wireGitLog maps the domain Log onto the contracted wire shape. Entries
// start non-nil in the domain; a regression there is exactly what the
// contract test is designed to catch.
func wireGitLog(lg git.Log) gitLogWire {
	entries := make([]gitLogEntryWire, 0, len(lg.Entries))
	for _, e := range lg.Entries {
		entries = append(entries, gitLogEntryWire{
			Hash:       e.Hash,
			ShortHash:  e.ShortHash,
			Subject:    e.Subject,
			AuthorName: e.AuthorName,
			AuthoredAt: e.AuthoredAt.Format(time.RFC3339),
			Refs:       e.Refs,
		})
	}
	return gitLogWire{Entries: entries, Total: lg.Total, Completeness: string(lg.Completeness)}
}

// wireGitStatus maps the domain Status onto the contracted wire shape. The
// mapping is deliberately pure: the domain guarantees the lists are never
// nil (git.go), and a regression there is exactly what the contract test
// is designed to catch.
func wireGitStatus(st git.Status) gitStatusWire {
	entries := func(es []git.Entry) []gitEntryWire {
		out := make([]gitEntryWire, 0, len(es))
		for _, e := range es {
			out = append(out, gitEntryWire{
				Path:    e.Path,
				X:       string([]byte{e.X}),
				Y:       string([]byte{e.Y}),
				Added:   e.Added,
				Deleted: e.Deleted,
			})
		}
		return out
	}
	return gitStatusWire{
		Branch:       st.Branch,
		Detached:     st.Detached,
		Unborn:       st.Unborn,
		Head:         st.Head,
		Upstream:     st.Upstream,
		Ahead:        st.Ahead,
		Behind:       st.Behind,
		Staged:       entries(st.Staged),
		Unstaged:     entries(st.Unstaged),
		Conflicted:   entries(st.Conflicted),
		Total:        st.Total,
		Completeness: string(st.Completeness),
	}
}

// ── dispatcher ────────────────────────────────────────────────────────────

// handleGitMethod dispatches the git.* control plane. Handlers run on the
// read loop like the files.* handlers: the git operations are bounded by
// the internal/git work ceilings, and a synchronous response keeps the
// wire order the client's request stream expects.
func (s *WSServer) handleGitMethod(wconn *wsConn, state *connState, req jsonrpcRequest) {
	if s.git == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "git not available"))
		return
	}
	switch req.Method {
	case "git.open":
		s.handleGitOpen(wconn, state, req)
	case "git.status":
		s.handleGitStatus(wconn, state, req)
	case "git.diff":
		s.handleGitDiff(wconn, state, req)
	case "git.stage":
		s.handleGitStage(wconn, state, req)
	case "git.unstage":
		s.handleGitUnstage(wconn, state, req)
	case "git.stageAll":
		s.handleGitStageAll(wconn, state, req)
	case "git.unstageAll":
		s.handleGitUnstageAll(wconn, state, req)
	case "git.commit":
		s.handleGitCommit(wconn, state, req)
	case "git.remote":
		s.handleGitRemote(wconn, state, req)
	case "git.headMessage":
		s.handleGitHeadMessage(wconn, state, req)
	case "git.log":
		s.handleGitLog(wconn, state, req)
	case "git.close":
		s.handleGitClose(wconn, state, req)
	}
}

// handleGitOpen resolves a session the requesting connection owns and
// registers a repository for it, minting the binding every later git.*
// call carries. sessionId appears exactly once on the wire — here (D1) —
// and the authorisation is connState's, not the global registry's (D15).
//
// noCwd and remoteUnsupported are decided HERE, from the session's origin,
// before the factory is invoked; the factory itself answers ok,
// notARepository, gitUnavailable or gitTooOld (spec §5.1). The remote
// refusal is a RESULT state, not an error: on an SSH tab the panel shows
// one honest state and offers nothing (D3, D14).
func (s *WSServer) handleGitOpen(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitOpenParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.SessionID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: sessionId required"))
		return
	}
	sid := session.ID(params.SessionID)
	if !state.has(sid) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: unknown sessionId"))
		return
	}
	sess, err := s.registry.Get(sid)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: unknown sessionId"))
		return
	}
	if sess.Kind() != session.KindLocal {
		// D3: the remote case waits for the relay (nocx-if6 phase B).
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitOpenResult{State: string(git.OpenRemoteUnsupported)})))
		return
	}
	if params.Cwd == "" {
		// No verified OSC 7 cwd to resolve from (D2).
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitOpenResult{State: string(git.OpenNoCwd)})))
		return
	}
	if s.gitFactory == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "git.open not available (no repo factory wired)"))
		return
	}
	// The ownership-transfer rule (spec §5.1): Open can return a live Repo
	// and Register can fail, and between those two moments the Repo belongs
	// to nobody. Go cannot encode "repo is non-nil iff ok" in a three-value
	// return, so both directions are checked here:
	//
	//  1. a nil Repo on an ok outcome is an internal error — nothing to
	//     close, nothing registered;
	//  2. a live Repo on a refusing outcome is closed before the refusal
	//     is returned — it must not leak;
	//  3. a Register failure closes the Repo (still ours) and surfaces
	//     both errors, returning no binding;
	//  4. after Register succeeds the registry owns it.
	repo, outcome, err := s.gitFactory.Open(context.Background(), params.Cwd)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	if outcome.State != git.OpenOK {
		if repo != nil {
			// Refusing outcome with a live repo: the repo is still ours,
			// and it must not leak.
			if cerr := repo.Close(); cerr != nil {
				s.log.Warn("git.open: close repo after refusing outcome", "error", cerr)
			}
		}
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitOpenResult{
			State:      string(outcome.State),
			GitVersion: outcome.GitVersion,
		})))
		return
	}
	if repo == nil {
		// The other direction of the same lie: ok with no repository.
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "git.open: factory answered ok without a repository"))
		return
	}
	bid, err := s.git.Register(repo, sid)
	if err != nil {
		if cerr := repo.Close(); cerr != nil {
			s.log.Warn("git.open: close repo after register failure", "error", cerr)
		}
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, fmt.Sprintf("git.open: %v", err)))
		return
	}
	s.gitMu.Lock()
	s.gitBindings[bid] = &gitBinding{sessionID: sid}
	set := s.gitBySession[sid]
	if set == nil {
		set = make(map[string]struct{})
		s.gitBySession[sid] = set
	}
	set[bid] = struct{}{}
	s.gitMu.Unlock()

	// The first status rides the open result (spec §5.2) — otherwise every
	// open is two round trips and a guaranteed frame of empty lists. A
	// failed inline read is not an open failure: the binding is live and
	// the panel's first poll retries, so the status is omitted rather than
	// failing the open.
	var st *gitStatusWire
	if h, release, aerr := s.git.Acquire(bid, state); aerr == nil {
		status, serr := h.Status(context.Background())
		release()
		if serr == nil {
			wire := wireGitStatus(status)
			st = &wire
		} else {
			s.log.Debug("git.open: inline status failed", "binding_id", bid, "error", serr)
		}
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitOpenResult{
		State:      string(git.OpenOK),
		BindingID:  bid,
		Toplevel:   outcome.Toplevel,
		GitVersion: outcome.GitVersion,
		EnvState:   string(outcome.EnvState),
		EnvReason:  outcome.EnvReason,
		Status:     st,
	})))
}

// handleGitStatus answers "what changed in this repository" — the poll the
// panel runs while visible (spec §5.4, D13). A status on an unknown or
// already-closed binding answers the unknownBinding error, never a panic:
// Acquire either finds the binding and takes the use-guard, or returns the
// domain error, and the handler maps it onto the wire.
func (s *WSServer) handleGitStatus(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	status, err := h.Status(context.Background())
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitStatusResult{Status: wireGitStatus(status)})))
}

// handleGitDiff diffs one file on one side. side is a closed enum — the
// three diff forms (spec §5.1 "diff.go") — and the outcome is the four
// RESULT states, never an error: a row can be clicked in the same second
// an agent reverts the file (empty, gone), a binary file has nothing to
// render (binary), and the byte bound is a state, not a failure (tooLarge).
func (s *WSServer) handleGitDiff(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitDiffParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" || params.Path == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId and path required"))
		return
	}
	if params.Side != string(git.SideStaged) && params.Side != string(git.SideUnstaged) && params.Side != string(git.SideUntracked) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: side must be staged, unstaged or untracked"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	d, err := h.Diff(context.Background(), params.Path, git.Side(params.Side), params.MaxBytes)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitDiffResult{
		State:     string(d.State),
		Text:      d.Text,
		Truncated: d.Truncated,
	})))
}

// handleGitStage stages exactly the given paths (D8: paths ride stdin as a
// pathspec stream, never argv) and returns the fresh status (D12). paths[]
// never means "all": an empty array is a no-op that still returns the
// current status, and "all" is git.stageAll (D19).
func (s *WSServer) handleGitStage(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitStageParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	var status git.Status
	if len(params.Paths) == 0 {
		status, err = h.Status(context.Background())
	} else {
		status, err = h.Stage(context.Background(), params.Paths)
	}
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitStatusResult{Status: wireGitStatus(status)})))
}

// handleGitUnstage unstages exactly the given paths. It is the one
// mutation whose failure is a RESULT state rather than a transport error:
// individual unstaging on an unborn branch fails with git's own error (git
// reset with pathspecs resolves HEAD, which an unborn branch lacks — D19
// only guarantees unstage-all there). The discriminator is the branch's
// unbornness RE-READ from the repository, never parsed from git's prose
// (D11): when the unstage fails and a fresh status says the branch is
// unborn, the answer is state "unborn" with that fresh status, and the
// panel repaints and stops offering the control.
func (s *WSServer) handleGitUnstage(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitStageParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	var status git.Status
	if len(params.Paths) == 0 {
		status, err = h.Status(context.Background())
	} else {
		status, err = h.Unstage(context.Background(), params.Paths)
	}
	if err != nil {
		st, serr := h.Status(context.Background())
		if serr == nil && st.Unborn {
			_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitUnstageResult{
				State:  "unborn",
				Status: wireGitStatus(st),
			})))
			return
		}
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitUnstageResult{
		State:  "ok",
		Status: wireGitStatus(status),
	})))
}

// handleGitStageAll stages everything (git add -A, D19) and returns the
// fresh status. While any entry is conflicted it is refused — the
// ErrConflicted domain error, which the panel renders as a visible refusal
// with the reason (a button that resolved conflicts by accident is the
// measured hazard D19 exists to prevent).
func (s *WSServer) handleGitStageAll(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	status, err := h.StageAll(context.Background())
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitStatusResult{Status: wireGitStatus(status)})))
}

// handleGitUnstageAll unstages everything — bare git reset, no HEAD, no
// pathspec — which is what makes it work on an unborn branch (D19,
// measured; no special unborn path is needed or built). It is refused
// while any entry is conflicted, like stage-all.
func (s *WSServer) handleGitUnstageAll(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	status, err := h.UnstageAll(context.Background())
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitStatusResult{Status: wireGitStatus(status)})))
}

// handleGitCommit commits with the message on stdin (-F -, D8) and returns
// the outcome: ok with the new head and the fresh status, or failed with
// git's own account (D11 — we do not classify why). Hooks always run;
// there is no --no-verify.
func (s *WSServer) handleGitCommit(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitCommitParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	outcome, err := h.Commit(context.Background(), params.Message, params.Amend)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	res := gitCommitResult{
		State:           string(outcome.State),
		Head:            outcome.Head,
		Output:          outcome.Output,
		OutputTruncated: outcome.OutputTruncated,
		StatusStale:     outcome.StatusStale,
	}
	if outcome.State == git.CommitOK && !outcome.StatusStale {
		wire := wireGitStatus(outcome.Status)
		res.Status = &wire
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(res)))
}

// handleGitHeadMessage is the Amend prefill (spec §5.2): the full HEAD
// message, fetched once when the box is ticked. An unborn branch has no
// HEAD message to amend — that is the "none" state, not an error (local
// maps it); an invocation that cannot be made is the error.
func (s *WSServer) handleGitHeadMessage(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	hm, err := h.HeadMessage(context.Background())
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitHeadMessageResult{
		State:   string(hm.State),
		Message: hm.Message,
	})))
}

// handleGitLog answers "what has happened on this branch": the first
// MaxLogEntries commits of HEAD, newest first (brief, git.log). History
// does not change under the user the way the working tree does, so the
// panel reads it when it opens, on manual refresh and after a commit —
// never on the poll (D13). The bound is policy: the implementation asks
// git for one more than the cap, so the answer can say capped rather than
// implying the branch has exactly N commits (D9).
func (s *WSServer) handleGitLog(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	lg, err := h.Log(context.Background(), git.MaxLogEntries)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitLogResult{Log: wireGitLog(lg)})))
}

// handleGitRemote answers "what URL does the branch I am on track"
// (brief, nocx-hc0m): the raw remote URL, derived by Repo.RemoteURL from
// HEAD and git's own upstream atom — never parsed from a client-supplied
// branch. The none state is the ordinary answer — detached HEAD, no
// upstream, a deleted remote, a local-path remote — and the panel draws no
// link for it (D14); only an invocation that could not be made is an error.
// The URL conversion to a host's web page is the renderer's, in one module
// with its own tests: the wire carries what git said, not a URL the backend
// invented for a host it may not know.
func (s *WSServer) handleGitRemote(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	h, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	defer release()
	url, err := h.RemoteURL(context.Background())
	if err != nil {
		var noRemote *git.ErrNoRemote
		if errors.As(err, &noRemote) {
			_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitRemoteResult{State: "none"})))
			return
		}
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitRemoteResult{State: "ok", URL: url})))
}

// handleGitClose closes the binding: its repository released, the use-guard
// drained. Ownership is re-checked like every call (D15) — a binding is
// closed by the connection that owns its session, not by whoever knows its
// id.
func (s *WSServer) handleGitClose(wconn *wsConn, state *connState, req jsonrpcRequest) {
	var params gitBindingParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.BindingID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: bindingId required"))
		return
	}
	_, release, err := s.git.Acquire(params.BindingID, state)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	release()

	s.gitMu.Lock()
	b := s.gitBindings[params.BindingID]
	delete(s.gitBindings, params.BindingID)
	if b != nil {
		if set := s.gitBySession[b.sessionID]; set != nil {
			delete(set, params.BindingID)
			if len(set) == 0 {
				delete(s.gitBySession, b.sessionID)
			}
		}
	}
	s.gitMu.Unlock()
	if err := s.git.Close(params.BindingID); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, gitErrorCode(err), err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(gitCloseResult{Closed: true})))
}

// ── notification delivery ─────────────────────────────────────────────────

func gitChangedMessage(bindingID, reason string) gitChangedNotification {
	return gitChangedNotification{
		JSONRPC: "2.0",
		Method:  "git.changed",
		Params:  gitChangedParams{BindingID: bindingID, Reason: reason},
	}
}

// ── lifecycle ─────────────────────────────────────────────────────────────

// gitSessionClosed tears down every git binding of a session and tells that
// session's subscriber the bindings are gone — closing the terminal closes
// its bindings (spec §5.5): a binding is bounded by its session, never by a
// WebSocket.
//
// wconn is the subscriber CAPTURED before the receiver was removed — the
// one thing that makes this notification deliverable at all (spec §5.2).
// Both teardown paths remove the session's receiver before they clean up
// bindings, so an emit-time lookup at this moment finds nobody; that is
// the mechanism behind the open bug nocx-lzfb, and the capture is the fix
// its notification needs. Emit-time resolution remains the rule for a live
// session (that is what survives an AD-9 reconnect); the captured
// subscriber is the rule for the one moment when the session is being torn
// down and there is nothing left to look up. wconn is nil when no
// subscriber was attached (the app-shutdown path), and there is then
// nobody to tell.
//
// The interval, both ends: the registry removes the bindings BEFORE the
// notification is written, so no call can acquire a binding after a client
// has been told it is gone; Close then drains whatever was already in
// flight (D18), and an in-flight call that loses the race answers
// unknownBinding, which is the correct answer.
//
// The write is asynchronous, deliberately: writeJSON has no deadline, and
// a subscriber that stopped reading while its socket stays open would hang
// whatever wrote it — which on the explicit-close path is the READ LOOP.
// The blocked-write goroutine is the same best-effort hazard ringToConn
// already has; it exits when the subscriber's socket dies.
func (s *WSServer) gitSessionClosed(sid session.ID, wconn *wsConn) {
	s.gitMu.Lock()
	ids := make([]string, 0, len(s.gitBySession[sid]))
	for id := range s.gitBySession[sid] {
		ids = append(ids, id)
	}
	delete(s.gitBySession, sid)
	for _, id := range ids {
		delete(s.gitBindings, id)
	}
	s.gitMu.Unlock()
	if s.git != nil {
		s.git.CloseSession(sid)
	}
	if wconn == nil || len(ids) == 0 {
		return
	}
	go func() {
		for _, id := range ids {
			if err := wconn.writeJSON(gitChangedMessage(id, "sessionClosed")); err != nil {
				s.log.Debug("write git.changed", "binding_id", id, "error", err)
				return
			}
		}
	}()
}

// ── wire mapping helpers ──────────────────────────────────────────────────

// gitErrorCode maps git domain errors to JSON-RPC codes: the
// request-shaped refusals — a binding the caller cannot use, an operation
// the repository state refuses — are invalid-params; everything else
// (an invocation that could not be made or completed) is internal. The
// message always carries the domain error's own words, which is what the
// panel surfaces.
func gitErrorCode(err error) int {
	switch err.(type) {
	case *git.ErrUnknownBinding, *git.ErrNotOwned, *git.ErrHandleReleased,
		*git.ErrNothingToCommit, *git.ErrAmendUnborn, *git.ErrConflicted:
		return -32602
	default:
		return -32603
	}
}
