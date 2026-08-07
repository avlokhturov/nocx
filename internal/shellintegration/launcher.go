package shellintegration

import "strings"

// ShellKind names the far shell a launcher builds a start command for.
type ShellKind string

const (
	ShellBash    ShellKind = "bash"
	ShellZsh     ShellKind = "zsh"
	ShellUnknown ShellKind = "unknown"
	// ShellAuto means "the far host decides": the launcher emits a single
	// strictly-POSIX dispatcher that detects the login shell at runtime and
	// execs the matching tier (nocx-6rj0). It is a build-time intent, never
	// a detected result — StartCommand never returns it as a claim.
	ShellAuto ShellKind = "auto"
)

// RefusalReason is why integration did not happen, in a form the product
// renders. The empty string means "no refusal".
type RefusalReason string

const (
	ReasonNone             RefusalReason = ""
	ReasonUnsupportedShell RefusalReason = "unsupported-shell"
	ReasonNoSecureTemp     RefusalReason = "no-secure-temp"
)

// LaunchOptions carries what the start command must embed.
type LaunchOptions struct {
	SessionID string // NOCX_SESSION_ID for this session; never empty when Enhanced
	Enhanced  bool   // request marker-only prompt mode (ADR-0006)
	// EnvironmentID is the environment-transition id minted for this attempt
	// (design §5.3). Exported as NOCX_ENVIRONMENT_ID; P2's scripts emit the
	// readiness passport and tag their markers only when it is set and
	// well-formed, so an empty value is the fail-open default (no passport,
	// no tagged marker) rather than a refusal.
	EnvironmentID string
}

// RemoteLauncher builds the command string passed to an SSH session's
// Start() to bring up an integrated interactive shell on the far host.
type RemoteLauncher interface {
	// StartCommand returns the remote command for the given far shell.
	// ok is false when this shell cannot be integrated; reason then says
	// why, and the caller falls back to a plain shell.
	StartCommand(shell ShellKind, opts LaunchOptions) (cmd string, reason RefusalReason, ok bool)
}

// remoteLauncher is the production RemoteLauncher.
type remoteLauncher struct{}

// NewRemoteLauncher returns the production RemoteLauncher.
func NewRemoteLauncher() RemoteLauncher { return remoteLauncher{} }

// StartCommand implements RemoteLauncher.
//
// Selection is deliberate per kind: bash and zsh get their launchers,
// ShellUnknown gets the minimal tier — the posix launcher (spec §6: dash /
// busybox ash / POSIX sh are a real tier, verified; refusing them forever
// would contradict D4) — and ShellAuto gets the dispatcher, which carries
// all three tiers and lets the far login shell choose at runtime (the
// only layer that knows which shell it is; nocx-6rj0). The default arm is
// the tripwire for a future ShellKind with no launcher: refuse loudly
// rather than guess.
func (remoteLauncher) StartCommand(shell ShellKind, opts LaunchOptions) (string, RefusalReason, bool) {
	switch shell {
	case ShellBash:
		return remoteLauncher{}.bashCommand(opts)
	case ShellZsh:
		return remoteLauncher{}.zshCommand(opts)
	case ShellUnknown:
		return remoteLauncher{}.posixCommand(opts)
	case ShellAuto:
		return remoteLauncher{}.autoCommand(opts)
	default:
		// Never a best-effort guess: an unmapped shell kind is refused
		// outright and the caller falls back to a plain shell.
		return "", ReasonUnsupportedShell, false
	}
}

func launcherEnvBlock(opts LaunchOptions) string {
	var b strings.Builder
	b.WriteString("NOCX_SHELL_INTEGRATION=1\n")
	if opts.Enhanced {
		b.WriteString("NOCX_PROMPT_MODE=marker-only\n")
		b.WriteString("NOCX_SESSION_ID=" + shellQuote(opts.SessionID) + "\n")
	}
	if opts.EnvironmentID != "" {
		// Independent of Enhanced on purpose: the passport is gated on the
		// environment id, never on the prompt mode (design §5.2), so a
		// baseline session that carries an id still announces it.
		b.WriteString("NOCX_ENVIRONMENT_ID=" + shellQuote(opts.EnvironmentID) + "\n")
	}
	b.WriteString("export NOCX_SHELL_INTEGRATION")
	if opts.Enhanced {
		b.WriteString(" NOCX_PROMPT_MODE NOCX_SESSION_ID")
	}
	if opts.EnvironmentID != "" {
		b.WriteString(" NOCX_ENVIRONMENT_ID")
	}
	b.WriteString("\n")
	return b.String()
}

// shellQuote wraps s in single quotes, escaping embedded quotes with the
// POSIX '\” idiom. This is a real escaper, not concatenation that happens
// to work on today's payloads: the launcher strings are built quote-free by
// construction (see printfBEscape), so under a POSIX login shell this is
// usually the identity, but any future payload change that introduces a
// quote stays correct under dash/ash/bash and the other POSIX login shells
// sshd may hand the remote command to.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// printfBEscape encodes payload bytes for transport through the bash
// builtin's `printf %b "<…>"`, which is how the bash launcher delivers its
// rcfile. Inside the double-quoted argument the bytes must survive two
// layers unchanged: the outer `bash -c`'s double-quote processing (where
// `"`, `$`, backtick and backslash are special) and printf's `%b` escape
// scan (where backslash + one of the recognized letters is an escape).
// set becomes `\0` plus exactly three octal digits. The leading zero is
// load-bearing: `%b` parses `\0ddd` as the zero plus up to three further
// octal digits, so `\0` + three digits is exactly four consumed characters
// and never bleeds into a following octal digit (`\012` + `3` would read
// as octal 0123 = 'S'; `\0012` + `3` reads as newline + `3`). Single
// quotes are escaped too, so the whole argument contains no `'` and stays
// parseable by csh login shells as well.
func printfBEscape(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	// Byte-wise on purpose: ranging the string directly iterates per rune
	// and would skip the continuation bytes of multi-byte UTF-8.
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c <= 0x7e && c != '"' && c != '$' && c != '`' && c != '\\' && c != '\'' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('\\')
		b.WriteByte('0')
		b.WriteByte('0' + ((c >> 6) & 7))
		b.WriteByte('0' + ((c >> 3) & 7))
		b.WriteByte('0' + (c & 7))
	}
	return b.String()
}

// maxFullLauncherLen caps the full bootstrap launcher: the publish prelude
// (which carries the three generation scripts, the launch carrier and the
// publish logic) plus the tier command. The whole remote command travels as
// ONE argv word (the staged file is command-substituted into the ssh line),
// so Linux's MAX_ARG_STRLEN of 128 KiB per argument is the binding bound —
// macOS's per-argument cap is the whole 256 KiB block on older releases. The
// prelude's embedded payloads are the only inputs that scale with this
// number; a bundle that outgrows the cap must refuse rather than emit a
// command the far host cannot exec. A var, not a const, so tests can prove
// the refusal path.
//
// 120 KiB, raised from 112 KiB on 2026-08-07 (nocx-z9s9.18). The old comment
// said the ShellAuto form was "~97 KiB today", which had stopped being true
// without anybody noticing: measured at the raise it was 112,676 bytes
// against a 114,688-byte cap — 98.2% full, 2 KB of headroom for THREE
// scripts. The intended margin had been eaten a few hundred bytes at a time,
// and nothing failed until a script grew by 2 KB and every remote launch
// refused at once. Adding a line of shell had become impossible, which is
// not a state a limit should be able to reach quietly.
//
// So the number moved, and TestFullLauncherStaysUnderArgLimit now asserts the
// MARGIN rather than the ceiling — erosion is the failure mode, and only a
// test that watches the gap can report it while there is still room to act.
// The real fix is smaller payloads: 62% of nocx.bash is comments, ~22 KB of
// prose across the three scripts that the remote host is sent and never
// reads (nocx-z9s9.17).
var maxFullLauncherLen = 120 * 1024
