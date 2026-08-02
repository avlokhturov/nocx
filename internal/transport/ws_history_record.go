package transport

// history.record — the write half of the history family (nocx-rtg0.13), the
// method history.query already belongs to. The frontend derives the facts of
// a completed command from the byte stream it already owns (AD-1 as amended,
// nocx-m64b) and sends them here; the store is the single writer of rows.
//
// This seam is also where a submitted credential becomes a PENDING CAPTURE
// (the secrets redesign): the backend receives the command here, holds the
// plaintext in the capture registry, and hands the renderer only an opaque
// capture id plus non-secret display metadata. Masking never trusts a
// finding it showed the renderer: the durable row is decided by the store's
// own pass over the exact submitted command, never by anything the renderer
// echoed back.
//
// The result shape is declared once in contracts/history.record.schema.json.
// There is deliberately no params schema (contracts/README.md): the handler
// is the check, and rejects what it cannot parse.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/secrets"
)

// historyRecordParams is the request the frontend sends when a command
// completes. It mirrors the ledger's CommandRecord minus the fields that
// never cross (the session-local id, the live marker-line accessor, the
// disposed flag) and minus the output, which is never retained (ADR-0008).
// The capture scope's tab and generation are the backend's own facts (the
// connection identity and its submission counter) — the renderer's
// session-local ids never cross the wire.
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

// redactionWire is one redaction segment on the wire: kind and span in
// UTF-16 code units into the command the row carries, plus the head/tail
// the mask shows. Never the credential's value.
type redactionWire struct {
	Kind   string `json:"kind"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

// captureWire is the non-secret display metadata for one pending capture:
// the opaque id, the row it first attached to, this entry's redaction
// segment, and the backend-derived suggested vault name.
type captureWire struct {
	ID            string        `json:"id"`
	EntryID       string        `json:"entryId"`
	Redaction     redactionWire `json:"redaction"`
	SuggestedName string        `json:"suggestedName"`
}

// historyRecordResponse is the result of history.record: an ack that
// reports what was masked and where the row landed. EntryID is the stable
// row id ("" when the live History policy wrote no row); Redactions are the
// segments the row keeps, in UTF-16 units into the recorded command; never
// null (no redaction is []). Captures is the offer list — one entry per
// detected credential, empty when there is nothing to offer. The ack never
// carries secret material.
type historyRecordResponse struct {
	MaskedCount int             `json:"maskedCount"`
	MaskedKinds []string        `json:"maskedKinds"`
	EntryID     string          `json:"entryId"`
	Redactions  []redactionWire `json:"redactions"`
	Captures    []captureWire   `json:"captures"`
}

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
//
// Detection fails closed here: a masking failure refuses the write (never
// the raw command), destroys the tab's pending captures, and errors the
// ack. The command itself already ran — refusing the record fails nothing
// the user did.
func (s *WSServer) handleHistoryRecord(ctx context.Context, wconn *wsConn, state *connState, req jsonrpcRequest) {
	var p historyRecordParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: params must be an object"))
		return
	}
	if msg := validateHistoryRecord(p); msg != "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: "+msg))
		return
	}

	// Mask at the wire, in exactly one place. ws_history_record is the
	// single writer of durable rows, so it is the single place masking can
	// be forgotten: the durable command is always the masked one, and the
	// live viewport is untouched (xterm renders what the program printed,
	// AD-6).
	masked, findings, segs, err := maskCommandSafe(p.Command)
	if err != nil {
		// Fail closed: the raw command must not reach the row, and the
		// tab's pending captures die with the failed record.
		if s.captures != nil {
			s.captures.DestroyTab(tabID(wconn))
		}
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "history.record: detection failed; command not recorded"))
		return
	}

	// The row's segments: one per finding, byte offsets into the masked
	// command. Offsets are stored in bytes (the store slices bytes); the
	// UTF-16 conversion happens at the wire, below, once.
	redactions := make([]content.Redaction, 0, len(segs))
	for i, seg := range segs {
		redactions = append(redactions, content.Redaction{
			Kind:   string(findings[i].Kind),
			Start:  seg.Start,
			End:    seg.End,
			Prefix: seg.Prefix,
			Suffix: seg.Suffix,
		})
	}

	// Already saved this session: the row stores the existing reference
	// automatically and nothing is offered. The fingerprint is equality
	// only — it never crosses to the renderer.
	rowCommand := masked
	savedAt := make(map[int]string, len(findings)) // redaction index → name
	if s.captures != nil {
		for i, f := range findings {
			fp := s.captures.Fingerprint([]byte(p.Command[f.ValueStart:f.ValueEnd]))
			if name, ok := s.captures.SavedName(fp); ok {
				savedAt[i] = name
			}
		}
	}
	if len(savedAt) > 0 {
		for i := len(redactions) - 1; i >= 0; i-- {
			if name, ok := savedAt[i]; ok {
				r := redactions[i]
				rowCommand = rowCommand[:r.Start] + "{{secret:" + name + "}}" + rowCommand[r.End:]
			}
		}
	}

	// The row's actual redactions, with offsets adjusted for the
	// replacements that happened above (a reference has a different length
	// than the mask it replaced). These are also the capture links.
	rowRedactions := make([]content.Redaction, 0, len(redactions))
	delta := 0
	creds := make([]credential.PendingCredential, 0, len(redactions))
	for i, f := range findings {
		r := redactions[i]
		if _, ok := savedAt[i]; ok {
			delta += len("{{secret:"+savedAt[i]+"}}") - (r.End - r.Start)
			continue
		}
		adj := content.Redaction{Kind: r.Kind, Start: r.Start + delta, End: r.End + delta, Prefix: r.Prefix, Suffix: r.Suffix}
		rowRedactions = append(rowRedactions, adj)
		creds = append(creds, credential.PendingCredential{
			Value:         []byte(p.Command[f.ValueStart:f.ValueEnd]),
			SuggestedName: secrets.SuggestName(p.Command, f),
			Redaction:     adj,
		})
	}

	ack := historyRecordResponse{
		MaskedCount: len(findings),
		MaskedKinds: maskedKindsOf(findings),
		Redactions:  []redactionWire{},
		Captures:    []captureWire{},
	}
	if ack.MaskedKinds == nil {
		ack.MaskedKinds = []string{}
	}
	// The ack's redactions describe the ROW — the command the renderer
	// actually sees — so their offsets are UTF-16 units into rowCommand.
	for _, r := range rowRedactions {
		start, end := secrets.ToUTF16Span(rowCommand, r.Start, r.End)
		ack.Redactions = append(ack.Redactions, redactionWire{
			Kind: r.Kind, Start: start, End: end, Prefix: r.Prefix, Suffix: r.Suffix,
		})
	}

	if s.contentDB == nil {
		// No store wired (test-only state): the request is accepted and
		// recorded nowhere; history.query answers source=session in the
		// same state. Without a row there is no entry id for a capture to
		// rewrite, so no offer is made either.
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(ack)))
		return
	}

	rec := content.CommandRecord{
		Command:     rowCommand,
		Cwd:         p.Cwd,
		Host:        p.Host,
		Status:      content.CommandStatus(p.Status),
		ExitCode:    p.ExitCode,
		StartedAt:   p.StartedAt,
		EndedAt:     p.EndedAt,
		Trusted:     p.Trusted,
		MaskedCount: ack.MaskedCount,
		MaskedKinds: ack.MaskedKinds,
		Redactions:  rowRedactions,
	}
	entryID := ""
	id, err := s.contentDB.CommandHistory().Add(ctx, rec)
	if err != nil {
		// History-record failure destroys the tab's pending captures: the
		// record that was to carry the offer's row never landed (capture
		// contract).
		if s.captures != nil {
			s.captures.DestroyTab(tabID(wconn))
		}
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "history.record: ", err))
		return
	}
	if id > 0 {
		entryID = strconv.FormatInt(id, 10)
		ack.EntryID = entryID
	}

	// The offers, decided after the row exists (the capture's first link is
	// the row it will rewrite). Superseding, linking and suppression are
	// one atomic registry step.
	if s.captures != nil && len(creds) > 0 {
		scope := credential.CaptureScope{
			Tab:        tabID(wconn),
			SessionIDs: sessionIDsOf(state),
			EntryID:    entryID,
			Generation: state.nextGeneration(),
		}
		results := s.captures.Submit(scope, creds)
		for i, res := range results {
			if res.Outcome == credential.OutcomeCaptured || res.Outcome == credential.OutcomeLinked {
				ack.Captures = append(ack.Captures, captureWire{
					ID:            string(res.CaptureID),
					EntryID:       entryID,
					Redaction:     ack.Redactions[i],
					SuggestedName: res.SuggestedName,
				})
			}
		}
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(ack)))
}

// tabID is the per-connection identity captures are scoped to, in the
// string form the registry keys scopes by.
func tabID(wconn *wsConn) string {
	return strconv.FormatUint(wconn.id, 10)
}

// sessionIDsOf is the snapshot of the connection's sessions at record time
// — informational scope (a tab can hold several sessions; ambiguous
// ownership falls back rather than guessing).
func sessionIDsOf(state *connState) []string {
	state.mu.Lock()
	ids := make([]string, 0, len(state.sessions))
	for id := range state.sessions {
		ids = append(ids, string(id))
	}
	state.mu.Unlock()
	sort.Strings(ids)
	return ids
}

// maskCommandSafe runs the one detector and converts a panic into an error.
// The known panic — an absent optional regex group sliced as [:-1] — is
// fixed and pinned by regression tests; this is the fail-closed belt: a
// detection failure refuses the write, never a raw command on disk.
func maskCommandSafe(line string) (masked string, findings []secrets.Finding, segs []secrets.Segment, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("detection panicked: %v", r)
		}
	}()
	masked, findings, segs = secrets.MaskWithSegments(line)
	return masked, findings, segs, nil
}

// maskedKindsOf deduplicates the findings' kinds in first-occurrence order —
// the order a block would read them aloud. The kinds are the closed
// vocabulary of internal/secrets; the secret's VALUE never appears here
// (the finding carries only kind and offsets).
func maskedKindsOf(findings []secrets.Finding) []string {
	seen := make(map[secrets.Kind]struct{}, len(findings))
	out := make([]string, 0, len(findings))
	for _, f := range findings {
		if _, ok := seen[f.Kind]; ok {
			continue
		}
		seen[f.Kind] = struct{}{}
		out = append(out, string(f.Kind))
	}
	return out
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
