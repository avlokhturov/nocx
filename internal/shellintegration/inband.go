package shellintegration

import (
	"fmt"
	"regexp"
	"strings"
)

// In-band integration (spec §4.4, nocx-ynsx): bootstrapping the shell that
// is ALREADY at a prompt, by typing into its pty. Permitted only while the
// frontend holds a trusted A→B prompt (PROMPT_READY && trusted && owned) —
// consent changes authorisation, not the identity of the foreground process,
// so this is never offered outside that window.
//
// The delivery contract (the fences):
//
//  1. The wrapper is ONE line typed at the prompt (readline submits a single
//     line). It captures the exact prior termios with `stty -g`, enters raw
//     mode (drops MAX_CANON, kills echo), emits a private READY OSC only
//     after raw mode is on, and stages the payload through a POSIX
//     `while IFS= read -r` loop that stops at the <terminator> LINE — so the
//     payload stream ends at a delimiter LINE, not a byte count, and a
//     truncated or cancelled stream still reaches the restore.
//     The stage is shell builtins only, deliberately NOT `sed`: on a pty
//     stream busybox sed stalls before the terminator — measured: the staged
//     file stops mid-line 46 bytes short of the payload's end (24576 of
//     24622 bytes), the markers never arrive, and a second terminator line
//     written later is what finally wakes it. Busybox sed reads stdin
//     byte-at-a-time through stdio (bb_get_chunk_from_file, 1024-byte
//     readahead) and reads one line AHEAD of the line it processes, so even
//     a fully delivered stream can never fire its `q` on the last line of a
//     never-EOF tty (nocx-pu4.3). A shell `read` loop reads strictly one
//     line at a time with no lookahead, so the terminator always fires, on
//     bash, zsh, dash and busybox ash alike.
//  2. `stty "$saved"` restores the EXACT prior termios before any user code
//     runs; `stty sane` is never used (it discards the user's custom modes).
//     The restore runs on every path: success, cancel (frontend sends the
//     terminator, sed quits, the wrapper continues), and mid-flight failure.
//  3. Nothing is sourced without the completion marker: the payload's LAST
//     line is `# nocx-ib-complete`, and the wrapper greps for it before
//     sourcing. A cut stream can never source a partial hook script.
//  4. Fail-open is absolute (ADR-0004:60): any failure leaves an ordinary
//     terminal with a visible native prompt.
//
// The payload is a POSIX-sh dispatcher followed by the three hook scripts
// (bash/zsh/posix), each framed by START/END marker lines. The dispatcher
// detects the running shell from inside it ($ZSH_VERSION / $BASH_VERSION),
// extracts the right section from the staged file with sed, and sources it
// with the integration environment set. Stray bytes that land between the
// payload and the terminator sit OUTSIDE every extraction range, so the
// sourced script is always byte-identical to the embedded one.

const (
	// inBandTerminator is the delimiter LINE that ends the payload stream.
	// sed quits on it; the frontend sends it to cancel a stream in flight.
	inBandTerminator = "NOCX_IB_EOF"

	// inBandReadyOSC is the private OSC the wrapper emits once raw mode is
	// on and sed is reading. It is written as the PRINTABLE escape sequence
	// (backslash-escaped), because the wrapper is typed text: a raw ESC byte
	// inside the typed line would confuse readline's display. The shell's
	// printf interprets \033 and \a (POSIX).
	inBandReadyOSC = `\033]1337;NOCX_IB_READY\a`

	// inBandCompleteMarker is the payload's final line. The wrapper sources
	// the staged file only when grep finds this exact line, so a truncated
	// or cancelled stream never sources a partial script.
	inBandCompleteMarker = "# nocx-ib-complete"

	inBandBashStart  = "NOCX_IB_BASH_START"
	inBandBashEnd    = "NOCX_IB_BASH_END"
	inBandZshStart   = "NOCX_IB_ZSH_START"
	inBandZshEnd     = "NOCX_IB_ZSH_END"
	inBandPosixStart = "NOCX_IB_POSIX_START"
	inBandPosixEnd   = "NOCX_IB_POSIX_END"
)

// InBandPlan is the in-band bootstrap: the wrapper line typed at the prompt,
// the payload staged through the raw-mode window, and the stream terminator
// the frontend appends (or sends alone to cancel).
//
// Capability is the per-epoch bearer the backend writes into the pty as the
// FIRST line of the raw-mode stream, immediately after the wrapper's READY —
// before the payload. It is backend-only: it is never serialized into the
// shell.integrate result the renderer receives (ADR-0024 decision 7: no
// capability reaches the renderer), never substituted into the payload, and
// never written to the staged file. The wrapper captures it into a
// non-exported shell variable; the staged file stays capability-free.
type InBandPlan struct {
	Wrapper    string
	Payload    string
	Terminator string
	Capability string
}

// ChannelConfig is the per-session authenticated-channel configuration
// substituted into the in-band dispatcher text. Every field is a NAME, never
// a secret (the capability is delivered separately, above); the shell reads
// them as NOCX_LIFECYCLE_* and addresses its envelopes with them.
type ChannelConfig struct {
	Lane   string
	Domain string
	Epoch  uint64
	Port   int // loopback TCP port the shell connects to
}

// sessionIDRe matches the 32-lowercase-hex session ids the registry mints
// (AD-7). The id is embedded into shell source, so anything else is refused
// rather than quoted into the payload.
var sessionIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// inBandDispatcher is the payload's header, sourced by the shell at the
// prompt. It must parse under bash, zsh and POSIX sh. @SID@ is replaced by
// the shell-quoted session id; @LANE@, @DOM@, @EPOCH@ and @PORT@ by the
// authenticated-channel configuration (names only — the capability is
// delivered as the first streamed line and never enters this file).
const inBandDispatcher = `# nocx in-band integration — dispatcher (POSIX sh).
# Sourced by the shell that was at the trusted prompt. Extracts this
# shell's hook script from the staged file and sources it with the
# integration environment set. Fail-open: any failure returns without
# changing the shell.
if [ -n "${__nocx_loaded:-}" ]; then
    return 2>/dev/null || exit 0
fi
if [ -z "${NOCX_IB_SRC:-}" ]; then
    return 2>/dev/null || exit 0
fi
if [ -n "${ZSH_VERSION:-}" ] && [ -z "${BASH_VERSION:-}" ]; then
    __nocx_ib_section=NOCX_IB_ZSH
elif [ -n "${BASH_VERSION:-}" ]; then
    __nocx_ib_section=NOCX_IB_BASH
else
    __nocx_ib_section=NOCX_IB_POSIX
fi
__nocx_ib_tmp="$(mktemp "${TMPDIR:-/tmp}/nocx-ib.XXXXXX" 2>/dev/null)" || return 2>/dev/null || exit 0
sed -n "/^${__nocx_ib_section}_START$/,/^${__nocx_ib_section}_END$/p" "$NOCX_IB_SRC" | sed '1d;$d' > "$__nocx_ib_tmp"
NOCX_LIFECYCLE_LANE=@LANE@ NOCX_LIFECYCLE_DOMAIN=@DOM@ NOCX_LIFECYCLE_EPOCH=@EPOCH@ NOCX_LIFECYCLE_PORT=@PORT@ NOCX_SHELL_INTEGRATION=1 NOCX_PROMPT_MODE=marker-only NOCX_SESSION_ID=@SID@ . "$__nocx_ib_tmp"
rm -f "$__nocx_ib_tmp"
unset __nocx_ib_section __nocx_ib_tmp
return 0 2>/dev/null || exit 0
`

// inBandWrapperTemplate is the single line typed at the prompt. Built by
// concatenation so the READY OSC, the terminator and the completion marker
// are single-sourced constants.
//
// The FIRST streamed line is the per-epoch capability, written by the
// backend after READY; the wrapper captures it into __nocx_cap (a plain,
// non-exported shell variable) before anything is staged, so the staged
// file stays capability-free. The hooks clear the export attribute at
// source time (a user shell under `set -a` would otherwise auto-export the
// assignment); the wrapper itself cannot use `export -n` — zsh would read
// it as a nameref and dash rejects it.
//
// Backward-compatible by shape: a first line that is NOT 64 lowercase hex
// (a legacy payload streamed without a capability line) is treated as the
// first payload line instead, and the integration proceeds capability-free
// — a conventional terminal, which is the fail-open state for a shell with
// no authenticated channel.
const inBandWrapperTemplate = `saved=$(stty -g); NOCX_IB_SRC=$(mktemp "${TMPDIR:-/tmp}/nocx-ib.XXXXXX" 2>/dev/null) && stty raw -echo && printf '` + inBandReadyOSC + `' && IFS= read -r __nocx_cap && if [ "${#__nocx_cap}" = 64 ] && case "$__nocx_cap" in *[^0-9a-f]*) false;; esac; then : > "$NOCX_IB_SRC"; else printf '%s\n' "$__nocx_cap" > "$NOCX_IB_SRC"; __nocx_cap=; fi && while IFS= read -r __nocx_ib_line; do [ "$__nocx_ib_line" = "` + inBandTerminator + `" ] && break; printf '%s\n' "$__nocx_ib_line"; done >> "$NOCX_IB_SRC"; unset __nocx_ib_line; stty "$saved"; if grep -qx '` + inBandCompleteMarker + `' "$NOCX_IB_SRC" 2>/dev/null; then . "$NOCX_IB_SRC"; fi; rm -f "$NOCX_IB_SRC" 2>/dev/null`

// InBandBootstrap builds the in-band integration plan for the given session.
// The session id anchors NOCX_SESSION_ID in the payload — the same id the
// launcher would have embedded at session start, so the nested-session gate
// (nocx-4ff.13) treats the freshly integrated shell as the owning session.
//
// ch, when non-nil, carries the authenticated-channel configuration minted
// for this integration (lane, domain, epoch and the loopback port the
// kernel's transport listens on) and is substituted into the dispatcher.
// nil leaves the dispatcher capability-free and config-free: the hooks find
// no channel and the shell stays conventional — the safe state when the
// transport wiring has not minted a domain. The capability itself is never
// an argument here: the backend writes it into the pty as the first line of
// the raw-mode stream and it never crosses the renderer or a named file.
func (s *Impl) InBandBootstrap(sessionID string, ch *ChannelConfig) (InBandPlan, error) {
	if !sessionIDRe.MatchString(sessionID) {
		return InBandPlan{}, fmt.Errorf("shellintegration: invalid session id %q", sessionID)
	}
	lane, dom, epoch, port := "", "", "0", ""
	if ch != nil {
		lane = ShellQuote(ch.Lane)
		dom = ShellQuote(ch.Domain)
		epoch = fmt.Sprintf("%d", ch.Epoch)
		port = fmt.Sprintf("%d", ch.Port)
	}
	payload := inBandDispatcher
	payload = strings.ReplaceAll(payload, "@SID@", ShellQuote(sessionID))
	payload = strings.ReplaceAll(payload, "@LANE@", lane)
	payload = strings.ReplaceAll(payload, "@DOM@", dom)
	payload = strings.ReplaceAll(payload, "@EPOCH@", epoch)
	payload = strings.ReplaceAll(payload, "@PORT@", port)
	payload += inBandBashStart + "\n" + ensureTrailingNewline(bashScript) + inBandBashEnd + "\n"
	payload += inBandZshStart + "\n" + ensureTrailingNewline(zshScript) + inBandZshEnd + "\n"
	payload += inBandPosixStart + "\n" + ensureTrailingNewline(posixScript) + inBandPosixEnd + "\n"
	payload += inBandCompleteMarker + "\n"
	return InBandPlan{
		Wrapper:    inBandWrapperTemplate,
		Payload:    payload,
		Terminator: inBandTerminator,
	}, nil
}

// ensureTrailingNewline guarantees the framed sections stay whole lines: a
// script whose final byte is not \n would merge its last line with the END
// marker.
func ensureTrailingNewline(s string) string {
	if strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}
