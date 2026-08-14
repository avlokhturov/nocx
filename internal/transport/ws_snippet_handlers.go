package transport

// The snippets.* control handlers as constructed types: each handler holds a
// SnippetOperation and the Responder — never the *WSServer, and never the
// *snippet.Service directly. The service is handed to the callback inside
// op.Run, guard-bound, so a handler cannot reach the store outside the
// operation that gates it (capability.ErrOperationInactive).
//
// Snippets belong to the config conflict domain: the library is one document
// under the profile directory that backup/restore also writes, so a snippet
// mutation must conflict with a config-domain operation the way profiles.*
// and settings.* do — a restore replacing the document underneath the
// mutation is exactly the two-writer race the config gate serialises. The
// operation therefore holds the config gate, and only it: snippets never
// resolve vault rows, so the vault gate is not held.

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/snippet"
)

type snippetHandlers struct {
	op    capability.SnippetOperation // nil → snippets domain not wired
	wired bool                        // snippet service wired
	r     Responder
}

func (h snippetHandlers) handleMethod(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "snippets not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SnippetService) error {
		switch req.Method {
		case "snippets.list":
			all, err := svc.List()
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: snippetMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireSnippetList(all)))
		case "snippets.create":
			var p snippetCreateParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			created, err := svc.Create(p.Title, p.Body)
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: snippetMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(created))
		case "snippets.update":
			var p snippetUpdateParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if p.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			updated, err := svc.Update(p.ID, p.Title, p.Body)
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: snippetMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(updated))
		case "snippets.delete":
			var p snippetDeleteParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if p.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			if err := svc.Delete(p.ID); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: snippetMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(snippetDeleteResponse(p)))
		case "snippets.reorder":
			var p snippetReorderParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			reordered, err := svc.Reorder(p.IDs)
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: snippetMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireSnippetList(reordered)))
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// snippetMethodErrorCode maps a snippet service error to a JSON-RPC code: a
// missing record or a non-permutation reorder is the client's error (-32602);
// anything else is the server's (-32603).
func snippetMethodErrorCode(err error) int {
	if errors.Is(err, snippet.ErrNotFound) || errors.Is(err, snippet.ErrNotAPermutation) {
		return -32602
	}
	return -32603
}

// wireSnippetList forces the result's snippets slice to be non-nil: an empty
// library must marshal as [] and never null — the renderer's first .map
// assumes it (the schema's own description).
func wireSnippetList(snips []snippet.Snippet) snippetListResponse {
	if snips == nil {
		snips = []snippet.Snippet{}
	}
	return snippetListResponse{Snippets: snips}
}

type snippetListResponse struct {
	Snippets []snippet.Snippet `json:"snippets"`
}

type snippetDeleteResponse struct {
	ID string `json:"id"`
}

type snippetCreateParams struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type snippetUpdateParams struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

type snippetDeleteParams struct {
	ID string `json:"id"`
}

type snippetReorderParams struct {
	IDs []string `json:"ids"`
}
