package transport

// shell.launcherCommand — returns the remote launcher for rewriting a
// hand-typed ssh invocation (nocx-pu4.6). The renderer detects an
// interactive ssh login at submit time, calls this method to get the
// launcher command, and builds the rewritten `ssh -t host '<launcher>'`
// line. The original line is recorded in history; the rewritten line goes
// to the PTY. Nothing is typed after submit (the whole in-band family's
// unsolvable safety problem).

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
)

// shellLauncherCommandResult is the result of shell.launcherCommand,
// matching contracts/shell.launcherCommand.schema.json exactly.
type shellLauncherCommandResult struct {
	Launcher *string `json:"launcher"`
	Reason   *string `json:"reason"`
}

// handleShellLauncherCommand serves the shell.launcherCommand method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.launcherCommand","params":{"destination":"pi@raspberrypi","sessionId":"0123456789abcdef0123456789abcdef"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"launcher":"'/usr/bin/env ...'","reason":null}}
//
// The destination is whatever the renderer's ssh-transition parser
// extracted: user@host, host, or an IPv4 address. The session id is
// server-authoritative (AD-7): only a live session in the registry can
// anchor NOCX_SESSION_ID in the launcher command.
//
// Refusal reasons (launcher null, reason non-null):
//   - "remote-command": the destination's ssh config sets RemoteCommand
//     (ADR-0015, ssh -G oracle); our rewrite would be refused by sshd.
//   - "unsupported": the launcher cannot build a command (unsupported
//     shell, script too large, or no launcher wired).
//
// Fail-open is the invariant (ADR-0004 §1): anything uncertain means
// launcher is null and the renderer sends the original line unchanged.
func (s *WSServer) handleShellLauncherCommand(wconn *wsConn, req jsonrpcRequest) {
	var params struct {
		Destination string `json:"destination"`
		SessionID   string `json:"sessionId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Destination == "" || params.SessionID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: destination and sessionId required"))
		return
	}

	// Session id is server-authoritative (AD-7).
	sid := session.ID(params.SessionID)
	if _, err := s.registry.Get(sid); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: unknown sessionId"))
		return
	}

	// The launcher must be wired. Without it we cannot build a command; the
	// renderer sends the original line unchanged.
	if s.remoteLauncher == nil {
		reason := "unsupported"
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
			Launcher: nil,
			Reason:   &reason,
		})))
		return
	}

	// Resolve the destination through ssh -G (ADR-0015): if the host's
	// config sets RemoteCommand, OpenSSH refuses a command-line command
	// alongside it, and our rewrite would be rejected. Ask the oracle;
	// do not guess.
	if s.sshConfigResolver != nil {
		host, _ := splitUserHost(params.Destination)
		hostCfg, err := s.sshConfigResolver.ResolveConfig(context.Background(), host)
		if err == nil && hostCfg != nil && hostCfg.RemoteCommand != "" {
			reason := "remote-command"
			_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
				Launcher: nil,
				Reason:   &reason,
			})))
			return
		}
	}

	// Build the launcher command for auto-detection: the dispatcher
	// picks bash, zsh or POSIX on the far host (nocx-6rj0).
	launcher, reason, ok := s.remoteLauncher.StartCommand(ssh.ShellAuto, ssh.LaunchOptions{
		SessionID: params.SessionID,
		Enhanced:  true,
	})
	if !ok {
		refusal := string(reason)
		if refusal == "" {
			refusal = "unsupported"
		}
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
			Launcher: nil,
			Reason:   &refusal,
		})))
		return
	}

	// Shell-quote the launcher so the renderer can safely append it as a
	// single argument to the ssh command. Even though the launcher strings
	// are built quote-free by construction, shellQuote is correct for any
	// future payload change that introduces a quote.
	quoted := shellQuote(launcher)
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
		Launcher: &quoted,
		Reason:   nil,
	})))
}

// splitUserHost separates user@host into user and host. Returns the
// original string as host when there is no @.
func splitUserHost(dest string) (host, user string) {
	if idx := strings.LastIndex(dest, "@"); idx >= 0 {
		return dest[idx+1:], dest[:idx]
	}
	return dest, ""
}

// shellQuote wraps s in single quotes, escaping embedded quotes with the
// POSIX '\” idiom — the same function in internal/shellintegration. We
// duplicate it here to avoid adding a dependency on shellintegration from
// the transport for a 4-line function. The launcher strings are built
// quote-free by construction, so this is usually the identity; the
// duplication exists because integration-testing the two copies is cheaper
// than importing a package for one function that almost never fires.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
