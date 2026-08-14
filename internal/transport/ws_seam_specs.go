package transport

// seamSpecs — the seam-backed control methods as constructed types
// (migration map, "Seam handlers"): connections.test, connections.trustHostKey,
// dialog.openFile, sshConfig.aliases/path, sessions.status, fs.complete,
// tunnel.open/stop, ports.status/sample/pause/visible and shell.openUrl. Each
// handler holds only its seams — the resolver holder, prober, dialog service
// holder, tunnel ledger, discovery scheduler, url opener holder — and its
// Responder; never the *WSServer, so a handler cannot reach a store it was
// not constructed with. The seams are built here from the transport's fields,
// once per server, and shared across the methods of their domain.

import (
	"context"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/transport/control"
)

func (s *WSServer) seamSpecs(lane control.Admission, sessionGate control.Admission) []methodSpec {
	// Seams shared across the methods of their domain. The holders point at
	// the WSServer's own fields: the dialog and url services are assigned
	// post-construction (SetDialogService / SetUrlOpener) while handlers may
	// be reading them, and the tunnel ledger is the same maps that tab
	// teardown and stored-forward replay use — one state, several narrow
	// holders.
	dialog := &dialogServiceHolder{mu: &s.dialogMu, svc: &s.dialogService}
	opener := &urlOpenerHolder{mu: &s.urlMu, svc: &s.urlOpener}
	ledger := &tunnelLedger{mu: &s.tunnelMu, tunnels: &s.tunnels, owners: &s.ownerTunnels}

	// sessions.status is the one capability-gated method here: a whole-domain
	// SessionOperation over the session gate (migration map).
	sessionOp := capability.NewSessionOperation(sessionGate, lane, s.registry, s.profileUsage)
	statusSub := s.operationQueue("sessions-status")

	return []methodSpec{
		// connections.test owns its own admission (probe capacity-one
		// composed with the lane, wrapped in the inflight set) — the
		// registration IS that submission, so the probe acquires the lane
		// exactly once.
		regResponder(s.probeSub, "connections.test", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := probeHandlers{
				resolver:         s.resolver,
				prober:           s.prober,
				probeResultStore: s.probeResultStore,
				r:                r,
			}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleConnectionsTest(ctx, req) }
		}),
		regResponder(s.lane, "connections.trustHostKey", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := trustHostKeyHandlers{truster: s.hostKeyTruster, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleConnectionsTrustHostKey(ctx, req) }
		}),
		// dialog.openFile owns its own admission (dialog capacity-one
		// composed with the lane, wrapped in the inflight set).
		regResponder(s.dialogSub, "dialog.openFile", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := dialogHandlers{dialog: dialog, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleDialogOpenFile(ctx, req) }
		}),
		regResponder(s.lane, "sshConfig.aliases", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := sshConfigHandlers{resolver: s.sshConfigResolver, path: s.sshConfigPath, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSSHConfigAliases(ctx, req) }
		}),
		regResponder(s.lane, "sshConfig.path", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := sshConfigHandlers{resolver: s.sshConfigResolver, path: s.sshConfigPath, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSSHConfigPath(ctx, req) }
		}),
		regResponder(statusSub, "sessions.status", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := sessionsStatusHandlers{op: sessionOp, log: s.log, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSessionsStatus(ctx, req) }
		}),
		regResponder(s.lane, "fs.complete", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := fsCompleteHandlers{r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleFsComplete(req) }
		}),
		// tunnel.open needs the connection as the owner-map key (spec §7.3):
		// the forward's owner is the tab that opened it, so the handler
		// receives the *wsConn per call.
		reg(s.lane, "tunnel.open", genericObject("per-field validation pending nocx-VALID"), func(w *wsConn, state *connState) handlerFunc {
			h := tunnelHandlers{resolver: s.resolver, connector: s.tunnelConnector, ledger: ledger, r: w}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleTunnelOpen(ctx, w, req) }
		}),
		regResponder(s.lane, "tunnel.stop", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := tunnelHandlers{resolver: s.resolver, connector: s.tunnelConnector, ledger: ledger, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleTunnelStop(req) }
		}),
		regResponder(s.lane, "ports.status", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := portsHandlers{sched: s.discoverySched, ledger: ledger, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handlePortsMethod(req) }
		}),
		regResponder(s.lane, "ports.sample", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := portsHandlers{sched: s.discoverySched, ledger: ledger, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handlePortsMethod(req) }
		}),
		regResponder(s.lane, "ports.pause", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := portsHandlers{sched: s.discoverySched, ledger: ledger, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handlePortsMethod(req) }
		}),
		regResponder(s.lane, "ports.visible", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := portsHandlers{sched: s.discoverySched, ledger: ledger, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handlePortsMethod(req) }
		}),
		regResponder(s.lane, "shell.openUrl", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := openUrlHandlers{opener: opener, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleShellOpenUrl(ctx, req) }
		}),
	}
}
