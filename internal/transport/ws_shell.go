package transport

// shell.integrate — the in-band bootstrap plan for the shell at a trusted
// prompt (spec §4.4, nocx-ynsx). The renderer alone may call it, gated on
// PROMPT_READY && trusted && owned: consent changes authorisation, not the
// identity of the foreground process, so the backend never offers this on
// its own. This file serves the plan from the shellintegration seam.

import (
	"encoding/json"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/shellintegration"
)

// InBandBootstrapper builds the in-band integration plan for a live session.
// *shellintegration.Impl satisfies it with identical signatures — no
// adapter. When not wired, shell.integrate returns a JSON-RPC error; the
// transport never constructs the capability itself.
type InBandBootstrapper interface {
	InBandBootstrap(sessionID string) (shellintegration.InBandPlan, error)
}

// WithInBandBootstrapper attaches the in-band bootstrap builder behind the
// shell.integrate JSON-RPC method (nocx-ynsx). The single implementation is
// *shellintegration.Impl, wired at the composition root so the payload the
// renderer streams carries the session id the registry minted (AD-7).
func WithInBandBootstrapper(b InBandBootstrapper) WSServerOption {
	return func(s *WSServer) { s.inBand = b }
}

// shellIntegrateResult is the result of shell.integrate, matching
// contracts/shell.integrate.schema.json exactly. The renderer types the
// wrapper at the trusted prompt, streams the payload through the raw-mode
// window once READY arrives, and appends the terminator — or sends it alone
// to cancel.
type shellIntegrateResult struct {
	Wrapper    string `json:"wrapper"`
	Payload    string `json:"payload"`
	Terminator string `json:"terminator"`
}

// handleShellIntegrate serves the shell.integrate method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.integrate","params":{"sessionId":"0123456789abcdef0123456789abcdef"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"wrapper":"saved=$(stty -g); …","payload":"# nocx in-band integration — dispatcher…","terminator":"NOCX_IB_EOF"}}
//
// The session id is server-authoritative (AD-7): the session must be live in
// the registry or the plan is refused, so a stale or forged id can never
// anchor NOCX_SESSION_ID in a payload typed into a shell.
func (s *WSServer) handleShellIntegrate(wconn *wsConn, req jsonrpcRequest) {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.SessionID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: sessionId required"))
		return
	}
	sid := session.ID(params.SessionID)
	if _, err := s.registry.Get(sid); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: unknown sessionId"))
		return
	}
	if s.inBand == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "shell.integrate: in-band bootstrap not available"))
		return
	}
	plan, err := s.inBand.InBandBootstrap(params.SessionID)
	if err != nil {
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "shell.integrate: ", err))
		return
	}
	result := shellIntegrateResult{
		Wrapper:    plan.Wrapper,
		Payload:    plan.Payload,
		Terminator: plan.Terminator,
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}
