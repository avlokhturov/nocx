package transport

// shell.complete — remote shell completion (nocx-w7h.15).
// The result shape is declared once in contracts/shell.complete.schema.json.

import (
	"context"
	"encoding/json"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/completion"
	"github.com/shady2k/nocx/internal/session"
)

// shellCompleteParams is the request for shell.complete.
//
//	sessionId — required; the session to complete for
//	cwd       — required; the session's cwd, from OSC 7
//	line      — required; the full line being typed
//	pos       — required; the caret offset into line
//	limit     — optional; <1 → 50, >200 → 200
type shellCompleteParams struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Line      string `json:"line"`
	Pos       int    `json:"pos"`
	Limit     *int   `json:"limit"`
}

// shellCompleteEntry is one row of the shell.complete result, matching
// the schema exactly.
type shellCompleteEntry struct {
	Name   string `json:"name"`
	Path   string `json:"path,omitempty"`
	Source string `json:"source"`
	IsDir  bool   `json:"isDir,omitempty"`
}

// shellCompleteResponse is the result of shell.complete. Entries is never
// nil: no matches is [].
type shellCompleteResponse struct {
	Entries   []shellCompleteEntry `json:"entries"`
	Truncated bool                 `json:"truncated"`
	Reason    string               `json:"reason,omitempty"`
}

// handleComplete serves the shell.complete method.
//
// Routes by session kind: a KindLocal session delegates to the local
// completer (the backend's own filesystem); a KindRemote session
// delegates to the SSH completer, which runs a second shell on the
// remote host through the DiscoveryConn lane. The session gate is the
// SessionOperation's; the completion logic itself stays here.
func (h sessionShellHandlers) handleComplete(ctx context.Context, req jsonrpcRequest) {
	params, errMsg := parseShellCompleteParams(req)
	if errMsg != "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: " + errMsg})
		return
	}

	op, err := h.ops.ForSession(session.ID(params.SessionID))
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Session not found: " + params.SessionID})
		return
	}
	err = op.Run(ctx, func(ctx context.Context, svc capability.SessionService) error {
		sess, getErr := svc.Get(session.ID(params.SessionID))
		if getErr != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Session not found: " + params.SessionID})
			return nil
		}

		var comp completion.Completer
		switch sess.Kind() {
		case session.KindLocal:
			comp = h.local
		case session.KindRemote:
			comp = h.remote
		}
		if comp == nil {
			_ = h.r.TryResult(req.ID, mustMarshal(shellCompleteResponse{
				Entries: []shellCompleteEntry{},
				Reason:  "completion unavailable for this session kind",
			}))
			return nil
		}

		limit := params.limit()
		compReq := completion.Request{
			Host:  sess.Host(),
			Cwd:   params.Cwd,
			Line:  params.Line,
			Pos:   params.Pos,
			Limit: limit,
		}

		compResp, compErr := comp.Complete(ctx, compReq)
		if compErr != nil {
			_ = h.r.TryResult(req.ID, mustMarshal(shellCompleteResponse{
				Entries: []shellCompleteEntry{},
				Reason:  "completion unavailable",
			}))
			return nil
		}

		resp := toWireResponse(compResp)
		_ = h.r.TryResult(req.ID, mustMarshal(resp))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// parseShellCompleteParams validates the request against the handler contract.
func parseShellCompleteParams(req jsonrpcRequest) (*shellCompleteParams, string) {
	var p shellCompleteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, "params must be an object"
	}
	if p.SessionID == "" {
		return nil, "sessionId is required"
	}
	if p.Cwd == "" {
		return nil, "cwd is required"
	}
	if p.Line == "" {
		return nil, "line is required"
	}
	return &p, ""
}

func (p shellCompleteParams) limit() int {
	if p.Limit == nil {
		return 50
	}
	l := *p.Limit
	if l < 1 {
		return 50
	}
	if l > 200 {
		return 200
	}
	return l
}

// toWireResponse converts the completion package's response to the wire
// shape declared in contracts/shell.complete.schema.json.
func toWireResponse(resp *completion.Response) shellCompleteResponse {
	entries := make([]shellCompleteEntry, len(resp.Candidates))
	for i, c := range resp.Candidates {
		entries[i] = shellCompleteEntry{
			Name:   c.Name,
			Path:   c.Path,
			Source: c.Source,
			IsDir:  c.IsDir,
		}
	}
	return shellCompleteResponse{
		Entries:   entries,
		Truncated: resp.Truncated,
		Reason:    resp.Reason,
	}
}
