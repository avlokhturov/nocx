package transport

// run — the broker's run request (nocx-tjppv, design §4.1): the agent runs
// a command through the same submit path a person uses. The request travels
// broker -> renderer as agent.runRequest; the renderer submits the command
// through its ordinary orchestration (block, ledger entry, attempt, output
// artifact — all minted at submit, at the renderer), waits for the
// completion, and answers agent.runResolved with the entry id, the exit
// status and a window of the output. The backend never writes to the PTY
// (design §2.1 — rejected, not open for re-litigation): session.Write
// exists and is the shortest path, and it is deliberately not used, because
// a byte written straight to the pty would exist with no entry — a second
// input surface, and an invisible one.
//
// The broker mechanism (request_broker.go) owns id minting, correlation,
// timeouts and terminalization; this file is one RequestKind plus the
// WSServer's seams for it: the Conns snapshot, the per-connection Deliver,
// the read-loop Resolve registration and the ConnectionLost signal in
// connection teardown (ws.go) — the same four seams readScreen uses, with a
// different effect and a different resolution payload.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/shady2k/nocx/internal/transport/control"
)

// runRequestTimeout bounds one run request. Unlike readScreen — a capture
// the renderer answers in milliseconds — a run request legitimately waits
// for the submitted command to COMPLETE (the resolution carries the exit
// status and a window of the output), and the renderer resolves only when
// the block freezes. Without the lease (ADR-0020 decision 2 — its own
// bead), this fixed bound is the honest interim: a command that outlives it
// terminalizes the tool call through the broker timeout while the command
// keeps running in its lane — the wedged-agent-command gap this bead
// documents rather than hides. Generous, and bounded: a renderer that never
// answers must not leak a pending request.
const runRequestTimeout = 10 * time.Minute

// maxRunOutputWindowChars is the renderer-side clamp on the output window
// text one run resolution carries: the model reads this much output per
// command, and the honest window statement says how much more the block
// holds. The output budget of the lease (ADR-0020 decision 2) is its own
// bead; this is the wire bound that exists today.
const maxRunOutputWindowChars = 64 << 10 // 64 KiB of output text

// errRunNoRenderer is the run kind's no-client answer: there is no renderer
// attached to submit the command. Named, the way readScreen names its
// no-client outcome.
var errRunNoRenderer = errors.New("no renderer connected to run the command")

// ── wire shapes ────────────────────────────────────────────────────────────

// runRequestParams is what the broker sends the renderer (with the minted
// requestId merged in — marshalWithRequestID). sessionId is the lane the
// command runs in (already narrowed by the run's grant before the request
// was sent); command is exactly what a person would type.
type runRequestParams struct {
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
}

// runResolvedParams is the renderer's answer: a closed outcome —
// "completed", carrying the run body (entry id, exit status, output
// window), or "failed", carrying why. The run body's status is the block's
// own frozen status vocabulary (success | failure | entered | unknown); an
// entered block (an environment transition — the local `ssh` block) carries
// no exit code, honestly.
type runResolvedParams struct {
	RequestID string `json:"requestId"`
	Outcome   string `json:"outcome"` // "completed" | "failed"
	Error     string `json:"error,omitempty"`
	EntryID   string `json:"entryId"`
	ExitCode  *int   `json:"exitCode"`
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Text      string `json:"text"`
}

// runResolvedBody is the resolved result the broker's Request decodes into:
// the run body only, requestId and outcome consumed by the correlation. The
// assistant executor reads this shape (its own minimal consumer view) to
// build the tool's windowed return.
type runResolvedBody struct {
	EntryID  string `json:"entryId"`
	ExitCode *int   `json:"exitCode"`
	Status   string `json:"status"`
	Total    int    `json:"total"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Text     string `json:"text"`
}

// ── the kind ──────────────────────────────────────────────────────────────

// runKind is the request exchange for one command submission. The renderer
// half of the wire contract lives here, as data — the mechanism's
// RequestKind design — so the WSServer's RequestRun writes no request
// machinery. The resolution bound is budgetDocument: the output window
// legitimately carries a large text payload (bounded by the renderer's
// maxRunOutputWindowChars clamp and this wire budget), far beyond the 1 KiB
// that bounds the closed-outcome resolvers.
func runKind() RequestKind {
	return RequestKind{
		NotifyMethod:       "agent.runRequest",
		ResolveMethod:      "agent.runResolved",
		NoClientErr:        errRunNoRenderer,
		Timeout:            runRequestTimeout,
		MaxResolutionBytes: budgetDocument,
		Resolve:            resolveRun,
	}
}

// resolveRun maps an accepted resolution to the run body result, or to the
// terminal error of a failed submission. The outcome was validated on the
// ingress (validateRunResolvedRaw), so this is the meaning of the outcome,
// not a second shape check.
func resolveRun(raw json.RawMessage) (json.RawMessage, error) {
	var p runResolvedParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("run: resolution: %w", err)
	}
	if p.Outcome == "failed" {
		return nil, fmt.Errorf("run: the renderer could not run the command: %s", p.Error)
	}
	body, err := json.Marshal(runResolvedBody{
		EntryID: p.EntryID, ExitCode: p.ExitCode, Status: p.Status,
		Total: p.Total, Start: p.Start, End: p.End, Text: p.Text,
	})
	if err != nil {
		return nil, fmt.Errorf("run: body: %w", err)
	}
	return body, nil
}

// ── ingress validation ─────────────────────────────────────────────────────

// validateRunResolvedRaw is the resolution's per-field shape check, applied
// on the read-loop ingress before the broker consumes the request: the
// closed outcome, the run body when the outcome is completed (entry id,
// status vocabulary, span within the block), the failure sentence when it
// is failed. A refused resolution leaves the pending request in place for a
// corrected retry.
func validateRunResolvedRaw(raw json.RawMessage) string {
	var p runResolvedParams
	if msg := decodeParams(raw, &p); msg != "" {
		return msg
	}
	switch p.Outcome {
	case "completed":
		if p.Error != "" {
			return "a completed outcome carries no error"
		}
		if p.EntryID == "" || utf8.RuneCountInString(p.EntryID) > maxIDRunes {
			return "a completed outcome requires an entry id within the id length bound"
		}
		switch p.Status {
		case "success", "failure", "entered", "unknown":
		default:
			return "status must be one of success, failure, entered, unknown"
		}
		if p.Total < 0 || p.Start < 0 || p.End < p.Start || p.End > p.Total {
			return "the returned window must be a span inside [0, total]"
		}
		if utf8.RuneCountInString(p.Text) > maxRunOutputWindowChars {
			return "the output window text exceeds the length bound"
		}
		return ""
	case "failed":
		if p.Error == "" {
			return "a failed outcome requires an error"
		}
		if utf8.RuneCountInString(p.Error) > maxResolutionErrorRunes {
			return "error exceeds the length bound"
		}
		return ""
	default:
		return "outcome must be one of completed, failed"
	}
}

// ── the WSServer seams ─────────────────────────────────────────────────────

// RequestRun implements assistant.RendererRequester: the transport side of
// the run tool. The grant has already narrowed the session (the capability
// the executor holds refuses out-of-grant sessions BEFORE this call), so
// the request names only the lane the run may use. The broker mints the
// request id, delivers the notification to every attached renderer and
// waits for the resolution — terminalizing through the kind's timeout or
// the death of the renderers if none answers.
func (s *WSServer) RequestRun(ctx context.Context, sessionID string, command string) (json.RawMessage, error) {
	if s.broker == nil {
		return nil, errors.New("run: no renderer request broker is wired")
	}
	var body json.RawMessage
	if err := s.broker.Request(ctx, runKind(), runRequestParams{SessionID: sessionID, Command: command}, &body); err != nil {
		return nil, fmt.Errorf("run: %w", err)
	}
	return body, nil
}

// runResolutionSpec registers agent.runResolved alongside readScreen's
// resolution: the broker's Resolve on the read-loop ingress (see
// brokerSpecs in ws_readscreen.go for the disposition).
func (s *WSServer) runResolutionSpec(immediate control.ImmediateSubmission) methodSpec {
	return reg(immediate, "agent.runResolved", params(validateRunResolvedRaw),
		func(w *wsConn, _ *connState, r Responder) handlerFunc {
			return func(ctx context.Context, req jsonrpcRequest) {
				perr := s.broker.Resolve("agent.runResolved", req.Params, w)
				if perr.Code != 0 {
					_ = w.TryError(req.ID, perr)
					return
				}
				_ = w.TryResult(req.ID, json.RawMessage(`{}`))
			}
		})
}
