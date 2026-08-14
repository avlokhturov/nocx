package transport

// notify.raise (nocx-9zmc): the method the renderer calls to raise a
// notification, and the wire half of ADR-0029's provenance rule. The record
// carries sessionId, title and body and NOTHING else — kind, trust, level,
// attribution and at are stamped by this handler from the method invoked and
// the session registry, never read from the record. A schema proves a
// record's shape, never who assigned a field, which is why the protected
// fields are absent from the wire rather than validated on it; the decode
// below enforces that absence at the seam, so a frame the schema rejects is a
// JSON-RPC error rather than a silently ignored extra.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"

	"github.com/shady2k/nocx/internal/notify"
	"github.com/shady2k/nocx/internal/session"
)

// NotifyRaiser raises one event through the notify pipeline (ADR-0029). The
// transport holds this narrow seam; internal/notify's *Router satisfies it
// without an adapter, the same signature-identical shape as the tunnel and
// discovery connectors.
type NotifyRaiser interface {
	Raise(ctx context.Context, ev notify.Event) notify.Outcome
}

// WithNotifyRaiser wires the notify pipeline into the server, enabling
// notify.raise. When absent, the method answers -32601. The composition root
// constructs the router (internal/app/app.go); without this line the whole
// notify package is reachable from its own tests and nowhere else (AGENTS.md
// check 5).
func WithNotifyRaiser(r NotifyRaiser) WSServerOption {
	return func(s *WSServer) { s.notifyRaiser = r }
}

// notifyRaiseParams is the wire shape of notify.raise: sessionId, title and
// body and nothing else (ADR-0029 §2.2). sessionId is ADDRESSING, not
// attribution — one WebSocket multiplexes many server-assigned sessions
// (AD-1), so the record must say which terminal parsed the sequence, and the
// handler rejects an id not live on this connection. Every attributed field
// is derived from the registry entry for that id.
type notifyRaiseParams struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Body      string `json:"body"`
}

// decodeNotifyRaiseParams decodes the params with DisallowUnknownFields and
// refuses trailing input: a frame carrying trust, kind, level or any
// attribution field, or anything the schema does not name, is rejected here
// as invalid params. The absence of the protected fields is what makes
// provenance structural; the decode is the Go side of the schema's
// additionalProperties: false.
func decodeNotifyRaiseParams(raw []byte) (notifyRaiseParams, error) {
	var params notifyRaiseParams
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&params); err != nil {
		return params, err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return params, errTrailingJSON
	}
	return params, nil
}

// errTrailingJSON reports a params object followed by a second JSON value.
var errTrailingJSON = errors.New("notify: trailing JSON after params")

// notifyRaiseHandlers answers notify.raise. It is a constructed type holding
// its capability (the raiser), its registries (the session registry for
// attribution, the connection's session set for the liveness check) and its
// Responder — never the *WSServer.
type notifyRaiseHandlers struct {
	raiser   NotifyRaiser
	registry session.Registry
	state    *connState
	// tab is this connection's per-connection (per-tab) identity,
	// backend-assigned, monotonic and never reused — the tab half of the
	// backend-stamped attribution (ADR-0029 §4.6).
	tab string
	r   Responder
}

func (h notifyRaiseHandlers) handleNotifyRaise(ctx context.Context, req jsonrpcRequest) {
	if h.raiser == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "notify.raise not available"})
		return
	}
	params, err := decodeNotifyRaiseParams(req.Params)
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: exactly sessionId, title and body"})
		return
	}
	sid := session.ID(params.SessionID)
	sess, err := h.registry.Get(sid)
	if err != nil || !h.state.has(sid) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
		return
	}
	// Stamping, all of it backend-owned: kind and trust from the method
	// invoked, level and attribution from the session registry. There is no
	// argument, header or method variant by which a renderer call produces an
	// attested event — this handler is the programRequest boundary of
	// ADR-0029 §2.2.
	out := h.raiser.Raise(ctx, notify.Event{
		SessionID: params.SessionID,
		Title:     params.Title,
		Body:      params.Body,
		Kind:      notify.KindProgramNotify,
		Trust:     notify.TrustProgramRequest,
		Level:     notify.LevelInfo,
		Attribution: notify.Attribution{
			Tab:     h.tab,
			Host:    sess.Host(),
			Session: string(sess.ID()),
		},
	})
	if out.Err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "notify.raise: " + out.Err.Error()})
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
}

// notifySpecs declares the notify.raise control method. It runs on the
// ordinary lane: Raise is synchronous and can block on a sink invocation, so
// it must never run on the read loop.
func (s *WSServer) notifySpecs() []methodSpec {
	return []methodSpec{
		reg(s.lane, "notify.raise", func(w *wsConn, state *connState) handlerFunc {
			return notifyRaiseHandlers{
				raiser:   s.notifyRaiser,
				registry: s.registry,
				state:    state,
				tab:      strconv.FormatUint(w.id, 10),
				r:        w,
			}.handleNotifyRaise
		}),
	}
}
