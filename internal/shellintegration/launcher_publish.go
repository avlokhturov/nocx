package shellintegration

import "strings"

// The full bootstrap launcher (design §3.2). The staged payload that travels
// in argv is no longer only the tier command: before exec'ing the integrated
// shell it publishes the bundle under the far $HOME through the same protocol
// P1's Go publisher implements, and exports the committed generation so the
// readiness passport names it. Publication failure is NEVER fatal — every
// refusal and every failed boundary leaves the session transient-integrated
// and NOCX_GENERATION unset, which P2's scripts render as "-".
//
// Why a second writer at all: the argv launcher is executed by the far login
// shell — POSIX sh on a machine the Go binary never reaches (the SFTP carrier
// is P8's, and a hand-typed ssh has no connection to publish over). One
// contract, two writers, one verifier: the manifest schema, the directory
// layout and the modes are declared on the Go side (manifest.go, publisher.go)
// and this script implements that declaration — it invents no field, no path
// and no mode. The bidirectional conformance tests prove the two writers
// produce state the other accepts.
//
// The sh writer's durability guarantee is process death and connection loss,
// not power loss: POSIX sh has no per-file fsync, so the fsync discipline the
// Go publisher promises is deliberately absent here. The manifest-last rename
// plus the launch carrier's per-file hash re-verification is what makes torn
// state unrepresentable at activation time.
//
// The script is one physical line after singleLine (csh login shells split a
// single-quoted token containing a newline), so every statement below is a
// single line, there are no comments, and no single quotes appear anywhere.
// The function body is opened with a no-op ":" so the brace survives the join.

// publishPreludeTemplate is the sh publish. @VERSION@ is the script version;
// @NOCX_BASH@/@NOCX_ZSH@/@NOCX_POSIX@ are the generation files,
// printfBEscape-encoded; @NOCX_LAUNCH@ is the launch carrier, likewise;
// @MANIFEST_JSON@ is the bare manifest printf statement.
const publishPreludeTemplate = `__nocx_publish() { :
__nocx_root="${HOME}/.nocx"
__nocx_skip=
__nocx_gen=
__nocx_have_lock=
__nocx_version="@VERSION@"
[ -n "${HOME:-}" ] || __nocx_skip=1
[ ! -L "$__nocx_root" ] || __nocx_skip=1
if [ -e "$__nocx_root" ] && [ ! -d "$__nocx_root" ]; then __nocx_skip=1; fi
if [ -d "$__nocx_root" ]; then __nocx_ours=0; for __nocx_m in manifest.json launch lock tmp integration run VERSION; do if [ -e "$__nocx_root/$__nocx_m" ]; then __nocx_ours=1; fi; done; if [ "$__nocx_ours" != 1 ]; then __nocx_skip=1; fi; fi
[ ! -L "$__nocx_root/tmp" ] || __nocx_skip=1
[ ! -L "$__nocx_root/integration" ] || __nocx_skip=1
[ ! -L "$__nocx_root/lock" ] || __nocx_skip=1
[ ! -L "$__nocx_root/manifest.json" ] || __nocx_skip=1
[ ! -L "$__nocx_root/launch" ] || __nocx_skip=1
if [ "$__nocx_skip" != 1 ]; then if [ -f "$__nocx_root/manifest.json" ]; then __nocx_m=$(tr -d "[:space:]" < "$__nocx_root/manifest.json" 2>/dev/null); fi; __nocx_installed_protocol=$(__nocx_jnum protocol); __nocx_installed_version=$(__nocx_jstr version); if [ -n "$__nocx_installed_protocol" ] && [ "$__nocx_installed_protocol" != 1 ]; then __nocx_skip=1; fi; if [ -n "$__nocx_installed_protocol" ] && [ -n "$__nocx_installed_version" ] && __nocx_ver_ge "$__nocx_installed_version" "$__nocx_version"; then __nocx_skip=1; fi; fi
if [ "$__nocx_skip" != 1 ]; then mkdir -p "$__nocx_root/tmp" "$__nocx_root/integration" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then chmod 700 "$__nocx_root" "$__nocx_root/tmp" "$__nocx_root/integration" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then __nocx_d=$(mktemp -d "$__nocx_root/tmp/nocx.XXXXXX" 2>/dev/null) || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then chmod 700 "$__nocx_d" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then if __nocx_lock; then __nocx_have_lock=1; else __nocx_skip=1; fi; fi
if [ "$__nocx_skip" != 1 ]; then if [ -f "$__nocx_root/manifest.json" ]; then __nocx_m=$(tr -d "[:space:]" < "$__nocx_root/manifest.json" 2>/dev/null); fi; __nocx_installed_protocol=$(__nocx_jnum protocol); __nocx_installed_version=$(__nocx_jstr version); if [ -n "$__nocx_installed_protocol" ] && [ "$__nocx_installed_protocol" != 1 ]; then __nocx_skip=1; fi; if [ -n "$__nocx_installed_protocol" ] && [ -n "$__nocx_installed_version" ] && __nocx_ver_ge "$__nocx_installed_version" "$__nocx_version"; then __nocx_skip=1; fi; fi
if [ "$__nocx_skip" != 1 ]; then printf %b "@NOCX_BASH@" > "$__nocx_d/nocx.bash" && chmod 600 "$__nocx_d/nocx.bash" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then printf %b "@NOCX_ZSH@" > "$__nocx_d/nocx.zsh" && chmod 600 "$__nocx_d/nocx.zsh" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then printf %b "@NOCX_POSIX@" > "$__nocx_d/nocx.posix" && chmod 600 "$__nocx_d/nocx.posix" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then __nocx_hb=$(__nocx_sha "$__nocx_d/nocx.bash"); __nocx_hz=$(__nocx_sha "$__nocx_d/nocx.zsh"); __nocx_hp=$(__nocx_sha "$__nocx_d/nocx.posix"); if [ -z "$__nocx_hb" ] || [ -z "$__nocx_hz" ] || [ -z "$__nocx_hp" ]; then __nocx_skip=1; fi; fi
if [ "$__nocx_skip" != 1 ]; then __nocx_sb=$(wc -c < "$__nocx_d/nocx.bash"); __nocx_sz=$(wc -c < "$__nocx_d/nocx.zsh"); __nocx_sp=$(wc -c < "$__nocx_d/nocx.posix"); fi
if [ "$__nocx_skip" != 1 ]; then rm -rf "$__nocx_root/integration/v@VERSION@" 2>/dev/null; mv "$__nocx_d" "$__nocx_root/integration/v@VERSION@" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then printf @MANIFEST_JSON@ > "$__nocx_root/tmp/manifest.$$" && chmod 600 "$__nocx_root/tmp/manifest.$$" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then if [ ! -e "$__nocx_root/launch" ]; then printf %b "@NOCX_LAUNCH@" > "$__nocx_root/launch" && chmod 700 "$__nocx_root/launch" || __nocx_skip=1; fi; fi
if [ "$__nocx_skip" != 1 ]; then mv "$__nocx_root/tmp/manifest.$$" "$__nocx_root/manifest.json" || __nocx_skip=1; fi
if [ "$__nocx_skip" != 1 ]; then __nocx_gen="v@VERSION@"; for __nocx_g in "$__nocx_root"/integration/v*; do if [ -e "$__nocx_g" ]; then if [ "$__nocx_g" != "$__nocx_root/integration/v@VERSION@" ]; then rm -rf "$__nocx_g"; fi; fi; done; for __nocx_t in "$__nocx_root"/tmp/*; do if [ -e "$__nocx_t" ]; then rm -rf "$__nocx_t"; fi; done; fi
if [ "$__nocx_have_lock" = 1 ]; then rm -rf "$__nocx_root/lock" 2>/dev/null; fi
}
__nocx_jnum() { printf "%s" "$__nocx_m" | grep -o "\"$1\":[0-9][0-9]*" | head -n 1 | cut -d: -f2; }
__nocx_jstr() { printf "%s" "$__nocx_m" | grep -o "\"$1\":\"[^\"]*\"" | head -n 1 | cut -d\" -f4; }
__nocx_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d" " -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d" " -f1; fi; }
__nocx_ver_ge() { printf "%s\n%s\n" "$1" "$2" | awk "function enc(s,a,n,i,r){n=split(s,a,/[^A-Za-z0-9]+/);for(i=1;i<=n;i++){if(a[i] ~ /^[0-9]+\$/){r=r sprintf(\"%010d\",a[i])}else{r=r a[i]}r=r \".\"}return r} NR==1{e1=enc(\$0)} NR==2{e2=enc(\$0)} END{exit !(e1>=e2)}"; }
__nocx_lock() { __nocx_n=0; while [ "$__nocx_n" -lt 10 ]; do if mkdir "$__nocx_root/lock" 2>/dev/null; then printf "%s\n" "$__nocx_d" > "$__nocx_root/lock/nonce" 2>/dev/null; return 0; fi; sleep 0.1; __nocx_n=$((__nocx_n + 1)); done; rm -rf "$__nocx_root/lock" 2>/dev/null; __nocx_n=0; while [ "$__nocx_n" -lt 10 ]; do if mkdir "$__nocx_root/lock" 2>/dev/null; then printf "%s\n" "$__nocx_d" > "$__nocx_root/lock/nonce" 2>/dev/null; return 0; fi; sleep 0.1; __nocx_n=$((__nocx_n + 1)); done; return 1; }
__nocx_publish
export NOCX_GENERATION="${__nocx_gen-}"`

// manifestJSONFormat is the manifest schema parseManifest accepts: protocol,
// version, generation and a files map of the three fixed generation names,
// each with hash, mode and size, no unknown keys. It is the printf(1) format
// for the @MANIFEST_JSON@ substitution; the hash is sha256 of the file as
// written, mode and size mirror what chmod and wc report.
const manifestJSONFormat = `{"protocol":1,"version":"%s","generation":"%s","files":{"nocx.bash":{"hash":"sha256:%s","mode":"0600","size":%s},"nocx.zsh":{"hash":"sha256:%s","mode":"0600","size":%s},"nocx.posix":{"hash":"sha256:%s","mode":"0600","size":%s}}}`

// manifestJSONStatement is the substitution for the template's bare
// `printf @MANIFEST_JSON@` line: the double-quoted format (quotes escaped for
// the shell) plus the eight arguments, so the finished line is one well-formed
// printf command with no nesting.
var manifestJSONStatement = `"` + strings.ReplaceAll(manifestJSONFormat, `"`, `\"`) +
	`\n" "$__nocx_version" "v$__nocx_version" "$__nocx_hb" "$__nocx_sb" "$__nocx_hz" "$__nocx_sz" "$__nocx_hp" "$__nocx_sp"`

// buildPublishPrelude renders the publish script for a bundle version. The
// result is one physical line with no single quotes — it travels inside the
// outer command's single-quoted argument, which a csh login shell would
// otherwise split.
func buildPublishPrelude(version string) string {
	s := strings.ReplaceAll(publishPreludeTemplate, "@VERSION@", version)
	s = strings.ReplaceAll(s, "@MANIFEST_JSON@", manifestJSONStatement)
	s = strings.ReplaceAll(s, "@NOCX_BASH@", printfBEscape(bashScript))
	s = strings.ReplaceAll(s, "@NOCX_ZSH@", printfBEscape(zshScript))
	s = strings.ReplaceAll(s, "@NOCX_POSIX@", printfBEscape(posixScript))
	s = strings.ReplaceAll(s, "@NOCX_LAUNCH@", printfBEscape(launchCarrier()))
	return singleLine(s)
}

// Exec tails for the publish prelude: after the publish, the prelude execs
// the tier whose payload arrives as a separate argv word ($1) — never nested
// inside the quoted prelude, so the command carries no single quotes inside
// the quoted region and stays parseable by a csh login shell. For ShellAuto
// the dispatcher is $1 and the three tier payloads $2..$4, with the login
// shell's argv[0] carried through $0 (captured by the outer command's "$0").
const (
	bashExecTail = `exec /usr/bin/env -u BASH_ENV bash -c "$1"`
	shExecTail   = `exec /usr/bin/env -u BASH_ENV /bin/sh -c "$1"`
	autoExecTail = `exec /usr/bin/env -u BASH_ENV /bin/sh -c "$1" "$0" "$2" "$3" "$4"`
)

// fullBootstrapLauncher composes the publish prelude, an exec tail and the
// tier payloads into the full remote command:
//
//	env -u BASH_ENV /bin/sh -c '<prelude; tail>' "$0" '<payload>…'
//
// ok is false when the command outgrows maxFullLauncherLen — the prelude's
// embedded bundle is the only input that scales with that number, and a
// bundle that outgrows the cap must refuse rather than emit a command the far
// host cannot exec.
func fullBootstrapLauncher(tail string, payloads ...string) (string, bool) {
	cmd := "/usr/bin/env -u BASH_ENV /bin/sh -c " + shellQuote(buildPublishPrelude(version)+"; "+tail) + ` "$0"`
	for _, p := range payloads {
		cmd += " " + shellQuote(p)
	}
	if len(cmd) > maxFullLauncherLen {
		return "", false
	}
	return cmd, true
}
