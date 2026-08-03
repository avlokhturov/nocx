package transport

// secrets.captureSave / secrets.captureDismiss — the settlement seam for
// the pending-capture registry (internal/credential/capture.go holds the
// contract; this file is where its triggers meet the wire).
//
// Saving is two stores, in one order: create the vault secret (atomically
// name-collision-resolved, the real name comes back), THEN rewrite every
// linked history row's redaction segment to the reference. Never the other
// order — rewriting first can leave a reference to a secret that does not
// exist. If the create succeeds and a rewrite fails: keep the secret, leave
// history safely masked, report the partial result, and let the rewrite be
// retried (the capture remembers the name and that the rewrite is owed, so
// the retry never mints openrouter.ai-2).
//
// The capture id is the idempotency key: a lost response retries with the
// same id and the registry answers with the recorded outcome instead of
// running the vault again.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/secrets"
	"github.com/shady2k/nocx/internal/vault"
)

// captureSaveParams is the request for secrets.captureSave. Name is
// optional: absent, the backend-derived suggestion is used. The renderer
// may propose a name but must never predict that a suffixed name is free —
// the vault resolves collisions atomically and the real name comes back.
type captureSaveParams struct {
	CaptureID string `json:"captureId"`
	Name      string `json:"name,omitempty"`
}

// captureSaveResponse is the result of secrets.captureSave. Name is the
// vault name ACTUALLY used. Partial reports the brief's step-2 failure
// shape: the secret exists under Name, one or more history rewrites are
// still owed, and a retry of the same capture completes them without
// creating another secret.
type captureSaveResponse struct {
	Name    string `json:"name"`
	Partial bool   `json:"partial,omitempty"`
	// Error is the rewrite failure's message, present only when Partial.
	Error string `json:"error,omitempty"`
}

// captureDismissParams is the request for secrets.captureDismiss.
type captureDismissParams struct {
	CaptureID string `json:"captureId"`
}

// handleCaptureSave settles a capture into the vault. Idempotent: a retry
// of a settled capture returns the recorded name (and re-runs only the
// owed rewrites); a save in flight blocks until it settles, so two
// concurrent saves cannot mint two secrets.
func (s *WSServer) handleCaptureSave(wconn *wsConn, req jsonrpcRequest) {
	if s.captures == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "secrets.captureSave: capture registry unavailable"))
		return
	}
	var p captureSaveParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: params must be an object"))
		return
	}
	if p.CaptureID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: captureId is required"))
		return
	}

	h, err := s.captures.Reserve(credential.CaptureID(p.CaptureID))
	if err != nil {
		_ = wconn.writeJSON(captureErrorFor(req.ID, err))
		return
	}

	// An idempotent retry: the save already settled.
	if h.Completed {
		if h.RewritePending {
			if rwErr := s.rewriteLinks(h.Links, h.Name); rwErr != nil {
				_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(captureSaveResponse{
					Name: h.Name, Partial: true, Error: rwErr.Error(),
				})))
				return
			}
			s.captures.Complete(h.CaptureID, h.Name, h.SecretID, false, nil)
		}
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(captureSaveResponse{Name: h.Name})))
		return
	}

	// The live save. The value never leaves the process: it goes from the
	// capture straight into the vault create.
	if s.vaultLifecycle == nil {
		s.captures.Complete(h.CaptureID, "", "", false, errors.New("vault unavailable"))
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "secrets.captureSave: vault unavailable"))
		return
	}
	name := h.SuggestedName
	if p.Name != "" {
		name = sanitizeCaptureName(p.Name)
	}
	kind := vault.KindPassword
	for _, l := range h.Links {
		if l.Redaction.Kind == string(secrets.KindPrivateKey) {
			kind = vault.KindPrivateKey
			break
		}
	}
	secretID, realName, err := s.vaultLifecycle.CreateNamedResolved(context.Background(), h.Value,
		vault.SecretMeta{Name: name, Kind: kind})
	if err != nil {
		s.captures.Complete(h.CaptureID, "", "", false, err)
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "secrets.captureSave: ", err))
		return
	}
	if rwErr := s.rewriteLinks(h.Links, "{{secret:"+realName+"}}"); rwErr != nil {
		// Step 1 done, step 2 owed: report the partial result; a retry
		// with the same capture completes the rewrite without a second
		// secret (the registry records name + rewrite-owed).
		s.captures.Complete(h.CaptureID, realName, secretID, true, nil)
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(captureSaveResponse{
			Name: realName, Partial: true, Error: rwErr.Error(),
		})))
		return
	}
	s.captures.Complete(h.CaptureID, realName, secretID, false, nil)
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(captureSaveResponse{Name: realName})))
}

// handleCaptureDismiss destroys a pending capture and suppresses its
// fingerprint for the rest of the application session. Idempotent.
func (s *WSServer) handleCaptureDismiss(wconn *wsConn, req jsonrpcRequest) {
	if s.captures == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "secrets.captureDismiss: capture registry unavailable"))
		return
	}
	var p captureDismissParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: params must be an object"))
		return
	}
	if p.CaptureID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: captureId is required"))
		return
	}
	if err := s.captures.Dismiss(credential.CaptureID(p.CaptureID)); err != nil {
		_ = wconn.writeJSON(captureErrorFor(req.ID, err))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

// rewriteLinks rewrites every linked history row's redaction segment to the
// reference. The rows are addressed by their stable ids. A row the
// retention sweep removed is skipped — the rewrite is moot, the secret
// still exists; anything else fails the rewrite set.
func (s *WSServer) rewriteLinks(links []credential.CaptureLink, reference string) error {
	if s.contentDB == nil {
		return errors.New("history store unavailable")
	}
	var firstErr error
	for _, l := range links {
		if l.EntryID == "" {
			continue
		}
		id, err := strconv.ParseInt(l.EntryID, 10, 64)
		if err != nil {
			// The entry id is the store's numeric id in string form; a
			// non-numeric one is internal corruption, not a caller fact.
			if firstErr == nil {
				firstErr = fmt.Errorf("bad entry id %q: %w", l.EntryID, err)
			}
			continue
		}
		if err := s.contentDB.CommandHistory().RewriteRedaction(context.Background(), id, l.Redaction, reference); err != nil {
			if errors.Is(err, content.ErrNotFound) {
				continue // swept away — nothing to rewrite
			}
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// sanitizeCaptureName makes a renderer-proposed vault name safe to embed in
// a {{secret:NAME}} reference: braces are structural there, so they cannot
// ride a name. The backend's own suggestions need no such scrubbing (they
// are derived from hosts and env keys), but the renderer can type anything.
func sanitizeCaptureName(name string) string {
	return strings.NewReplacer("{", "", "}", "").Replace(strings.TrimSpace(name))
}

// captureErrorFor maps the registry's sentinel failures to JSON-RPC errors
// with a machine-readable reason, the way the vault errors carry theirs —
// the renderer must tell "expired" from "already consumed" from "the save
// failed earlier" apart, or it cannot decide what to show.
func captureErrorFor(id json.RawMessage, err error) jsonrpcResponse {
	reason := "capture-error"
	code := -32603
	switch {
	case errors.Is(err, credential.ErrCaptureUnknown):
		code, reason = -32010, "capture-expired"
	case errors.Is(err, credential.ErrCaptureConsumed):
		code, reason = -32011, "capture-consumed"
	case errors.Is(err, credential.ErrCaptureSaveFailed):
		code, reason = -32012, "capture-save-failed"
	}
	obj := jsonrpcErrorObj{Code: code, Message: err.Error()}
	if reason != "capture-error" {
		obj.Data = json.RawMessage(`{"reason":"` + reason + `"}`)
	}
	return jsonrpcResponse{JSONRPC: "2.0", ID: id, Error: &obj}
}
