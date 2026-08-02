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
	"fmt"
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

// epochFloor is the earliest plausible wall-clock timestamp: 2020-01-01
// 00:00:00 UTC in Unix epoch milliseconds. The store reads started_at and
// ended_at as epoch milliseconds and sweeps anything older than the
// retention limit — so a performance.now() reading (milliseconds since
// page load, the nocx-rtg0.16 defect) lands in January 1970 and the row is
// deleted microseconds after it is written. The boundary rejects the wrong
// clock at the wire, where the renderer can log the error, instead of
// letting a row silently vanish. Nil stays valid: the ledger only stamps
// what it observed.
const epochFloor int64 = 1_577_836_800_000 // 2020-01-01T00:00:00Z

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
	// Each timestamp is checked independently; a null field stays valid
	// (the ledger only stamps what it observed). The message names the
	// field so a wrong clock surfaces as a diagnosable error, never as a
	// row the retention sweep silently deletes.
	for _, f := range []struct {
		name string
		v    *int64
	}{
		{name: "startedAt", v: p.StartedAt},
		{name: "endedAt", v: p.EndedAt},
	} {
		if f.v != nil && *f.v < epochFloor {
			return fmt.Sprintf("%s must be epoch milliseconds on or after 2020-01-01 (got %d)", f.name, *f.v)
		}
	}
	return ""
}
