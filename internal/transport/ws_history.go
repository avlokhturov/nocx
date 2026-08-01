package transport

// history.query — the recall ladder (design §10.6, nocx-ms7v.1). The result
// shape is declared once in contracts/history.query.schema.json and belongs
// to neither side; this file serves it from the ContentDB seam.

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/shady2k/nocx/internal/content"
)

// historyQueryParams is the request the recall overlay sends. There is
// deliberately no params schema (contracts/README.md): the handler is the
// check, and rejects what it cannot parse.
//
//	scope  — required; directory | host | everywhere
//	cwd    — required when scope=directory; the exact directory rung
//	host   — required when scope=host; "" is the local machine
//	limit  — optional; <1 → 50, >200 → 200
//	before — optional; the opaque row id the previous page ended at
type historyQueryParams struct {
	Scope  string  `json:"scope"`
	Cwd    *string `json:"cwd"`
	Host   *string `json:"host"`
	Limit  *int    `json:"limit"`
	Before *string `json:"before"`
}

// historyQueryEntry is one row of the history.query result, matching the
// schema exactly. ID is the opaque row handle: the string form of the
// store's row id, stable for the life of the row and usable as `before`.
type historyQueryEntry struct {
	ID       string                `json:"id"`
	Command  string                `json:"command"`
	Cwd      string                `json:"cwd"`
	Host     string                `json:"host"`
	Status   content.CommandStatus `json:"status"`
	ExitCode *int                  `json:"exitCode,omitempty"`
	EndedAt  *int64                `json:"endedAt"`
}

// historyQueryResponse is the result of history.query. Entries is never nil:
// no matches is [] (the schema says so, and a null would throw the overlay's
// first .map — the nocx-25k9.14 defect class).
type historyQueryResponse struct {
	Entries   []historyQueryEntry `json:"entries"`
	Scope     string              `json:"scope"`
	Exhausted bool                `json:"exhausted"`
	Source    string              `json:"source"`
}

// defaultHistoryPageLimit is the page size when the caller sends none.
const defaultHistoryPageLimit = 50

// maxHistoryPageLimit caps a page so a runaway overlay cannot ask for the
// whole history in one request.
const maxHistoryPageLimit = 200

// handleHistoryQuery serves the history.query method.
//
// Three behaviours carry the decisions the schema names:
//
//   - scope is echoed back, and the store is asked for exactly the rung the
//     caller asked for — the server never silently widens.
//   - source is "session" when there is nothing to answer from (no store
//     wired, or a store that has never recorded a row) and "store" when the
//     store answered — an empty answer and an unanswerable question must
//     not look alike.
//   - a store that errors answers with a JSON-RPC error, never a session
//     fallback: broken and unavailable must not collapse into each other.
func (s *WSServer) handleHistoryQuery(ctx context.Context, wconn *wsConn, req jsonrpcRequest) {
	scope, cwd, host, limit, before, errMsg := parseHistoryQueryParams(req)
	if errMsg != "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: "+errMsg))
		return
	}

	// The default answer is the honest one when there is nothing to answer
	// from: session, empty, exhausted, scope echoed. The overlay labels it
	// "this session only" rather than presenting it as all history.
	resp := historyQueryResponse{
		Entries:   []historyQueryEntry{},
		Scope:     string(scope),
		Exhausted: true,
		Source:    "session",
	}

	if s.contentDB == nil {
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
		return
	}

	page, err := s.contentDB.CommandHistory().Query(ctx, scope, cwd, host, limit, before)
	if err != nil {
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "history.query: ", err))
		return
	}

	if page.HasRows {
		resp.Source = "store"
	}
	resp.Exhausted = page.Exhausted
	for _, r := range page.Entries {
		resp.Entries = append(resp.Entries, historyQueryEntry{
			ID:       strconv.FormatInt(r.ID, 10),
			Command:  r.Command,
			Cwd:      r.Cwd,
			Host:     r.Host,
			Status:   r.Status,
			ExitCode: r.ExitCode,
			EndedAt:  r.EndedAt,
		})
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
}

// parseHistoryQueryParams validates the request against the handler contract
// above. The returned message is empty when the params are usable.
func parseHistoryQueryParams(req jsonrpcRequest) (content.Scope, string, string, int, *int64, string) {
	var p historyQueryParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return "", "", "", 0, nil, "params must be an object"
	}

	var scope content.Scope
	switch p.Scope {
	case "directory":
		scope = content.ScopeDirectory
	case "host":
		scope = content.ScopeHost
	case "everywhere":
		scope = content.ScopeEverywhere
	default:
		return "", "", "", 0, nil, "scope must be one of directory, host, everywhere"
	}

	var cwd, host string
	if p.Cwd != nil {
		cwd = *p.Cwd
	}
	if p.Host != nil {
		host = *p.Host
	}
	// Presence, not value: "" is a legitimate directory rung (a command whose
	// cwd was never known) and the local-machine host rung.
	if scope == content.ScopeDirectory && p.Cwd == nil {
		return "", "", "", 0, nil, "cwd is required for scope=directory"
	}
	if scope == content.ScopeHost && p.Host == nil {
		return "", "", "", 0, nil, "host is required for scope=host"
	}

	limit := defaultHistoryPageLimit
	if p.Limit != nil {
		limit = *p.Limit
		if limit < 1 {
			limit = defaultHistoryPageLimit
		} else if limit > maxHistoryPageLimit {
			limit = maxHistoryPageLimit
		}
	}

	var before *int64
	if p.Before != nil {
		n, err := strconv.ParseInt(*p.Before, 10, 64)
		if err != nil {
			return "", "", "", 0, nil, "before must be the opaque row id of the previous page"
		}
		before = &n
	}
	return scope, cwd, host, limit, before, ""
}
