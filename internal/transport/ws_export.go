package transport

// The export.* control-plane handlers as constructed types (migration map,
// "export.*"): the read modes (manifest, configExport, portableEncrypted,
// backup) hold an ExportOperation; the import modes (import, importPortable)
// hold a RestoreOperation. Each handler holds its operation and the
// Responder — never the *WSServer, so a handler cannot reach a store it was
// not constructed with. The handler only decodes the payload; the service
// owns the transaction and its rollback.
//
// All export modes work purely through the profile/group repositories and
// storage paths — the credential.CredentialStore is never consulted, so no
// mode can resolve a secret (ADR-0011 §2, §7).

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/export"
	"github.com/shady2k/nocx/internal/transport/control"
)

// exportHandlers answers the export.* read methods. op is nil when the
// profile/group stores are not wired — the domain then answers the
// "profiles not available" error, exactly like the pre-capability
// dispatcher. backupWired records whether the storage paths were wired at
// construction: export.backup needs them and answers "backup not available"
// without them.
type exportHandlers struct {
	op          capability.ExportOperation // nil → profiles/groups not wired
	r           Responder
	backupWired bool // exportPaths wired at construction
}

// --- export.manifest ---------------------------------------------------

type exportManifestParams struct {
	Mode string `json:"mode"`
}

// handleManifest serves export.manifest. ManifestFor is pure.
func (h exportHandlers) handleManifest(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params exportManifestParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Mode == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: mode required"})
		return
	}
	var m export.Manifest
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ExportService) error {
		m = svc.Manifest(export.Mode(params.Mode))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(m))
}

// --- export.configExport -----------------------------------------------

// handleConfigExport serves export.configExport.
func (h exportHandlers) handleConfigExport(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ExportService) error {
		result, err := svc.ConfigExport()
		if err != nil {
			return err
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// --- export.portableEncrypted ------------------------------------------

type exportPortableEncryptedParams struct {
	Passphrase            string `json:"passphrase"`
	IncludePrivateContent bool   `json:"includePrivateContent,omitempty"`
}

// handlePortableEncrypted serves export.portableEncrypted.
func (h exportHandlers) handlePortableEncrypted(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params exportPortableEncryptedParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Passphrase == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: passphrase required"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ExportService) error {
		result, err := svc.PortableEncrypted(ctx, params.Passphrase, params.IncludePrivateContent)
		if err != nil {
			return err
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// --- export.backup -----------------------------------------------------

// handleBackup serves export.backup.
func (h exportHandlers) handleBackup(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	if !h.backupWired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "backup not available (paths not wired)"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ExportService) error {
		result, err := svc.Backup(ctx)
		if err != nil {
			return err
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// --- export.import / export.importPortable ------------------------------

// restoreHandlers answers export.import and export.importPortable. op is
// nil when the profile/group stores are not wired (the domain's not-wired
// answer). The handler decodes the payload only; RestoreService.Import owns
// the whole profiles+groups+settings+content transaction and its rollback
// (migration map, export.* — the RestoreOperation).
type restoreHandlers struct {
	op capability.RestoreOperation // nil → profiles/groups not wired
	r  Responder
}

type exportImportParams struct {
	Data json.RawMessage `json:"data"`
}

// handleImport serves export.import.
func (h restoreHandlers) handleImport(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params exportImportParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: data required"})
		return
	}
	var data export.ConfigExport
	if err := json.Unmarshal(params.Data, &data); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: data must be a ConfigExport"})
		return
	}
	// Domain restore operation — owner: the restore's own commit interval,
	// not this connection (see internal/export/restore.go, which documents
	// the commit point and its rollback). Profiles, groups and settings
	// commit as one operation; the transport never sequences the stores
	// itself, and never cancels across the boundary. Closing event:
	// RestoreImport returning after commit-or-rollback.
	err := h.op.Run(context.Background(), func(ctx context.Context, svc capability.RestoreService) error {
		result, err := svc.Import(ctx, &data, nil)
		if err != nil {
			return err
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// exportImportPortableParams is decoded from the export.importPortable RPC payload.
type exportImportPortableParams struct {
	Payload    string `json:"payload"` // base64-encoded encrypted blob
	Passphrase string `json:"passphrase"`
}

// handleImportPortable serves export.importPortable.
func (h restoreHandlers) handleImportPortable(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params exportImportPortableParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Payload == "" || params.Passphrase == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: payload (base64) and passphrase required"})
		return
	}
	payload, decodeErr := base64.StdEncoding.DecodeString(params.Payload)
	if decodeErr != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: payload must be base64"})
		return
	}
	enc := &export.PortableEncryptedExport{Payload: payload}
	plain, err := export.DecryptPortableExport(enc, params.Passphrase)
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Decryption failed: wrong passphrase or corrupted data"})
		return
	}
	// Domain restore operation — owner: the restore's own commit interval
	// (see internal/export/restore.go). Profiles, groups, settings and
	// private content commit as ONE operation with a defined rollback. The
	// transport does not sequence the stores — a failure between two
	// independently sequenced phases would leave them at different
	// generations — and never cancels across the commit point. The
	// closing event is RestoreImport returning after commit-or-rollback.
	runErr := h.op.Run(context.Background(), func(ctx context.Context, svc capability.RestoreService) error {
		result, err := svc.Import(ctx, &plain.Config, plain.Private)
		if err != nil {
			return err
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if runErr != nil {
		answerOperationRefusal(h.r, req.ID, runErr)
	}
}

// contentSpecs declares the history.* and export.* control methods — the
// content domain plus the export/restore pair over the config+content
// stores. Each operation is built ONCE here from the wired stores and the
// gates passed in (composition root for this domain), shared across the
// methods of its domain (migration pattern rule 5). The handlers are
// constructed types holding their operation and Responder, never the
// *WSServer.
//
// The not-wired answers preserve the pre-capability dispatcher: history.*
// with no content store answers source=session / an accepted empty ack, and
// export.* with no profile/group stores answers -32601 "profiles not
// available".
func (s *WSServer) contentSpecs(lane control.Admission, configGate, contentGate control.Admission) []methodSpec {
	var contentOp capability.ContentOperation
	if s.contentDB != nil {
		contentOp = capability.NewContentOperation(contentGate, lane, s.contentDB)
	}

	var exportOp capability.ExportOperation
	var restoreOp capability.RestoreOperation
	if s.profiles != nil && s.groups != nil {
		exportOp = capability.NewExportOperation(configGate, contentGate, lane, s.profiles, s.groups, s.settings, s.exportPaths, s.exportContentDB)
		restoreOp = capability.NewRestoreOperation(configGate, contentGate, lane, s.profileSvc, s.settings, s.exportContentDB)
	}
	backupWired := s.exportPaths != nil
	contentSub := s.operationQueue("content")
	exportSub := s.operationQueue("export")

	return []methodSpec{
		regResponder(contentSub, "history.query", func(r Responder) handlerFunc {
			h := historyQueryHandlers{op: contentOp, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleHistoryQuery(ctx, req) }
		}),
		// history.record needs the *wsConn as identity: the capture tab id
		// scopes the pending-capture registry (reg, not regResponder).
		reg(contentSub, "history.record", func(w *wsConn, state *connState) handlerFunc {
			h := historyRecordHandlers{op: contentOp, captures: s.captures, machine: s, r: w}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleHistoryRecord(ctx, w, state, req) }
		}),
		regResponder(exportSub, "export.manifest", func(r Responder) handlerFunc {
			h := exportHandlers{op: exportOp, r: r, backupWired: backupWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleManifest(ctx, req) }
		}),
		regResponder(exportSub, "export.configExport", func(r Responder) handlerFunc {
			h := exportHandlers{op: exportOp, r: r, backupWired: backupWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleConfigExport(ctx, req) }
		}),
		regResponder(exportSub, "export.portableEncrypted", func(r Responder) handlerFunc {
			h := exportHandlers{op: exportOp, r: r, backupWired: backupWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handlePortableEncrypted(ctx, req) }
		}),
		regResponder(exportSub, "export.backup", func(r Responder) handlerFunc {
			h := exportHandlers{op: exportOp, r: r, backupWired: backupWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleBackup(ctx, req) }
		}),
		regResponder(exportSub, "export.import", func(r Responder) handlerFunc {
			h := restoreHandlers{op: restoreOp, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleImport(ctx, req) }
		}),
		regResponder(exportSub, "export.importPortable", func(r Responder) handlerFunc {
			h := restoreHandlers{op: restoreOp, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleImportPortable(ctx, req) }
		}),
	}
}
