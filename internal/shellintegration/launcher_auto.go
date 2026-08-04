package shellintegration

import "strings"

// autoDispatcherScript is the script the ShellAuto command runs under
// /bin/sh. The far login shell parses only the OUTER command — a single
// command with quoted arguments, the same shape every tier already sends,
// so csh and fish can parse it too. The script itself must therefore
// contain no single quotes: the three tier payloads arrive as positional
// arguments (already correctly quoted by the outer command's shellQuote),
// and $0 is the login shell's own argv[0], expanded by the login shell
// before /bin/sh starts.
//
// Why $0 rather than $BASH_VERSION/$ZSH_VERSION: sshd hands the remote
// command to the user's login shell (`$SHELL -c <command>`), and those
// version variables are unexported shell variables of the login-shell
// process — invisible to any child /bin/sh. But argv[0] is set by sshd
// itself to the passwd shell path, and `"$0"` in the outer command is
// expanded by the login shell into that path, which /bin/sh then receives
// as its own $0. It is the ground truth of which shell is running — not
// $SHELL, which can lie — and it needs no probe, no second channel, no ps.
//
// Detection is deliberately total for POSIX login shells: bash → bash tier,
// zsh → zsh tier, everything else (dash, ash, busybox sh, ksh, …) → the
// minimal tier, which reads $ENV and integrates. Non-POSIX login shells
// (csh, tcsh, fish) cannot be detected — none sets a version variable a
// child can see and there is no branch syntax common to csh and sh — so
// they are named explicitly and sent to a plain login shell
// (`exec "${0#-}" -l`): the minimal tier's ENV file is never read by them,
// so running it would only leak a transient directory (measured on tcsh).
// The plain login is the refusal outcome, minus the refusal — the same
// fail-open the minimal tier already documents for shells that ignore ENV
// (ADR-0004).
//
// The `-*)` arm strips a login(1)-style leading dash ("-bash"), and the
// csh/fish arm re-strips it from $0 before the exec, so a login(1)-style
// "-tcsh" argv[0] still executes.
//
// The script is deliberately ONE physical line: csh/tcsh parse a `-c`
// command line-by-line and split a single-quoted token that contains a
// newline (measured on tcsh 6.24.16: "Unmatched ”'", then the quoted
// lines execute as separate commands), so a multi-line dispatcher would
// fail on exactly the shells this shape exists to survive. The case
// statements are therefore written inline (`case x in p) b;; esac` — a
// newline-joined version would need `in;`, which is a syntax error).
const autoDispatcherScript = `s0=${0##*/}; case "$s0" in -*) s0=${s0#-};; esac; case "$s0" in bash) exec /usr/bin/env -u BASH_ENV bash -c "$1";; zsh) exec /usr/bin/env -u BASH_ENV zsh -c "$2";; csh|tcsh|fish) exec "${0#-}" -l;; *) exec /usr/bin/env -u BASH_ENV /bin/sh -c "$3";; esac`

// singleLine collapses a script's statement-separator newlines so the
// payload travels as one physical line. csh/tcsh parse a `-c` command
// line-by-line and split a single-quoted token that contains a newline —
// measured on tcsh 6.24.16: "Unmatched ”'", then the quoted lines are
// executed as separate commands — so any payload that must survive a csh
// login shell has to be one physical line. The zsh and posix outer
// scripts use newlines only as statement separators (no multi-line
// strings, here-docs or comments), so joining with "; " is
// semantics-preserving; the const templates stay multi-line for
// readability and are joined at build time. Not for the dispatcher: its
// case statements need `in` immediately followed by the first pattern, and
// a join would insert "; " there — it is authored single-line instead.
func singleLine(script string) string {
	return strings.TrimSpace(strings.ReplaceAll(script, "\n", "; "))
}

// autoCommand builds the ShellAuto remote command: one strictly-POSIX
// dispatcher carrying all three tier payloads as separate argv words:
//
//	env -u BASH_ENV /bin/sh -c '<dispatcher>' "$0" '<bash-arg>' '<zsh-arg>' '<posix-arg>'
//
// The payloads are the tier commands' inner arguments verbatim — no double
// escaping, so the sizes add (~36 KiB today, under maxAutoLauncherLen).
// Each branch names its interpreter explicitly and passes the payload as a
// single argument, so the `exec bash -c "$1"` chain is the same shape as
// the pinned single-tier commands and carries the same BASH_ENV guard.
// Everything is one physical line — the dispatcher by construction, the
// zsh and posix payloads via singleLine — because a csh login shell splits
// multi-line quoted tokens; multi-line content would fail on exactly the
// shells this shape exists to survive.
func (remoteLauncher) autoCommand(opts LaunchOptions) (string, RefusalReason, bool) {
	bashArg, ok := remoteLauncher{}.bashArg(opts)
	if !ok {
		return "", ReasonUnsupportedShell, false
	}
	zshArg, ok := remoteLauncher{}.zshArg(opts)
	if !ok {
		return "", ReasonUnsupportedShell, false
	}
	posixArg, ok := remoteLauncher{}.posixArg(opts)
	if !ok {
		return "", ReasonUnsupportedShell, false
	}
	cmd := "/usr/bin/env -u BASH_ENV /bin/sh -c " + shellQuote(autoDispatcherScript) +
		` "$0" ` + shellQuote(bashArg) + " " + shellQuote(zshArg) + " " + shellQuote(posixArg)
	if len(cmd) > maxAutoLauncherLen {
		// The three embedded scripts are the only inputs that scale with
		// this number; a script that outgrows the cap must refuse rather
		// than emit a command the far host cannot exec.
		return "", ReasonUnsupportedShell, false
	}
	return cmd, ReasonNone, true
}
