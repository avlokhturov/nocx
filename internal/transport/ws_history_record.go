package transport

// history.record — the write half of the history family (nocx-rtg0.13), the
// method history.query already belongs to. The frontend derives the facts of
// a completed command from the byte stream it already owns (AD-1 as amended,
// nocx-m64b) and sends them here; the store is the single writer of rows.
//
// The result shape is declared once in contracts/history.record.schema.json.
// There is deliberately no params schema (contracts/README.md): the handler
// is the check, and rejects what it cannot parse.

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/shady2k/nocx/internal/content"
)

// historyRecordParams is the request the frontend sends when a command
// completes. It mirrors the ledger's CommandRecord minus the fields that
// never cross (the session-local id, the live marker-line accessor, the
// disposed flag) and minus the output, which is never retained (ADR-0008).
type historyRecordParams struct {
	Command   string `json:"command"`
	Cwd       string `json:"cwd"`
	Host      string `json:"host"`
	Status    string `json:"status"`
	ExitCode  *int   `json:"exitCode"`
	StartedAt *int64 `json:"startedAt"`
	EndedAt   *int64 `json:"endedAt"`
	Trusted   bool   `json:"trusted"`
}

// historyRecordResponse is the result of history.record: an ack. It claims
// only that the request was accepted and handed to the store — whether a row
// appears is decided by the live History policy (history.enabled) and is
// answered by history.query, never by this ack.
type historyRecordResponse struct{}

// handleHistoryRecord accepts a completed command's facts and persists them
// through the ContentDB seam. The store's Add enforces the live History
// policy: history.enabled off means the call succeeds and no row appears —
// a command runs and no row is recorded, never an error the renderer has to
// swallow. Output is not part of the record at all (ADR-0008); the
// outputEnabled policy governs a capture path that does not exist yet.
func (s *WSServer) handleHistoryRecord(ctx context.Context, wconn *wsConn, req jsonrpcRequest) {
	var p historyRecordParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: params must be an object"))
		return
	}
	if msg := validateHistoryRecord(p); msg != "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: "+msg))
		return
	}

	if s.contentDB == nil {
		// No store wired (test-only state): the request is accepted and
		// recorded nowhere; history.query answers source=session in the
		// same state, which is the honest label for "nothing to answer
		// from".
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(historyRecordResponse{})))
		return
	}

	rec := content.CommandRecord{
		Command:   p.Command,
		Cwd:       p.Cwd,
		Host:      p.Host,
		Status:    content.CommandStatus(p.Status),
		ExitCode:  p.ExitCode,
		StartedAt: p.StartedAt,
		EndedAt:   p.EndedAt,
		Trusted:   p.Trusted,
	}
	if err := s.contentDB.CommandHistory().Add(ctx, rec); err != nil {
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "history.record: ", err))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(historyRecordResponse{})))
}

// validateHistoryRecord checks the request against the handler contract. The
// returned message is empty when the params are usable.
func validateHistoryRecord(p historyRecordParams) string {
	if p.Command == "" || strings.TrimSpace(p.Command) == "" {
		return "command is required and must not be empty"
	}
	switch content.CommandStatus(p.Status) {
	case content.StatusRunning, content.StatusSuccess, content.StatusFailure,
		content.StatusInterrupted, content.StatusUnknown:
	default:
		return "status must be one of running, success, failure, interrupted, unknown"
	}
	return ""
}
