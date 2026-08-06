package discovery

import (
	"bytes"
	"strings"
)

// sentinel is the fixed framing marker every probe command emits first and
// last on stdout. A sample without it is rejected WHOLE: a forced command, a
// login banner or a policy wrapper can prepend text, and we never scan
// arbitrary stdout for plausible-looking port numbers (spec §3.1). Versioned
// — bump when the probe protocol changes, so old parsers reject new output
// instead of misreading it.
const sentinel = "NOCX-PD/1"

var sentinelBytes = []byte(sentinel)

// Probe commands — fixed constants, never interpolated with user-controlled
// values. Each wraps the probe with the leading and trailing sentinel and
// preserves the probe's exit status across the trailing printf (the shell's
// exit status is the LAST command's, so without the explicit `exit "$e"`
// every probe would report success).
const (
	ssCmd             = `printf 'NOCX-PD/1\n'; LC_ALL=C ss -H -lntp; e=$?; printf 'NOCX-PD/1\n'; exit "$e"`
	netstatCmd        = `printf 'NOCX-PD/1\n'; netstat -lntp; e=$?; printf 'NOCX-PD/1\n'; exit "$e"`
	busyboxNetstatCmd = `printf 'NOCX-PD/1\n'; netstat -ltn; e=$?; printf 'NOCX-PD/1\n'; exit "$e"`
	lsofCmd           = `printf 'NOCX-PD/1\n'; lsof -nP -iTCP -sTCP:LISTEN; e=$?; printf 'NOCX-PD/1\n'; exit "$e"`
	sockstatCmd       = `printf 'NOCX-PD/1\n'; sockstat -4 -l; e=$?; printf 'NOCX-PD/1\n'; exit "$e"`
)

// step is one probe on the ladder: the fixed command, the parser for its
// dialect, and the exit status that means "ran fine, nothing matched" (lsof
// exits 1 with no matches — a valid empty sample, not a failure).
type step struct {
	name        string
	cmd         string
	parse       func(body []byte) ([]Listener, bool)
	noMatchExit int
}

// probeLadder is the capability-selection order (spec §5): ss → netstat
// (flags verified by the run itself, never hopeful — a -lntp rejection
// caches netstat and the next step verifies busybox's -ltn) → busybox
// netstat (detected explicitly; -p may be unavailable, so process evidence
// is unsupported) → lsof → sockstat → unavailable.
var probeLadder = []*step{
	{name: "ss", cmd: ssCmd, parse: parseSS},
	{name: "netstat", cmd: netstatCmd, parse: parseNetstat},
	{name: "busybox-netstat", cmd: busyboxNetstatCmd, parse: parseBusyboxNetstat},
	{name: "lsof", cmd: lsofCmd, parse: ParseLsof, noMatchExit: 1},
	{name: "sockstat", cmd: sockstatCmd, parse: parseSockstat},
}

// ladderIndex returns the ladder position of the named probe, or 0 when
// unknown (an unknown name means no selection — start at the top).
func ladderIndex(name string) int {
	for i, st := range probeLadder {
		if st.name == name {
			return i
		}
	}
	return 0
}

// splitFrame validates the sentinel framing of an exec's stdout and returns
// the body between the leading and trailing sentinel lines.
//
// leading is false when the output does not start with the sentinel — a
// framing violation: the exec did not run our probe, so the whole sample is
// rejected. trailing is false when the body was cut short — the output bound
// was hit or the remote died mid-write — an incomplete table that must not
// surface as "no ports".
func splitFrame(out []byte) (body []byte, leading, trailing bool) {
	trimmed := bytes.TrimSuffix(out, []byte("\n"))
	if len(trimmed) == 0 {
		return nil, false, false
	}
	lines := bytes.Split(trimmed, []byte("\n"))
	if !bytes.Equal(lines[0], sentinelBytes) {
		return nil, false, false
	}
	if !bytes.Equal(lines[len(lines)-1], sentinelBytes) {
		return nil, true, false
	}
	return bytes.Join(lines[1:len(lines)-1], []byte("\n")), true, true
}

// notFoundOnStderr reports whether stderr says the tool was not found — the
// shell's "sh: ss: not found" / "command not found" — independent of the
// exit status, for shells that report it with a non-127 status.
func notFoundOnStderr(stderr []byte) bool {
	low := strings.ToLower(string(stderr))
	return strings.Contains(low, "not found") || strings.Contains(low, "no such file")
}

// stderrExcerpt bounds the stderr carried on a Sample for diagnostics: the
// design shows truncated stderr, never an uncontrolled dump of remote output
// (spec §6).
const stderrExcerptCap = 2 << 10

func stderrExcerpt(b []byte) string {
	if len(b) > stderrExcerptCap {
		return string(b[:stderrExcerptCap]) + " [truncated]"
	}
	return string(b)
}
