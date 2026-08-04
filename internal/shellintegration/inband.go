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
//     after raw mode is on, and stages the payload through
//     `sed -n '/^<terminator>$/q;p'` — so the payload stream ends at a
//     delimiter LINE, not a byte count, and a truncated or cancelled stream
//     still reaches the restore.
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
type InBandPlan struct {
	Wrapper    string
	Payload    string
	Terminator string
}

// sessionIDRe matches the 32-lowercase-hex session ids the registry mints
// (AD-7). The id is embedded into shell source, so anything else is refused
// rather than quoted into the payload.
var sessionIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// inBandDispatcher is the payload's header, sourced by the shell at the
// prompt. It must parse under bash, zsh and POSIX sh. @SID@ is replaced by
// the shell-quoted session id.
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
NOCX_SHELL_INTEGRATION=1 NOCX_PROMPT_MODE=marker-only NOCX_SESSION_ID=@SID@ . "$__nocx_ib_tmp"
rm -f "$__nocx_ib_tmp"
unset __nocx_ib_section __nocx_ib_tmp
return 0 2>/dev/null || exit 0
`

// inBandWrapperTemplate is the single line typed at the prompt. Built by
// concatenation so the READY OSC, the terminator and the completion marker
// are single-sourced constants.
const inBandWrapperTemplate = `saved=$(stty -g); NOCX_IB_SRC=$(mktemp "${TMPDIR:-/tmp}/nocx-ib.XXXXXX" 2>/dev/null) && stty raw -echo && printf '` + inBandReadyOSC + `' && sed -n '/^` + inBandTerminator + `$/q;p' > "$NOCX_IB_SRC"; stty "$saved"; if grep -qx '` + inBandCompleteMarker + `' "$NOCX_IB_SRC" 2>/dev/null; then . "$NOCX_IB_SRC"; fi; rm -f "$NOCX_IB_SRC" 2>/dev/null`

// InBandBootstrap builds the in-band integration plan for the given session.
// The session id anchors NOCX_SESSION_ID in the payload — the same id the
// launcher would have embedded at session start, so the nested-session gate
// (nocx-4ff.13) treats the freshly integrated shell as the owning session.
func (s *Impl) InBandBootstrap(sessionID string) (InBandPlan, error) {
	if !sessionIDRe.MatchString(sessionID) {
		return InBandPlan{}, fmt.Errorf("shellintegration: invalid session id %q", sessionID)
	}
	payload := strings.ReplaceAll(inBandDispatcher, "@SID@", shellQuote(sessionID))
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
