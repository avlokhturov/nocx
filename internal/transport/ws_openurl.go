package transport

import (
	"context"
	"encoding/json"
	"net/url"
)

// UrlOpener opens a URL in the platform's default browser on behalf of the
// renderer. It is a control-plane capability (AD-1): the renderer has no
// path to the Wails runtime, so "open on its hosting" (brief, nocx-hc0m) is
// reached through this method over the same WebSocket as everything else.
//
// The service is often absent — the dev-web harness has no Wails at all —
// and absence is reported as a JSON-RPC -32601 error, which the renderer
// surfaces as a toast rather than as a silent no-op.
//
// Unlike files.reveal (D4), this capability is NOT local-only, and the
// difference is deliberate and written down: files.reveal operates on a
// PATH, and a path from an SSH binding refers to a file on the remote host
// that the local file manager cannot reveal — the attestation is what tells
// the transport the path is not local. Opening a URL has no path semantics:
// the string is a web address, equally valid whether the repository it was
// derived from lives on this machine or on the relay's. The only producer
// today is the git panel, which git.open already refuses for SSH sessions
// (D3), so in practice the URL is local-derived anyway — but the capability
// itself carries no local-only meaning, and the relay (nocx-if6) must be
// able to reuse it without inheriting a guard this method does not need.
type UrlOpener interface {
	// OpenURL opens the URL in the default browser. The transport has
	// already refused anything that is not an http(s) URL; the service
	// itself may still fail (no browser, no runtime) and its error is
	// returned as-is.
	OpenURL(ctx context.Context, url string) error
}

// urlOpener is set post-construction: the Wails context it needs only exists
// inside WailsApp.startup (main.go), which runs after the transport is
// built. The handler may be reading it while startup assigns it, so the
// field is mutex-guarded, exactly like the dialog service.
func (s *WSServer) SetUrlOpener(uo UrlOpener) {
	s.urlMu.Lock()
	defer s.urlMu.Unlock()
	s.urlOpener = uo
}

type shellOpenUrlParams struct {
	URL string `json:"url"`
}

// handleShellOpenUrl opens one URL in the system browser. The URL is
// validated here, at the seam: only http(s) URLs with a host cross into the
// browser — a scheme the shell would happily open (file:, javascript:) is
// not a URL this panel may ever send a user to, and the renderer's
// conversion module only ever emits https for a recognised host. The result
// is the empty object, exactly like files.reveal.
func (s *WSServer) handleShellOpenUrl(ctx context.Context, wconn Responder, req jsonrpcRequest) {
	var params shellOpenUrlParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.URL == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: url required"})
		return
	}
	u, err := url.Parse(params.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: only http(s) URLs can be opened"})
		return
	}
	s.urlMu.RLock()
	uo := s.urlOpener
	s.urlMu.RUnlock()
	if uo == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "shell.openUrl not available"})
		return
	}
	if err := uo.OpenURL(ctx, u.String()); err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "shell.openUrl: ", err))
		return
	}
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}
