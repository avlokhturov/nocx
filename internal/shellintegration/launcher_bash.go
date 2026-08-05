package shellintegration

import "strings"

// bashRcfileTemplate is the rcfile the bash launcher installs via
// `bash --rcfile <(...)`. It reproduces the startup of an ordinary
// interactive non-login bash — the user's ~/.bashrc runs first and wins —
// then installs nocx's hooks last (ADR-0006: the prompt overlay must
// survive framework prompt initialisation). @ENV@ is replaced by the
// session environment block and @NOCX_BASH@ by the embedded nocx.bash.
//
// Declared equivalence set (what this rcfile promises, nothing more):
//   - exported variables, cwd, umask, shell options, functions and aliases,
//     traps and history configuration are whatever the user's ~/.bashrc
//     leaves them; nocx resets none of them;
//   - $0 is "bash", non-login, interactive ([[ $- == *i* ]]);
//   - /etc/bash.bashrc is not sourced: --rcfile replaces the whole standard
//     interactive startup sequence, so it is skipped on every platform
//     (declared deviation on Debian-derived systems, whose ordinary
//     interactive bash reads it);
//   - SHLVL is one higher than a native session — the outer `bash -c` is
//     itself a shell — and the whole child subtree is consistently shifted;
//   - if the user's ~/.bashrc execs or exits, control never reaches the
//     install below: user startup wins. A top-level `return` in the user's
//     file stops only that file — bash resumes the source — which is
//     indistinguishable from completion, so the install proceeds; that
//     case is a reported limitation, not a silent equivalence (nocx-xs1d).
//
// BASH_ENV: the outer `bash -c` is non-interactive and would read BASH_ENV
// before this file exists, executing attacker-or-accident code (spec §4.3);
// the launcher strips it with `env -u BASH_ENV` in front of the
// `bash -c` form.
const bashRcfileTemplate = `# nocx launcher rcfile — bash, interactive non-login.
# Reproduces an ordinary interactive non-login bash startup, then installs
# nocx's hooks last. See the Go source for the declared equivalence set.
@ENV@

# User startup — first, and it wins.
if [[ -f "${HOME}/.bashrc" ]]; then
    . "${HOME}/.bashrc"
fi

# nocx installs last. Run the install with errexit/xtrace temporarily off:
# a 'set -e'/'set -x' left by the user's rc must not abort or flood the
# install. The user's options are restored immediately after.
__nocx_old_opts="${-}"
set +e +x
# An installer-era gate line in the user's rc may already have sourced an
# older integration mid-rc. Rewind its captures so the fresh install below
# chains to the user's original traps and PROMPT_COMMAND, not to our own
# wrappers.
if [[ -n "${__nocx_loaded:-}" ]]; then
    if [[ -n "${__nocx_old_debug:-}" ]]; then
        trap "${__nocx_old_debug}" DEBUG
    else
        trap - DEBUG
    fi
    if [[ -n "${__nocx_old_exit:-}" ]]; then
        trap "${__nocx_old_exit}" EXIT
    else
        trap - EXIT
    fi
    if [[ "${PROMPT_COMMAND-}" == "__nocx_prompt_command" ]]; then
        PROMPT_COMMAND="${__nocx_old_pc-}"
    fi
fi
unset __nocx_loaded __nocx_prompt_wrapped __nocx_owned_session \
      __nocx_arm_marker_only __nocx_preexec_done __nocx_in_prompt_command \
      __nocx_first_prompt
@NOCX_BASH@
case "${__nocx_old_opts}" in *e*) set -e;; esac
case "${__nocx_old_opts}" in *x*) set -x;; esac
unset __nocx_old_opts
`

// bashArg builds the script `bash -c` parses for the bash tier: exec the
// interactive bash whose rcfile is the escaped payload delivered through
// process substitution. It is the piece the ShellAuto dispatcher carries as
// its first positional argument; bashCommand wraps it with shellQuote.
// ok is false when the pinned Enhanced precondition fails.
//
// The pinned form of the full command is
//
//	env -u BASH_ENV bash -c 'exec bash --rcfile <(printf %b "<escaped-init>") -i'
//
// with three deliberate choices, all documented:
//   - `/usr/bin/env -u BASH_ENV` in front: the outer bash -c is
//     non-interactive and would read BASH_ENV, executing attacker-or-
//     accident code before the rcfile exists (spec §4.3). The inner
//     interactive bash never reads BASH_ENV, so stripping it for the whole
//     chain is exactly what a native session sees. /usr/bin/env exists on
//     every Linux and macOS host (NixOS ships a compatibility shim).
//   - bash is resolved by `env` through PATH, NOT named as /bin/bash.
//     NixOS and Guix keep bash in the store and have no /bin/bash at all, so
//     an absolute path refuses those hosts outright — and, measured on the
//     machine this was written on, skipped every test of this launcher, which
//     is the epic's primary path. `env` still guarantees the explicit
//     interpreter; that guarantee never needed an absolute path.
//   - the rcfile travels through `printf %b` with printfBEscape encoding,
//     so the payload needs no remote write and contains no NUL (bEscape
//     never emits one and the embedded script is text).
//
// Naming bash explicitly is the point: process substitution is a bashism,
// and sshd hands the remote command to the user's login shell, which may be
// dash, ash, csh or a restricted shell.
// bashRcfile renders the bash rcfile from its template: @ENV@ is the session
// environment block (launcherEnvBlock for the argv launchers, empty for the
// launch carrier, which exports the stable variables itself before exec) and
// @NOCX_BASH@ is the nocx.bash body — the embedded script for the argv
// launchers, a source of the installed generation file for the carrier.
func bashRcfile(envBlock, scriptSource string) string {
	rc := strings.ReplaceAll(bashRcfileTemplate, "@ENV@", envBlock)
	return strings.ReplaceAll(rc, "@NOCX_BASH@", scriptSource)
}

// bashArgFor wraps a rendered rcfile in the bash tier's pinned transport:
// `exec bash --rcfile <(printf %b "<escaped>") -i`. It contains no single
// quotes by construction (printfBEscape removes them), so it can travel
// single-quoted inside the launch carrier as well as inside the argv
// launchers' shellQuote.
func bashArgFor(rc string) string {
	return `exec bash --rcfile <(printf %b "` + printfBEscape(rc) + `") -i`
}

func (remoteLauncher) bashArg(opts LaunchOptions) (string, bool) {
	if opts.Enhanced && opts.SessionID == "" {
		// Pinned contract: SessionID is never empty when Enhanced. Fail
		// closed — a marker-only session with no id cannot anchor the
		// ownership protocol — rather than emit one that half-works.
		return "", false
	}
	return bashArgFor(bashRcfile(launcherEnvBlock(opts), bashScript)), true
}

// bashCommand builds the bash remote command: the pinned single-tier form,
// which is what a client sends when the far shell is already known to be
// bash. The ShellAuto dispatcher sends bashArg instead, wrapped by its own
// argv plumbing, so the two paths share one payload.
func (remoteLauncher) bashCommand(opts LaunchOptions) (string, RefusalReason, bool) {
	arg, ok := remoteLauncher{}.bashArg(opts)
	if !ok {
		return "", ReasonUnsupportedShell, false
	}
	cmd, ok := fullBootstrapLauncher(bashExecTail, arg)
	if !ok {
		// The publish prelude carries the bundle; a bundle that outgrows
		// the cap must refuse rather than emit a command the far host
		// cannot exec.
		return "", ReasonUnsupportedShell, false
	}
	return cmd, ReasonNone, true
}
