package transport

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/shady2k/nocx/internal/backup"
	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/transport/control"
)

type backupSpecs struct {
	operation capability.BackupOperation
	saver     func(string, string) (*backup.SaveResult, error)
}

func (s *WSServer) backupSpecs(lane control.Admission, configGate control.Admission) []methodSpec {
	var op capability.BackupOperation
	if s.backupService != nil {
		op = capability.NewBackupOperation(configGate, lane, s.backupService)
	}
	h := backupSpecs{operation: op, saver: s.backupFileSaver}
	return []methodSpec{
		regResponder(s.operationQueue("backup"), "backup.create", func(r Responder) handlerFunc {
			return func(ctx context.Context, req jsonrpcRequest) { h.create(ctx, r, req) }
		}),
		regResponder(s.operationQueue("backup"), "backup.preview", func(r Responder) handlerFunc {
			return func(ctx context.Context, req jsonrpcRequest) { h.preview(ctx, r, req) }
		}),
		regResponder(s.operationQueue("backup"), "backup.restore", func(r Responder) handlerFunc {
			return func(ctx context.Context, req jsonrpcRequest) { h.restore(ctx, r, req) }
		}),
		regResponder(s.dialogSub, "backup.saveToFile", func(r Responder) handlerFunc {
			return func(ctx context.Context, req jsonrpcRequest) { h.saveToFile(ctx, r, req) }
		}),
	}
}

type backupPreviewParams struct {
	Contents string `json:"contents"`
	Strategy string `json:"strategy"`
}

type backupRestoreParams struct {
	Contents     string `json:"contents"`
	Strategy     string `json:"strategy"`
	PreviewToken string `json:"previewToken"`
}

type backupSaveParams struct {
	FileName string `json:"fileName"`
	Contents string `json:"contents"`
}

func (h backupSpecs) create(ctx context.Context, r Responder, req jsonrpcRequest) {
	if h.operation == nil {
		_ = r.TryError(req.ID, RPCError{Code: -32601, Message: "backup not available"})
		return
	}
	var result *backup.CreateResult
	err := h.operation.Run(ctx, func(ctx context.Context, svc capability.BackupService) error {
		var err error
		result, err = svc.Create()
		return err
	})
	if err != nil {
		h.error(r, req.ID, "backup.create", err)
		return
	}
	_ = r.TryResult(req.ID, mustMarshal(result))
}

func (h backupSpecs) preview(ctx context.Context, r Responder, req jsonrpcRequest) {
	if h.operation == nil {
		_ = r.TryError(req.ID, RPCError{Code: -32601, Message: "backup not available"})
		return
	}
	var params backupPreviewParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Contents == "" {
		_ = r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: contents required"})
		return
	}
	var result *backup.RestorePreview
	err := h.operation.Run(ctx, func(ctx context.Context, svc capability.BackupService) error {
		var err error
		result, err = svc.Preview(params.Contents, backup.RestoreStrategy(params.Strategy))
		return err
	})
	if err != nil {
		h.error(r, req.ID, "backup.preview", err)
		return
	}
	_ = r.TryResult(req.ID, mustMarshal(result))
}

func (h backupSpecs) restore(ctx context.Context, r Responder, req jsonrpcRequest) {
	if h.operation == nil {
		_ = r.TryError(req.ID, RPCError{Code: -32601, Message: "backup not available"})
		return
	}
	var params backupRestoreParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Contents == "" || params.PreviewToken == "" {
		_ = r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: contents and previewToken required"})
		return
	}
	var result *backup.RestoreResult
	err := h.operation.Run(ctx, func(ctx context.Context, svc capability.BackupService) error {
		var err error
		result, err = svc.Restore(params.Contents, backup.RestoreStrategy(params.Strategy), params.PreviewToken)
		return err
	})
	if err != nil {
		h.error(r, req.ID, "backup.restore", err)
		return
	}
	_ = r.TryResult(req.ID, mustMarshal(result))
}

func (h backupSpecs) saveToFile(_ context.Context, r Responder, req jsonrpcRequest) {
	if h.saver == nil {
		_ = r.TryError(req.ID, RPCError{Code: -32601, Message: "backup.saveToFile not available"})
		return
	}
	var params backupSaveParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.FileName == "" || params.Contents == "" {
		_ = r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: fileName and contents required"})
		return
	}
	result, err := h.saver(params.FileName, params.Contents)
	if err != nil {
		_ = r.TryError(req.ID, rpcErrorFor(-32603, "backup.saveToFile: ", err))
		return
	}
	_ = r.TryResult(req.ID, mustMarshal(result))
}

func (h backupSpecs) error(r Responder, id json.RawMessage, method string, err error) {
	var refused *capability.RefusedError
	if errors.As(err, &refused) {
		_ = r.TryError(id, saturationRPCError(method, &refused.Rejection))
		return
	}
	code := -32603
	if errors.Is(err, backup.ErrInvalidDocument) {
		code = -32602
	}
	_ = r.TryError(id, rpcErrorFor(code, method+": ", err))
}
