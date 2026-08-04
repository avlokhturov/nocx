package completion

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

//go:embed scripts/nocx_complete.bash
var completionScript string

// ExecConn is the minimal surface the SSH completer needs from a
// DiscoveryConn lease. internal/ssh.DiscoveryConn satisfies it.
type ExecConn interface {
	Exec(ctx context.Context, cmd string) (*ExecResult, error)
	Close() error
}

// ExecResult mirrors ssh.ExecResult so the completion package does not
// import internal/ssh.
type ExecResult struct {
	Stdout     []byte
	Stderr     []byte
	ExitStatus int
	Truncated  bool
}

// ExecConnProvider creates an ExecConn for the given host. The composition
// root wires a function that calls sshClient.DiscoveryConn.
type ExecConnProvider func(ctx context.Context, host string) (ExecConn, error)

// SSHCompleter runs completion on a remote host through a second shell —
// the DiscoveryConn lane of ADR-0020. The user's line is never touched;
// no keystroke is ever forwarded (ADR-0004 §2).
type SSHCompleter struct {
	provider     ExecConnProvider
	generateRand func() (string, error) // nonce generator; crypto/rand by default
}

func NewSSH(provider ExecConnProvider) *SSHCompleter {
	return &SSHCompleter{
		provider:     provider,
		generateRand: defaultGenerateRand,
	}
}

// NewSSHWithRand is for tests: it pins the nonce generator so the response
// framing is deterministic.
func NewSSHWithRand(provider ExecConnProvider, randFn func() (string, error)) *SSHCompleter {
	return &SSHCompleter{provider: provider, generateRand: randFn}
}

func defaultGenerateRand() (string, error) {
	var b [4]byte
	_, err := rand.Read(b[:])
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// maxCompletionCmdLen caps the remote completion command. A script that
// outgrows the cap must refuse rather than emit a command the far host
// cannot exec. 32 KiB matches the launcher's own cap.
const maxCompletionCmdLen = 32 * 1024

// Complete implements Completer for a remote bash host.
//
// It builds a bash command that runs the embedded completion script via
// a quoted heredoc — no temp file, no printf escaping, and the heredoc
// delimiter carries the nonce so it is unique per request. Results are
// framed with the same nonce so a banner-polluted answer is rejected
// whole.
func (c *SSHCompleter) Complete(ctx context.Context, req Request) (*Response, error) {
	if err := ctx.Err(); err != nil {
		return emptyResponse("cancelled"), nil
	}

	conn, err := c.provider(ctx, req.Host)
	if err != nil {
		return nil, fmt.Errorf("completion lease: %w", err)
	}
	defer func() { _ = conn.Close() }()

	nonce, err := c.generateRand()
	if err != nil {
		return emptyResponse("completion unavailable"), nil
	}
	limit := req.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	cmd := buildRemoteCommand(req.Cwd, req.Line, req.Pos, limit, nonce)
	if len(cmd) > maxCompletionCmdLen {
		return emptyResponse("completion script too large"), nil
	}

	result, err := conn.Exec(ctx, cmd)
	if err != nil {
		return classifyExecError(err), nil
	}

	return parseCompletionOutput(result.Stdout, nonce, limit), nil
}

// buildRemoteCommand constructs the bash command sent to the remote host.
// The command pipes the embedded script via a quoted heredoc — the
// delimiter includes the nonce so it cannot collide with the script
// content, and the quoted delimiter suppresses shell expansion so the
// script body is delivered verbatim.
func buildRemoteCommand(cwd, line string, pos, limit int, nonce string) string {
	delim := "NOCXEOF_" + nonce
	return fmt.Sprintf(
		"bash -s -- %s %s %d %d %s << '%s'\n%s\n%s\n",
		shellQuote(cwd),
		shellQuote(line),
		pos,
		limit,
		shellQuote(nonce),
		delim,
		completionScript,
		delim,
	)
}

// shellQuote wraps s in single quotes, escaping embedded single quotes
// with the POSIX '\” idiom.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// parseCompletionOutput extracts candidates from the framed response.
// A response whose nonce markers are missing or mismatched is rejected
// whole — a banner-polluted answer must never be half-parsed.
func parseCompletionOutput(stdout []byte, nonce string, limit int) *Response {
	startMarker := "NONCE:" + nonce + ":START"
	endMarker := "NONCE:" + nonce + ":END"

	scanner := bufio.NewScanner(bytes.NewReader(stdout))
	inPayload := false
	seenEnd := false
	var candidates []Candidate
	truncated := false

	for scanner.Scan() {
		line := scanner.Text()
		if line == startMarker {
			inPayload = true
			continue
		}
		if line == endMarker {
			inPayload = false
			seenEnd = true
			break
		}
		if !inPayload {
			continue
		}
		// Parse TSV: source <TAB> name [<TAB> path <TAB> isDir]
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		source := parts[0]
		name := parts[1]
		c := Candidate{Name: name, Source: source}
		if source == "path" && len(parts) >= 4 {
			c.Path = parts[2]
			c.IsDir = parts[3] == "1"
		}
		candidates = append(candidates, c)
		if len(candidates) >= limit*2 {
			truncated = true
			break
		}
	}

	// No END marker after START: the output is incomplete or polluted.
	if !seenEnd && inPayload {
		truncated = true
	}
	// Never saw START at all: the response is polluted by a banner.
	// Reject whole rather than parsing what looks plausible.

	if len(candidates) == 0 && !truncated {
		return emptyResponse("")
	}
	return &Response{Candidates: candidates, Truncated: truncated}
}

// classifyExecError maps known SSH exec errors to a soft response. The
// dropdown must never show a spinner that never resolves; every failure
// path surfaces a stated reason.
func classifyExecError(err error) *Response {
	switch {
	case errors.Is(err, context.Canceled):
		return emptyResponse("cancelled")
	case errors.Is(err, context.DeadlineExceeded):
		return emptyResponse("timed out")
	default:
		msg := err.Error()
		if strings.Contains(msg, "exec request refused") {
			return emptyResponse("remote host refused completion exec")
		}
		if strings.Contains(msg, "additional exec session refused") {
			return emptyResponse("remote host limits sessions; completion unavailable")
		}
		if strings.Contains(msg, "exec connection lost") {
			return emptyResponse("connection lost during completion")
		}
		return emptyResponse("completion unavailable: " + strconv.Quote(msg))
	}
}
