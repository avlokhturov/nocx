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
//
// ch is the authenticated-channel configuration (lane, domain, epoch and the
// loopback port the kernel's transport listens on), minted by whoever set up
// the domain; nil builds a capability-free plan (conventional shell). The
// capability is never an argument and never crosses this seam's results.
type InBandBootstrapper interface {
	InBandBootstrap(sessionID string, ch *shellintegration.ChannelConfig) (shellintegration.InBandPlan, error)
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
// wrapper at the trusted prompt; the backend writes the capability line and
// the payload into the pty once READY arrives (the renderer never holds the
// capability — ADR-0024 decision 7). The terminator is sent alone to cancel.
//
// The capability deliberately has NO representation here: the result is
// built field-by-field from the plan and InBandPlan.Capability is never
// copied, so the per-epoch bearer cannot cross the WebSocket. The contract
// test in ws_shell_test.go proves it.
type shellIntegrateResult struct {
	Wrapper    string `json:"wrapper"`
	Payload    string `json:"payload"`
	Terminator string `json:"terminator"`
}

// shellIntegrateResultFromPlan copies exactly the three renderer-visible
// fields. InBandPlan.Capability is deliberately NOT copied: the per-epoch
// bearer is the backend's to write into the pty after READY, and this copy
// is the renderer boundary (ADR-0024 decision 7). The contract test in
// ws_shell_test.go proves a capability set on the plan never reaches the
// marshaled result.
func shellIntegrateResultFromPlan(plan shellintegration.InBandPlan) shellIntegrateResult {
	return shellIntegrateResult{
		Wrapper:    plan.Wrapper,
		Payload:    plan.Payload,
		Terminator: plan.Terminator,
	}
}

// handleShellIntegrate serves the shell.integrate method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.integrate","params":{"sessionId":"0123456789abcdef0123456789abcdef"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"wrapper":"saved=$(stty -g); …","payload":"# nocx in-band integration — dispatcher…","terminator":"NOCX_IB_EOF"}}
//
// The session id is server-authoritative (AD-7): the session must be live in
// the registry or the plan is refused, so a stale or forged id can never
// anchor NOCX_SESSION_ID in a payload typed into a shell.
//
// The channel configuration is not available at this layer today (the domain
// minting and the transport listener are the composition root's wiring), so
// the plan is built capability-free — a conventional shell. The wiring that
// mints the domain passes the config here and writes the capability line
// into the pty after READY; neither step ever routes the capability through
// this result.
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
	plan, err := s.inBand.InBandBootstrap(params.SessionID, nil)
	if err != nil {
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "shell.integrate: ", err))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellIntegrateResultFromPlan(plan))))
}
