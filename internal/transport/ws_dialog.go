package transport

import (
	"context"

	"github.com/shady2k/nocx/internal/transport/control"
)

// DialogService opens native platform dialogs on behalf of the renderer. It
// is a control-plane capability (AD-1): the renderer has no path to the Wails
// runtime, so a native file picker is reached through this method over the
// same WebSocket as everything else.
//
// The service is often absent. The dev-web harness has no Wails at all, and
// that is the configuration the app is developed and tested in. Absence is
// reported as a JSON-RPC -32601 error, which the renderer treats as "type the
// path by hand" rather than as a failure.
//
// # Cancellation — the platform adapter contract
//
// OpenFile receives the connection's context, and an adapter MAY observe
// ctx.Done and dismiss its dialog where the native API allows it. Where the
// native API does not allow it (the Wails runtime's OpenFileDialog cannot be
// cancelled once shown), the adapter MUST return normally, and the transport
// then keeps the capability busy — refusing every dialog.openFile from any
// connection — until the adapter actually returns. The transport never
// assumes a prompt return from a cancelled context, and an adapter must never
// assume its ctx will be cancelled at all.
type DialogService interface {
	// OpenFile opens the platform file picker and returns the chosen
	// ABSOLUTE path, or "" when the user cancelled. The runtime's own error
	// is returned as-is. The context may be cancelled on disconnect; see
	// the cancellation contract above.
	OpenFile(ctx context.Context) (string, error)
}

// dialogService is set post-construction: the Wails context it needs only
// exists inside WailsApp.startup (main.go), which runs after the transport is
// built. The handler may be reading it while startup assigns it, so the field
// is mutex-guarded.
func (s *WSServer) SetDialogService(ds DialogService) {
	s.dialogMu.Lock()
	defer s.dialogMu.Unlock()
	s.dialogService = ds
}

func (s *WSServer) handleDialogOpenFile(ctx context.Context, wconn Responder, req jsonrpcRequest) {
	s.dialogMu.RLock()
	ds := s.dialogService
	s.dialogMu.RUnlock()

	if ds == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "dialog not available"})
		return
	}

	// The dialog runs OFF the read loop under the dialog admission
	// (ws_control.go): a native picker can stay open for minutes, and it
	// must not freeze the socket. The task context derives from the
	// connection context so a disconnect cancels a cancel-aware adapter;
	// a NON-cooperative adapter (the real Wails runtime cannot cancel the
	// picker — see DialogService.OpenFile) keeps the admission permit
	// until it actually returns, and that held permit is what refuses a
	// second dialog.openFile from any connection: no second picker ever
	// stacks over the first. A refused submit answers the control-saturated
	// error; a dead socket's response is dropped by the Responder.
	tctx, _, release, ok := s.inflight.begin(ctx)
	if !ok {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: "server shutting down"})
		return
	}
	rej := s.dialogSub.TrySubmit(tctx, control.Task{Run: func(pctx context.Context) {
		defer release()
		path, err := ds.OpenFile(pctx)
		if err != nil {
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "dialog.openFile: ", err))
			return
		}
		resp := struct {
			Path string `json:"path"`
		}{Path: path}
		_ = wconn.TryResult(req.ID, mustMarshal(resp))
	}})
	if rej != nil {
		release()
		_ = wconn.TryError(req.ID, saturationRPCError(rej))
	}
}
