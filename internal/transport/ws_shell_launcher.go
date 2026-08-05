package transport

// shell.launcherCommand — stages the remote launcher for rewriting a
// hand-typed ssh invocation and returns its PATH (nocx-pu4.6). The renderer
// detects an interactive ssh login at submit time, calls this method, and
// builds a line whose LOCAL shell reads the file and hands the bytes to ssh
// through argv. The original line is recorded in history; the rewritten line
// goes to the PTY. Nothing is typed after submit (the whole in-band family's
// unsolvable safety problem).
//
// Why a path and not the launcher itself: the ShellAuto launcher is ~35 KB
// because it carries the bash, zsh and POSIX tiers, and a hand-typed ssh can
// only reach the shell through the tty, whose canonical line buffer is 4096
// bytes. Sending it inline truncated the payload mid-script and the shell
// executed the fragments. See internal/shellintegration/stage.go.

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
)

// LauncherStager puts the remote launcher where the LOCAL shell can read it
// and returns its absolute path. *shellintegration.fileStager satisfies it
// through shellintegration.NewLauncherStager — no adapter. When not wired,
// the rewrite is refused and the renderer sends the line the user typed.
type LauncherStager interface {
	Stage(launcher string) (string, error)
}

// WithLauncherStager attaches the launcher staging seam behind the
// shell.launcherCommand JSON-RPC method (nocx-pu4.6). Wired at the
// composition root, which is the only layer that knows the user's home
// directory; the transport never picks a filesystem location itself.
func WithLauncherStager(st LauncherStager) WSServerOption {
	return func(s *WSServer) { s.launcherStager = st }
}

// shellLauncherCommandResult is the result of shell.launcherCommand,
// matching contracts/shell.launcherCommand.schema.json exactly.
type shellLauncherCommandResult struct {
	LauncherPath *string `json:"launcherPath"`
	Reason       *string `json:"reason"`
}

// handleShellLauncherCommand serves the shell.launcherCommand method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.launcherCommand","params":{"destination":"pi@raspberrypi","sessionId":"0123456789abcdef0123456789abcdef"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"launcherPath":"'/home/u/.nocx/run/launcher-123'","reason":null}}
//
// The destination is whatever the renderer's ssh-transition parser
// extracted: user@host, host, or an IPv4 address. The session id is
// server-authoritative (AD-7): only a live session in the registry can
// anchor NOCX_SESSION_ID in the launcher command.
//
// Refusal reasons (launcherPath null, reason non-null):
//   - "remote-command": the destination's ssh config sets RemoteCommand
//     (ADR-0015, ssh -G oracle); our rewrite would be refused by sshd.
//   - "unsupported": the launcher cannot build a command (unsupported
//     shell, script too large, or no launcher wired).
//   - "stage-failed": the launcher could not be written where the local
//     shell can read it (no home, unwritable directory, full disk).
//
// Fail-open is the invariant (ADR-0004 §1): anything uncertain means
// launcherPath is null and the renderer sends the original line unchanged.
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

	// Both seams must be wired. Without either we cannot put a launcher
	// where the shell can read it; the renderer sends the original line.
	if s.remoteLauncher == nil || s.launcherStager == nil {
		s.refuseLauncherCommand(wconn, req, "unsupported")
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
			s.refuseLauncherCommand(wconn, req, "remote-command")
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
		s.refuseLauncherCommand(wconn, req, refusal)
		return
	}

	// Stage it. The renderer never sees the payload — only where to find
	// it — because the payload cannot cross the tty (stage.go).
	path, err := s.launcherStager.Stage(launcher)
	if err != nil {
		s.log.Warn("shell.launcherCommand: could not stage launcher", "error", err)
		s.refuseLauncherCommand(wconn, req, "stage-failed")
		return
	}

	// Shell-quote the path so the renderer can splice it into the line as
	// a single word. The staging directory is ours and the names are
	// generated, but a home directory with a quote or a space in it is an
	// ordinary thing and must not break the rewrite.
	quoted := shellQuote(path)
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
		LauncherPath: &quoted,
		Reason:       nil,
	})))
}

// refuseLauncherCommand answers with a stated refusal: no path, a reason the
// renderer can log, and an original line that goes to the pty unchanged.
func (s *WSServer) refuseLauncherCommand(wconn *wsConn, req jsonrpcRequest, reason string) {
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(shellLauncherCommandResult{
		LauncherPath: nil,
		Reason:       &reason,
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
// the transport for a 4-line function. What it quotes here is a filesystem
// path, where an embedded quote is rare but entirely legal, so the escaper
// is load-bearing rather than defensive.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
