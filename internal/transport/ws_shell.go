package transport

// shell.integrate — the in-band bootstrap plan for the shell at a trusted
// prompt (spec §4.4, nocx-ynsx). The renderer alone may call it, gated on
// PROMPT_READY && trusted && owned: consent changes authorisation, not the
// identity of the foreground process, so the backend never offers this on
// its own. This file serves the plan from the shellintegration seam.

import (
	"context"
	"encoding/json"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/completion"
	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/shellintegration"
	"github.com/shady2k/nocx/internal/transport/control"
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

// sessionShellHandlers answers shell.complete and shell.integrate. Both are
// per-session operations (SessionOperation via ForSession) whose registry
// liveness check runs inside the capability; the completion and integration
// logic itself stays in the handler, on the completion / in-band seams. It
// holds the operation factory, the Responder and its seams — never the
// *WSServer.
type sessionShellHandlers struct {
	ops    *capability.SessionOperations // session gate; nil → session store not wired
	r      Responder
	local  completion.Completer // shell.complete for KindLocal sessions
	remote completion.Completer // shell.complete for KindRemote sessions
	inBand InBandBootstrapper   // shell.integrate plan builder
}

// handleIntegrate serves the shell.integrate method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.integrate","params":{"sessionId":"0123456789abcdef0123456789abcdef"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"wrapper":"saved=$(stty -g); …","payload":"# nocx in-band integration — dispatcher…","terminator":"NOCX_IB_EOF"}}
//
// The session id is server-authoritative (AD-7): the session must be live in
// the registry or the plan is refused, so a stale or forged id can never
// anchor NOCX_SESSION_ID in a payload typed into a shell.
func (h sessionShellHandlers) handleIntegrate(ctx context.Context, req jsonrpcRequest) {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.SessionID == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: sessionId required"})
		return
	}
	sid := session.ID(params.SessionID)
	op, err := h.ops.ForSession(sid)
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
		return
	}
	err = op.Run(ctx, func(ctx context.Context, svc capability.SessionService) error {
		if _, getErr := svc.Get(sid); getErr != nil {
			// The session closed between ForSession and the run: same
			// refusal as a session the registry never held.
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
			return nil
		}
		if h.inBand == nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "shell.integrate: in-band bootstrap not available"})
			return nil
		}
		plan, planErr := h.inBand.InBandBootstrap(params.SessionID)
		if planErr != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "shell.integrate: ", planErr))
			return nil
		}
		result := shellIntegrateResult{
			Wrapper:    plan.Wrapper,
			Payload:    plan.Payload,
			Terminator: plan.Terminator,
		}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// shellSpecs declares the shell-plane control methods (migration map, "The
// rest"): shell.complete and shell.integrate run under the per-session
// SessionOperation (the session gate — the registry liveness check is the
// capability's) and register on the operation queue; the launcher /
// footprint methods are seam handlers on the ordinary lane under no
// operation, holding only the seams the migration map names. The
// SessionOperations factory is built here from the wired stores and shared
// across the shell methods.
func (s *WSServer) shellSpecs(lane control.Admission, sessionGate control.Admission) []methodSpec {
	sessionOps := capability.NewSessionOperations(sessionGate, lane, s.registry, s.profileUsage)
	shellSub := s.operationQueue("shell")
	return []methodSpec{
		regResponder(shellSub, "shell.complete", func(r Responder) handlerFunc {
			h := sessionShellHandlers{ops: sessionOps, r: r, local: s.localCompleter, remote: s.sshCompleter}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleComplete(ctx, req) }
		}),
		regResponder(shellSub, "shell.integrate", func(r Responder) handlerFunc {
			h := sessionShellHandlers{ops: sessionOps, r: r, inBand: s.inBand}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleIntegrate(ctx, req) }
		}),
		regResponder(s.lane, "shell.launcherCommand", func(r Responder) handlerFunc {
			h := launcherHandlers{
				ops: sessionOps, r: r,
				stager:     s.launcherStager,
				facts:      s.installedFacts,
				launcher:   s.remoteLauncher,
				sshCfg:     s.sshConfigResolver,
				attempts:   &s.launcherAttempts,
				attemptsMu: &s.launcherAttemptsMu,
				log:        s.log,
			}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleLauncherCommand(ctx, req) }
		}),
		regResponder(s.lane, "shell.environmentObserved", func(r Responder) handlerFunc {
			h := launcherHandlers{
				ops: sessionOps, r: r,
				facts:      s.installedFacts,
				attempts:   &s.launcherAttempts,
				attemptsMu: &s.launcherAttemptsMu,
				log:        s.log,
			}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleEnvironmentObserved(ctx, req) }
		}),
		regResponder(s.lane, "shell.footprint.status", func(r Responder) handlerFunc {
			h := footprintHandlers{
				r:        r,
				facts:    s.installedFacts,
				resolver: s.resolver,
				sshCfg:   s.sshConfigResolver,
				profiles: s.profiles,
			}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleFootprintStatus(ctx, req) }
		}),
		regResponder(s.lane, "shell.footprint.uninstall", func(r Responder) handlerFunc {
			h := footprintHandlers{
				r:           r,
				uninstaller: s.remoteUninstaller,
				resolver:    s.resolver,
				log:         s.log,
			}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleFootprintUninstall(ctx, req) }
		}),
	}
}
