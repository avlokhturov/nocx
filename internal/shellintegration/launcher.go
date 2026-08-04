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

// launcherEnvBlock returns the session-environment lines shared by the bash
// rcfile and the generated zshrc. The vars are exported before the user's
// rc runs — rc files that check for nocx (e.g. an installer-era gate) see
// them, and nested shells inherit them. The session id is shell-quoted:
// LaunchOptions allows any string, and these lines are shell source.
func launcherEnvBlock(opts LaunchOptions) string {
	var b strings.Builder
	b.WriteString("NOCX_SHELL_INTEGRATION=1\n")
	if opts.Enhanced {
		b.WriteString("NOCX_PROMPT_MODE=marker-only\n")
		b.WriteString("NOCX_SESSION_ID=" + shellQuote(opts.SessionID) + "\n")
	}
	b.WriteString("export NOCX_SHELL_INTEGRATION")
	if opts.Enhanced {
		b.WriteString(" NOCX_PROMPT_MODE NOCX_SESSION_ID")
	}
	b.WriteString("\n")
	return b.String()
}

// maxLauncherLen caps a single-tier remote command well below a conservative
// remote ARG_MAX. Chosen 32 KiB because: Linux enforces MAX_ARG_STRLEN of
// 128 KiB per single argument; macOS caps total argv+env at 256 KiB
// (1 MiB on current releases); and the bash launcher's rcfile travels
// through a process-substitution pipe, whose default buffer is 64 KiB on
// Linux — a payload above that stalls the writer until the shell reads it
// (harmless but unnecessary). 32 KiB is below all three and leaves the
// current ~19 KiB bash launcher room to grow. The embedded scripts are the
// only inputs that scale with this number; a script that outgrows the cap
// makes StartCommand refuse instead of emitting a command the far host
// cannot exec. A var, not a const, so tests can prove the refusal path.
var maxLauncherLen = 32 * 1024

// maxAutoLauncherLen caps the ShellAuto dispatcher command, which carries
// the bash, zsh and posix payloads as three separate argv words (no double
// escaping, so this is their plain sum plus a ~500-byte script). 64 KiB is
// deliberate: Linux binds the per-argument size (MAX_ARG_STRLEN, 128 KiB)
// and the largest single word here is the bash payload (~24 KiB); macOS
// binds the whole argv+env block (256 KiB on older releases, 1 MiB current)
// and the whole command is ~36 KiB. The bash tier's own 64 KiB
// process-substitution-pipe limit still applies to the bash payload alone,
// which the dispatcher leaves unchanged. A var, not a const, so tests can
// prove the refusal path, matching maxLauncherLen.
var maxAutoLauncherLen = 64 * 1024

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
