package transport

// secrets.detect — the ONE detector, exposed over the wire. Detection lived
// twice (internal/secrets and a TS port in the renderer) and the two
// drifted; the port is deleted with this round, and the renderer's prompt
// hint calls here instead. The earlier objection to a wire call was "a
// round trip per keystroke"; the hint already debounces 500 ms after typing
// stops, so detection is one call per pause, never per keystroke.
//
// The result shape is declared once in contracts/secrets.detect.schema.json.
// There is deliberately no params schema (contracts/README.md): the handler
// is the check.
//
// Two wire facts matter:
//
//   - Offsets are UTF-16 code units, NOT Go bytes — CodeMirror positions
//     are UTF-16, and byte offsets decorate the wrong text on any line with
//     an emoji, a combining mark or Cyrillic before the credential. The
//     conversion happens here, once, at the wire (secrets.ToUTF16Span).
//   - The response echoes the revision it was computed for. The renderer
//     drops a response whose revision no longer matches — it never adjusts
//     an old range onto a newer document.

import (
	"encoding/json"
	"fmt"

	"github.com/shady2k/nocx/internal/secrets"
)

// secretsDetectParams is the request the prompt hint sends: the line and
// the renderer's document revision (an opaque monotonic counter the
// controller owns).
type secretsDetectParams struct {
	Line     string `json:"line"`
	Revision int64  `json:"revision"`
}

// secretsDetectFinding is one finding on the wire: kind plus UTF-16
// offsets, plus the backend-derived suggested vault name (the SAME
// SuggestName the after-submit captures carry — the renderer must never
// predict a name; the one it would predict is exactly the duplication the
// capture round removed).
//
// ValueStart/ValueEnd bound the CREDENTIAL inside the finding, in UTF-16
// units into the line: for structural rules (env assignment, auth header,
// db connstring, URL userinfo, high-entropy) the finding span covers the
// whole syntax, and a save must store the value token only — the same
// bounds the capture path uses — never the `KEY=` or `Bearer ` around it.
type secretsDetectFinding struct {
	Kind          string `json:"kind"`
	Start         int    `json:"start"`
	End           int    `json:"end"`
	ValueStart    int    `json:"valueStart"`
	ValueEnd      int    `json:"valueEnd"`
	SuggestedName string `json:"suggestedName"`
}

// secretsDetectResponse is the result of secrets.detect. Revision echoes
// the request so the renderer can drop a stale response; Findings is never
// null: no findings is [] (contracts/secrets.detect.schema.json).
type secretsDetectResponse struct {
	Revision int64                  `json:"revision"`
	Findings []secretsDetectFinding `json:"findings"`
}

// handleSecretsDetect serves the secrets.detect method. Detection failure
// (including a panic, which the safe wrapper converts) is an error — the
// renderer shows nothing rather than a hint computed from a broken pass.
func (s *WSServer) handleSecretsDetect(wconn *wsConn, req jsonrpcRequest) {
	var p secretsDetectParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: params must be an object"))
		return
	}

	findings, err := detectLineSafe(p.Line)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "secrets.detect: "+err.Error()))
		return
	}
	resp := secretsDetectResponse{
		Revision: p.Revision,
		Findings: make([]secretsDetectFinding, 0, len(findings)),
	}
	for _, f := range findings {
		start, end := secrets.ToUTF16Span(p.Line, f.Start, f.End)
		vStart, vEnd := secrets.ToUTF16Span(p.Line, f.ValueStart, f.ValueEnd)
		resp.Findings = append(resp.Findings, secretsDetectFinding{
			Kind:          string(f.Kind),
			Start:         start,
			End:           end,
			ValueStart:    vStart,
			ValueEnd:      vEnd,
			SuggestedName: secrets.SuggestName(p.Line, f),
		})
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
}

// detectLineSafe runs the detector and converts a panic into an error. The
// known panic — an absent optional regex group sliced as [:-1] — is fixed
// and pinned by regression tests; this is the fail-closed belt under it: a
// detection failure must never take a handler down with a broken partial
// answer.
func detectLineSafe(line string) (findings []secrets.Finding, err error) {
	defer func() {
		if r := recover(); r != nil {
			findings = nil
			err = fmt.Errorf("detection panicked: %v", r)
		}
	}()
	return secrets.Detect(line), nil
}
