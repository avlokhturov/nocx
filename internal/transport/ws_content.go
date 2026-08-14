package transport

import (
	"context"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/transport/control"
)

func (s *WSServer) contentSpecs(lane control.Admission, contentGate control.Admission, contentSub control.Submission) []methodSpec {
	var contentOp capability.ContentOperation
	if s.contentDB != nil {
		contentOp = capability.NewContentOperation(contentGate, lane, s.contentDB)
	}
	specs := []methodSpec{
		regResponder(contentSub, "history.query", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := historyQueryHandlers{op: contentOp, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleHistoryQuery(ctx, req) }
		}),
		reg(contentSub, "history.record", genericObject("per-field validation pending nocx-VALID"), func(w *wsConn, state *connState) handlerFunc {
			h := historyRecordHandlers{op: contentOp, captures: s.captures, machine: s, r: w}
			return func(ctx context.Context, req jsonrpcRequest) {
				h.handleHistoryRecord(ctx, w, state, req)
			}
		}),
	}
	return specs
}
