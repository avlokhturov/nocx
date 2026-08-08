package transport

// shell.launcherCommand — the delivery planner's decision, made once per
// attempt, of which line to send for a hand-typed ssh invocation
// (2026-08-05 delivery-modes design §3, §5.3). The renderer detects an
// interactive ssh login at submit time, calls this method with the plan P4's
// parser built, and drives P2's tracker with the minted environment id
// BEFORE the bytes leave. Nothing is typed after submit.
//
// The planner mints a FRESH environment id per attempt — never the tab
// session id, which is stable and would make two attempts from one tab
// indistinguishable — and returns it in the result. The renderer registers
// it as expected before the line reaches the pty; the launcher echoes it in
// the passport; the tracker accepts only that id.
//
// Two forms of rewrite, decided here:
//
//   - "bootstrap" (§3.2): the host has no committed bundle. The launcher is
//     staged in a local file (the canonical tty line is capped at 4096
//     bytes; the payload cannot cross it) and the renderer builds a line
//     whose local shell reads the file and hands the bytes to ssh through
//     argv. The launcher embeds NOCX_ENVIRONMENT_ID (minted here) and
//     NOCX_SESSION_ID (the session id, AD-7), publishes the bundle on the
//     far host, and emits the passport.
//   - "installed" (§3.3): the installed fact says the host has a committed,
//     protocol-compatible generation. The renderer builds the compact
//     guard-travelling line, passing the environment id (and the session id)
//     as the launch carrier's arguments. No launcher is staged and nothing
//     is written locally.
//
// Anything uncertain is "raw": launcherPath null, reason non-null, and the
// renderer sends the line the user typed unchanged — fail-open is the
// invariant (ADR-0004 §1). A failed or unavailable oracle refuses the
// rewrite (nocx-qwhp); it never rewrites on a guess.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/shellintegration"
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

// WithInstalledFactStore attaches the backend-owned, persisted installed
// fact (§5.4): the memory that makes the second connection to a host
// cheaper than the first. When not wired, every host bootstraps and
// observations are logged but never recorded.
func WithInstalledFactStore(store *ssh.InstalledFactStore) WSServerOption {
	return func(s *WSServer) { s.installedFacts = store }
}

// shellLauncherCommandResult is the result of shell.launcherCommand,
// matching contracts/shell.launcherCommand.schema.json exactly.
type shellLauncherCommandResult struct {
	// Mode is the planner's decision: "bootstrap" (stage a launcher),
	// "installed" (compact line, no staging) or "raw" (no rewrite).
	Mode string `json:"mode"`
	// EnvironmentID is the fresh id minted for THIS attempt — never the
	// tab session id. The renderer registers it as expected before the
	// line reaches the pty.
	EnvironmentID string `json:"environmentId"`
	// LauncherPath is the shell-quoted staged path; non-null only when
	// mode is "bootstrap".
	LauncherPath *string `json:"launcherPath"`
	// Reason is why the rewrite was refused; non-null only when mode is
	// "raw".
	Reason *string `json:"reason"`
}

const (
	launcherModeBootstrap = "bootstrap"
	launcherModeInstalled = "installed"
	launcherModeRaw       = "raw"
)

// The expected delivery of a minted attempt, recorded so the observation
// handler knows whether a missing passport must invalidate the installed
// fact (§5.4): only a connection that expected installed-script does.
const (
	attemptExpectedBootstrap = "bootstrap-script"
	attemptExpectedInstalled = "installed-script"
	attemptExpectedRaw       = "raw"
)

// launchAttempt is the backend-side record for one minted environment id:
// the binding between the id the renderer saw and the resolved identity and
// expected delivery the observation handler needs. A passport can arrive
// immediately after the result, so registration happens under the registry
// lock and consumption is idempotent.
type launchAttempt struct {
	environmentID string
	identity      string // resolved identity key (ssh.IdentityKey)
	expected      string // attemptExpected* the rewritten line should produce
	consumed      bool   // an observation already decided this attempt
	mintedAt      time.Time
}

// maxLaunchAttempts bounds the idempotency registry. A dropped entry only
// loses a no-passport invalidation for a very old attempt — the next
// connection bootstraps, which is the safe direction.
const maxLaunchAttempts = 1024

// expectedInstalledProtocol is the manifest protocol the planner requires
// of an installed fact before choosing the compact line: the current
// protocol of the bundle this product ships, spelled the way the passport
// carries it (a string, not an int — §5.2's wire form).
var expectedInstalledProtocol = strconv.Itoa(shellintegration.ProtocolVersion)

// mintEnvironmentID returns a fresh attempt id in the passport charset
// [A-Za-z0-9._-]{1,64} (16 random bytes, hex). Entropy failure is
// unrecoverable in practice; the caller refuses the rewrite.
func mintEnvironmentID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// validOracleArgv rejects a params oracleArgv that is not the ssh -G oracle
// shape the renderer's plan builds: ["ssh", "-G", ...options, destination].
// A violation is a renderer bug, refused loudly as a protocol error.
func validOracleArgv(argv []string) bool {
	return len(argv) >= 3 && filepath.Base(argv[0]) == "ssh" && argv[1] == "-G"
}

// oracleDestination is the destination positional of an oracle argv — the
// last element. It is the ONLY user-derived text the delivery-path log
// carries: no command, no options, no config values beyond the destination.
func oracleDestination(argv []string) string {
	return argv[len(argv)-1]
}

// handleShellLauncherCommand serves the shell.launcherCommand method.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"shell.launcherCommand","params":{"sessionId":"0123…","oracleArgv":["ssh","-G","-p","2222","pi@host"]}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"mode":"bootstrap","environmentId":"…","launcherPath":"'/home/u/.nocx/run/launcher-123'","reason":null}}
//
// oracleArgv is plan.oracleArgv verbatim — the complete argv of the oracle
// for the line the user actually typed (P4's SshPlan), so the typed
// -F/-o/-J/-l/-p reach ssh -G (nocx-c5az) and the installed-fact key is the
// resolved identity of THAT argv, not of a bare hostname (ADR-0015
// narrowed). sessionId is server-authoritative (AD-7): only a live session
// in the registry can anchor NOCX_SESSION_ID in the launcher command.
//
// Refusal reasons (mode "raw", reason non-null):
//   - "oracle-failed": the ssh -G oracle is missing, timed out or failed —
//     a rewrite built without the oracle's answer is a guess, and fail-open
//     sends the typed bytes (nocx-qwhp).
//   - "remote-command": the resolved config sets RemoteCommand (ADR-0015);
//     our rewrite would be refused by sshd.
//   - "unsupported": the launcher cannot build a command (unsupported
//     shell, script too large, no launcher or stager wired, or the
//     environment id could not be minted).
//   - "stage-failed": the launcher could not be written where the local
//     shell can read it (no home, unwritable directory, full disk).
func (s *WSServer) handleShellLauncherCommand(wconn Responder, req jsonrpcRequest) {
	var params struct {
		SessionID  string   `json:"sessionId"`
		OracleArgv []string `json:"oracleArgv"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.SessionID == "" || !validOracleArgv(params.OracleArgv) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: sessionId and a well-formed oracleArgv required"})
		return
	}

	// Session id is server-authoritative (AD-7).
	if _, err := s.registry.Get(session.ID(params.SessionID)); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: unknown sessionId"})
		return
	}

	// A fresh environment id per attempt (§5.3). Minted before any
	// decision so every result — including every refusal — carries one.
	envID, err := mintEnvironmentID()
	if err != nil {
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"mode", launcherModeRaw, "reason", "unsupported")
		s.refuseLauncherCommand(wconn, req, envID, "unsupported")
		return
	}
	s.log.Info("shell.launcherCommand called",
		"destination", oracleDestination(params.OracleArgv),
		"environmentId", envID)

	// The oracle is mandatory and its failure refuses the rewrite
	// (nocx-qwhp). A missing resolver is a failed oracle, not a silent
	// bypass: without ssh -G's answer there is no basis for a rewrite.
	if s.sshConfigResolver == nil {
		s.log.Info("shell.launcherCommand oracle verdict",
			"destination", oracleDestination(params.OracleArgv),
			"ok", false, "reason", "oracle-failed")
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", "oracle-failed")
		s.refuseLauncherCommand(wconn, req, envID, "oracle-failed")
		return
	}
	cfg, err := s.sshConfigResolver.ResolveArgv(context.Background(), params.OracleArgv)
	if err != nil {
		// The verdict is typed fields only: the refusal reason as a value,
		// never the argv or the oracle's stderr — those can carry command
		// and config text this log must not repeat.
		s.log.Info("shell.launcherCommand oracle verdict",
			"destination", oracleDestination(params.OracleArgv),
			"ok", false, "reason", "oracle-failed")
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", "oracle-failed")
		s.refuseLauncherCommand(wconn, req, envID, "oracle-failed")
		return
	}
	identity := ssh.IdentityKey(cfg)
	s.log.Info("shell.launcherCommand oracle verdict",
		"destination", oracleDestination(params.OracleArgv),
		"ok", true,
		"identity", identity,
		"remoteCommand", cfg.RemoteCommand != "")

	// A RemoteCommand configured for the destination wins outright:
	// OpenSSH refuses a command-line command alongside it, so no rewrite
	// (ADR-0015).
	if cfg.RemoteCommand != "" {
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", "remote-command",
			"identity", identity)
		s.refuseLauncherCommand(wconn, req, envID, "remote-command")
		return
	}

	// The installed fact decides the form: the compact line only when the
	// host has a committed, protocol-compatible generation; anything else
	// bootstraps (§3.2/§3.3). The fact is keyed by the RESOLVED identity,
	// so a host reached through two different argv spellings shares one
	// memory.
	if s.installedFacts != nil {
		if fact, ok := s.installedFacts.Get(identity); ok && fact.Protocol == expectedInstalledProtocol {
			s.log.Info("shell.launcherCommand mode decided",
				"destination", oracleDestination(params.OracleArgv),
				"environmentId", envID, "mode", launcherModeInstalled, "reason", "installed-fact",
				"identity", identity)
			s.registerAttempt(envID, identity, attemptExpectedInstalled)
			_ = wconn.TryResult(req.ID, mustMarshal(shellLauncherCommandResult{
				Mode:          launcherModeInstalled,
				EnvironmentID: envID,
				LauncherPath:  nil,
				Reason:        nil,
			}))
			return
		}
	}

	// Bootstrap: the launcher travels in argv (staged locally, consumed
	// exactly once) and carries the fresh environment id — the far shell
	// announces the passport only when NOCX_ENVIRONMENT_ID is set.
	if s.remoteLauncher == nil || s.launcherStager == nil {
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", "unsupported",
			"identity", identity)
		s.refuseLauncherCommand(wconn, req, envID, "unsupported")
		return
	}
	launcher, reason, ok := s.remoteLauncher.StartCommand(ssh.ShellAuto, ssh.LaunchOptions{
		SessionID:     params.SessionID,
		Enhanced:      true,
		EnvironmentID: envID,
	})
	if !ok {
		refusal := string(reason)
		if refusal == "" {
			refusal = "unsupported"
		}
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", refusal,
			"identity", identity)
		s.refuseLauncherCommand(wconn, req, envID, refusal)
		return
	}

	// Stage it. The renderer never sees the payload — only where to find
	// it — because the payload cannot cross the tty (stage.go).
	path, err := s.launcherStager.Stage(launcher)
	if err != nil {
		s.log.Info("shell.launcherCommand mode decided",
			"destination", oracleDestination(params.OracleArgv),
			"environmentId", envID, "mode", launcherModeRaw, "reason", "stage-failed",
			"identity", identity)
		s.refuseLauncherCommand(wconn, req, envID, "stage-failed")
		return
	}

	s.log.Info("shell.launcherCommand mode decided",
		"destination", oracleDestination(params.OracleArgv),
		"environmentId", envID, "mode", launcherModeBootstrap, "reason", "no-installed-fact",
		"identity", identity)
	s.registerAttempt(envID, identity, attemptExpectedBootstrap)

	// Shell-quote the path so the renderer can splice it into the line as
	// a single word. The staging directory is ours and the names are
	// generated, but a home directory with a quote or a space in it is an
	// ordinary thing and must not break the rewrite.
	quoted := shellQuote(path)
	_ = wconn.TryResult(req.ID, mustMarshal(shellLauncherCommandResult{
		Mode:          launcherModeBootstrap,
		EnvironmentID: envID,
		LauncherPath:  &quoted,
		Reason:        nil,
	}))
}

// refuseLauncherCommand answers with a stated refusal: no path, a reason the
// renderer can log, and an original line that goes to the pty unchanged. The
// attempt is registered as raw so a later observation for its environment id
// can never touch the installed fact.
func (s *WSServer) refuseLauncherCommand(wconn Responder, req jsonrpcRequest, envID, reason string) {
	s.registerAttempt(envID, "", attemptExpectedRaw)
	_ = wconn.TryResult(req.ID, mustMarshal(shellLauncherCommandResult{
		Mode:          launcherModeRaw,
		EnvironmentID: envID,
		LauncherPath:  nil,
		Reason:        &reason,
	}))
}

// observedPassport is the passport the renderer accepted, crossing the
// control plane as a typed observation (§5.4 — the AD-1 amendment this
// needs is named in the P7 commit). The backend stays byte-blind (AD-6);
// only the renderer parses OSC 636, and only an ACCEPTED passport — one
// whose id is the id nocx minted for the attempt in flight — is reported.
type observedPassport struct {
	ProtocolVersion     string `json:"protocolVersion"`
	EnvironmentID       string `json:"environmentId"`
	ParentEnvironmentID string `json:"parentEnvironmentId"`
	ScriptVersion       string `json:"scriptVersion"`
	Tier                string `json:"tier"`
	Generation          string `json:"generation"`
}

// environmentObservedResult is the result of shell.environmentObserved,
// matching contracts/shell.environmentObserved.schema.json exactly.
// processed=false means the environment id did not match any live minted
// attempt (typically a report after a backend restart) — the renderer logs
// it and nothing is written. factUpdated reports whether the durable fact
// store changed.
type environmentObservedResult struct {
	Processed   bool `json:"processed"`
	FactUpdated bool `json:"factUpdated"`
}

// handleShellEnvironmentObserved serves the shell.environmentObserved
// method: the renderer reports what the attempt produced. passport non-null
// is an accepted readiness passport (protocol, script version, generation
// preserved verbatim); passport null is "the attempt ended with no accepted
// passport". Only an attempt this backend minted can change state, and the
// first observation per attempt decides it — duplicates are idempotent and
// can never regress a written fact.
func (s *WSServer) handleShellEnvironmentObserved(wconn Responder, req jsonrpcRequest) {
	var params struct {
		EnvironmentID string            `json:"environmentId"`
		Passport      *observedPassport `json:"passport"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.EnvironmentID == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: environmentId required"})
		return
	}
	if params.Passport != nil && params.Passport.EnvironmentID != params.EnvironmentID {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: passport environmentId does not match"})
		return
	}
	if !validPassport(params.Passport) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: malformed passport"})
		return
	}
	processed, updated := s.consumeObservation(params.EnvironmentID, params.Passport)
	_ = wconn.TryResult(req.ID, mustMarshal(environmentObservedResult{
		Processed:   processed,
		FactUpdated: updated,
	}))
}

// consumeObservation applies one observation to the attempt registry under
// the registry lock: the report is matched to a live minted attempt (else
// processed=false), the first observation per attempt decides it, and the
// durable fact change happens BEFORE the attempt is marked consumed — a
// failed write leaves the attempt consumable so a duplicate report can
// retry, and Get keeps answering "not installed" in the meantime.
func (s *WSServer) consumeObservation(envID string, p *observedPassport) (processed, factUpdated bool) {
	s.launcherAttemptsMu.Lock()
	defer s.launcherAttemptsMu.Unlock()

	a, ok := s.launcherAttempts[envID]
	if !ok {
		// No live minted attempt: a report for an id this backend never
		// minted (typically after a restart) changes nothing.
		s.log.Info("shell.environmentObserved",
			"environmentId", envID, "status", "unexpected")
		return false, false
	}
	if a.consumed {
		// A duplicate report: the first observation decided the attempt,
		// and a duplicate can never regress a written fact.
		s.log.Info("shell.environmentObserved",
			"environmentId", envID, "status", "ignored")
		return true, false
	}
	if a.expected == attemptExpectedRaw {
		// A raw attempt can never touch the installed fact, whatever the
		// renderer observed.
		a.consumed = true
		s.log.Info("shell.environmentObserved",
			"environmentId", envID, "status", "ignored",
			"identity", a.identity)
		return true, false
	}

	if p != nil {
		fact := ssh.InstalledFact{
			Identity:      a.identity,
			Protocol:      p.ProtocolVersion,
			ScriptVersion: p.ScriptVersion,
			Generation:    p.Generation,
			ObservedAt:    time.Now(),
		}
		if s.installedFacts == nil {
			a.consumed = true
			s.log.Info("shell.environmentObserved",
				"environmentId", envID, "status", "accepted",
				"identity", a.identity)
			s.log.Warn("shell.environmentObserved: installed-fact store not wired; accepted passport not recorded",
				"environmentId", envID)
			return true, false
		}
		if err := s.installedFacts.Record(fact); err != nil {
			s.log.Info("shell.environmentObserved",
				"environmentId", envID, "status", "accepted",
				"identity", a.identity)
			s.log.Warn("shell.environmentObserved: could not record the installed fact",
				"identity", a.identity, "error", err)
			return true, false
		}
		a.consumed = true
		s.log.Info("shell.environmentObserved",
			"environmentId", envID, "status", "accepted",
			"identity", a.identity)
		s.log.Info("installed fact recorded",
			"identity", a.identity,
			"protocol", p.ProtocolVersion,
			"generation", p.Generation)
		return true, true
	}

	// No passport. Only a connection that expected installed-script
	// invalidates the fact — that is how a host whose bundle rotted
	// bootstraps again instead of failing forever (§3.3). Bootstrap and
	// raw attempts recorded nothing, so there is nothing to invalidate.
	if a.expected == attemptExpectedInstalled {
		if s.installedFacts == nil {
			a.consumed = true
			s.log.Info("shell.environmentObserved",
				"environmentId", envID, "status", "none",
				"identity", a.identity)
			return true, false
		}
		if err := s.installedFacts.Invalidate(a.identity); err != nil {
			s.log.Info("shell.environmentObserved",
				"environmentId", envID, "status", "none",
				"identity", a.identity)
			s.log.Warn("shell.environmentObserved: could not invalidate the installed fact",
				"identity", a.identity, "error", err)
			return true, false
		}
		a.consumed = true
		s.log.Info("shell.environmentObserved",
			"environmentId", envID, "status", "none",
			"identity", a.identity)
		s.log.Info("installed fact invalidated",
			"identity", a.identity)
		return true, true
	}
	a.consumed = true
	s.log.Info("shell.environmentObserved",
		"environmentId", envID, "status", "none",
		"identity", a.identity)
	return true, false
}

// passportValueRe mirrors the wire rule of §5.2: every passport field is
// restricted to [A-Za-z0-9._-]{1,64} — no escaping, because no field may
// contain a separator. The renderer's parser enforces the same rule
// (frontend/src/environment-passport.ts); the observation RPC re-checks
// because it is the write boundary of the installed fact and must not
// trust a partial or hostile typed payload.
var passportValueRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// validPassport reports whether an observed passport is well-formed enough
// to write a fact from: the id matches the attempt (checked by the caller)
// and every field satisfies the §5.2 charset and the tier enum.
func validPassport(p *observedPassport) bool {
	if p == nil {
		return true // nil means "no passport arrived", the invalidation side
	}
	if !passportValueRe.MatchString(p.ProtocolVersion) ||
		!passportValueRe.MatchString(p.EnvironmentID) ||
		!passportValueRe.MatchString(p.ParentEnvironmentID) ||
		!passportValueRe.MatchString(p.ScriptVersion) ||
		!passportValueRe.MatchString(p.Generation) {
		return false
	}
	switch p.Tier {
	case "enhanced", "blocks", "minimal":
		return true
	default:
		return false
	}
}

// registerAttempt records a minted attempt under the registry lock. The
// registry is bounded: the oldest entry is evicted when full.
func (s *WSServer) registerAttempt(envID, identity, expected string) {
	s.launcherAttemptsMu.Lock()
	defer s.launcherAttemptsMu.Unlock()
	if s.launcherAttempts == nil {
		s.launcherAttempts = make(map[string]*launchAttempt)
	}
	if len(s.launcherAttempts) >= maxLaunchAttempts {
		var oldestID string
		var oldest *launchAttempt
		for id, a := range s.launcherAttempts {
			if oldest == nil || a.mintedAt.Before(oldest.mintedAt) {
				oldest, oldestID = a, id
			}
		}
		delete(s.launcherAttempts, oldestID)
	}
	s.launcherAttempts[envID] = &launchAttempt{
		environmentID: envID,
		identity:      identity,
		expected:      expected,
		mintedAt:      time.Now(),
	}
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
