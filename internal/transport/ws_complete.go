package transport

// shell.complete — remote shell completion (nocx-w7h.15).
// The result shape is declared once in contracts/shell.complete.schema.json.

import (
	"context"
	"encoding/json"

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

// handleShellComplete serves the shell.complete method.
//
// Routes by session kind: a KindLocal session delegates to the local
// completer (the backend's own filesystem); a KindRemote session
// delegates to the SSH completer, which runs a second shell on the
// remote host through the DiscoveryConn lane.
func (s *WSServer) handleShellComplete(ctx context.Context, wconn *wsConn, req jsonrpcRequest) {
	params, errMsg := parseShellCompleteParams(req)
	if errMsg != "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: "+errMsg))
		return
	}

	sess, err := s.registry.Get(session.ID(params.SessionID))
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Session not found: "+params.SessionID))
		return
	}

	var comp completion.Completer
	switch sess.Kind() {
	case session.KindLocal:
		comp = s.localCompleter
	case session.KindRemote:
		comp = s.sshCompleter
	}
	if comp == nil {
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellCompleteResponse{
			Entries: []shellCompleteEntry{},
			Reason:  "completion unavailable for this session kind",
		})))
		return
	}

	limit := params.limit()
	compReq := completion.Request{
		Host:  sess.Host(),
		Cwd:   params.Cwd,
		Line:  params.Line,
		Pos:   params.Pos,
		Limit: limit,
	}

	compResp, err := comp.Complete(ctx, compReq)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellCompleteResponse{
			Entries: []shellCompleteEntry{},
			Reason:  "completion unavailable",
		})))
		return
	}

	resp := toWireResponse(compResp)
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
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
