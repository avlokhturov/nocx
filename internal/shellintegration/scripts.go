package shellintegration

import _ "embed"

// The embedded scripts are the AUTHORED forms, comments and all — the
// reasoning they carry is why the repo keeps them (nocx-z9s9.17). What ships
// is the stripped form: the remote host is sent the bootstrap payload on
// every launch and never reads a comment, and 62% of nocx.bash was measured
// to be prose. One strip at embed time means every carrier — the argv
// prelude, the Go publisher's bundle, the local install and the inband
// payload — ships the SAME bytes, so the manifest hashes, the publisher's
// byte-identity and the version digest all describe exactly what the far
// side receives.
//
//go:embed scripts/nocx.zsh
var zshScriptRaw string

//go:embed scripts/nocx.bash
var bashScriptRaw string

//go:embed scripts/nocx.posix
var posixScriptRaw string

var (
	zshScript   = stripShellComments(zshScriptRaw)
	bashScript  = stripShellComments(bashScriptRaw)
	posixScript = stripShellComments(posixScriptRaw)
)

// version is the integration script version. Bump when scripts change;
// EnsureInstalled/EnsureInstalledRemote compare this against the installed
// VERSION file and rewrite scripts when they differ. nocx-6b3x: an edited
// script without a bump reaches no shell — every existing install keeps
// sourcing the copy installed the last time the number changed.
//
// 18: the shipped scripts are comment-stripped at embed time (nocx-z9s9.17)
// — same code, no prose — so every install rewrites to the smaller bytes.
//
// 19: the recovery seam (ADR-0024 decision 8) — a failed lifecycle send at a
// prompt boundary clears the active latch, restores a visible native prompt,
// and emits the one-shot recovery fence (nocx-u7uh.15).
//
// 20: __nocx_snapshot_wait_ms is declared once per shell, not once per
// source, so the rcfile's deliberate re-source over an installer-era install
// no longer errors (nocx-u7uh.22).
//
// 21: the handshake wait is a real poll (nocx-u7uh.10). `read -N 0` with a
// nonzero -t returns immediately on an open fd, so a kernel that accepted
// the connection but never answered left the shell blocked in dd with no
// prompt at all; the bounded wait now polls with `read -t 0 -N 0` and a
// sleep loop, and a silent peer times out with the native prompt visible
// (ADR-0024 decision 3/9).
//
// 22: nested environments (nocx-u7uh.11): the parent detects sudo/su/ssh in
// its preexec hook, requests a child domain (domain_request), reads the
// grant (the opaque bootstrap), suspends, and launches the child; the
// parent re-activates only after the child closes. extdebug is on so the
// DEBUG trap can skip the original command, the refresh poll hands the
// channel stream to the child (the §9 ownership interval), and a JSON
// decoder for the grant's bootstrap rides here.
//
// 23: the readiness passport is deleted (nocx-u7uh.11): no OSC 636 P, no
// NOCX_ENVIRONMENT_ID, no nocx_env= tagged marker — the environment
// identity now rides the authenticated lifecycle channel (ADR-0024), and
// the env-id machinery that fed the passport-era renderer is gone.
//
// 24: the zsh tier gets the nested-domain machinery (nocx-u7uh.28): a zsh
// parent entering sudo/su/ssh requests a child domain (domain_request),
// reads the grant, suspends, and launches the child — the bash tier's
// nocx-u7uh.11 flow ported. The interception mechanism differs (the
// accept-line widget replaces the DEBUG-trap skip — zsh's DEBUG trap
// cannot suppress a command), and the descriptor staging is zsh's own
// (exec {var}< <(...) — measured non-CLOEXEC, where bash's coproc/{var}
// are close-on-exec).
//
// 25: the zsh nested launch binds its commands' stdin to /dev/tty and runs
// the precmd chain at the widget's end (nocx-u7uh.28). zle executes a
// widget's commands with stdin at /dev/null (measured), which sent the
// child shell to EOF — bash's EOF behaviour displays `exit` and the child
// never established — and zle does not run the precmd hooks for a line a
// widget consumed, which delayed domain_activated past §9's boundary.
//
// 26: the hello declares max_frame 262144 rather than 65536 (nocx-beib).
// The kernel→shell direction carries the child domain's opaque bootstrap,
// which is a full remote launcher with the bundle embedded (~77 KiB and
// growing). At 64 KiB the grant frame was never written at all, and the
// parent shell sat out its grant timeout before running the user's ssh
// conventionally — the five silent seconds the owner reported. The Go side
// is lifecycle.MaxFrameBytes; the two are held together by
// lifecyclecodec's TestMaxFrameBytes_ShellsDeclareTheSameBound.
//
// 27: the same bound now guards the READER too (nocx-beib). v26 raised the
// advertised max_frame and left `__len <= 65536` in __nocx_lc_read_frame, so
// the shell rejected the ssh child's grant — a whole remote launcher, ~77
// KiB — before parsing it. read_grant failed instantly, the parent ran the
// user's ssh conventionally, and the only visible symptom was that blocks
// never appeared. Each script declares __nocx_lc_max_frame once and uses it
// in both places.
//
// 28: the grant frame is parsed with a shortest-match expansion (nocx-beib).
// `${frame##*"bootstrap":"}` walks every position of a ~78 KiB frame —
// measured 1.65 s per expansion against 1 ms — so the shell spent ten
// seconds between reading the child's grant and using it, and the tab sat
// still after the user typed `ssh host`. The first occurrence is also the
// correct one: the field name precedes its own value.
// 29: the bash-4-only staging constructs (`coproc NAME { }`, `exec {var}>&-`)
// are `eval`ed rather than written inline (nocx-cn86). A version guard cannot
// protect SYNTAX — bash parses a function body whole before running any of it
// — so macOS's bash 3.2 rejected the script at the `coproc` token and every
// shell on the platform this product ships to first came up with no
// integration at all.
// 31: the grant's JSON is decoded by the same helper (nocx-aupk). bash 3.2's
// ${var//pattern/replacement} is quadratic and this decodes a whole rcfile —
// measured 4655ms for 22 KiB against 8ms on bash 5, a factor of 580 — so a
// nested launch spent seconds decoding while the user watched a frozen
// terminal. Same cliff as nocx-beib, different string operation.
//
// 30: the readable-probe has one owner and a per-version answer
// (nocx-sw4p). `read -N` is bash 4.1+, so on macOS's 3.2 the probe could
// never succeed, the accept was never read and the channel never activated —
// a defect a parse check cannot see, because `-N` is an option and not
// syntax. bash 3.2 gets perl's select(); the descriptor and port are now
// pinned to digits, since the first of those is interpolated into a program.
const version = "31"

// promptModeEnvVar is the env var that selects the prompt mode.
const promptModeEnvVar = "NOCX_PROMPT_MODE"

// promptModeMarkerOnly is the marker-only prompt mode value.
const promptModeMarkerOnly = "marker-only"

// sessionIDEnvVar is the env var for the nocx session identifier.
const sessionIDEnvVar = "NOCX_SESSION_ID"

// dirName is the directory name inside the user's home.
const dirName = ".nocx"

// versionFile is the marker file written alongside the scripts.
const versionFile = "VERSION"

// activationEnvVar is the env var the shell rc gate checks.
const activationEnvVar = "NOCX_SHELL_INTEGRATION"

// gateLineZsh is appended to ~/.zshrc to load the integration.
const gateLineZsh = `# nocx terminal shell integration
[[ -n "$NOCX_SHELL_INTEGRATION" ]] && source "$HOME/.nocx/shell-integration.zsh"`

// gateLineBash is appended to ~/.bashrc to load the integration.
const gateLineBash = `# nocx terminal shell integration
[[ -n "$NOCX_SHELL_INTEGRATION" ]] && source "$HOME/.nocx/shell-integration.bash"`

// scripts maps installed filename → embedded script content. Every entry is
// installed by EnsureInstalled and EnsureInstalledRemote; adding one means
// deciding its markers (scriptMarkers) and bumping `version`, or existing
// installs never receive it.
var scripts = map[string]string{
	"shell-integration.zsh":   zshScript,
	"shell-integration.bash":  bashScript,
	"shell-integration.posix": posixScript,
}

// rcGate maps rc filename → gate line to append.
var rcGate = map[string]string{
	".zshrc":  gateLineZsh,
	".bashrc": gateLineBash,
}
