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
const version = "21"

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
