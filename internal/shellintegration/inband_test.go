package shellintegration

import (
	"strings"
	"testing"
)

// TestInBandBootstrap_WrapperShape pins the wrapper line's contract (spec
// §4.4 + ADR-0004): one line (readline submits a single line), the exact
// termios saved with `stty -g` and restored with `stty "$saved"` — never
// `stty sane` — raw mode entered before any payload byte, the READY OSC
// emitted only after raw mode is on, the payload staged through sed with a
// terminator line, the completion marker checked before ANY source, and the
// staging file removed on every path.
func TestInBandBootstrap_WrapperShape(t *testing.T) {
	p, err := New(nil).InBandBootstrap("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("InBandBootstrap: %v", err)
	}

	w := p.Wrapper
	if strings.ContainsAny(w, "\n\r") {
		t.Errorf("wrapper must be a single line so readline submits it as one command; got %q", w)
	}
	for _, want := range []string{
		"saved=$(stty -g)",              // exact prior termios captured
		"stty raw -echo",                // raw mode for the delivery: -echo keeps the 25 KB payload silent (GNU coreutils raw alone leaves ECHO set)
		`stty "$saved"`,                 // exact restore — the fence
		"\\033]1337;NOCX_IB_READY",      // READY OSC, emitted after stty raw
		"while IFS= read -r",            // payload staged by a shell-builtin line loop, NOT sed (nocx-pu4.3: busybox sed stalls on a pty stream)
		`= "NOCX_IB_EOF" ] && break`,    // the loop stops at the terminator LINE, like the old /^...$/q
		`printf '%s\n'`,                 // each staged line re-emitted byte-exact (IFS= and -r preserve it)
		"grep -qx '# nocx-ib-complete'", // nothing sourced without the completion marker
		`. "$NOCX_IB_SRC"`,              // the source
		"rm -f \"$NOCX_IB_SRC\"",        // cleanup on every path
	} {
		if !strings.Contains(w, want) {
			t.Errorf("wrapper missing %q; got %q", want, w)
		}
	}
	if strings.Contains(w, "sed -n") {
		t.Errorf("wrapper must stage with shell builtins, not sed — busybox sed reads one line ahead and blocks past the terminator on a pty (nocx-pu4.3); got %q", w)
	}
	for _, banned := range []string{"stty sane"} {
		if strings.Contains(w, banned) {
			t.Errorf("wrapper must never %q — it discards the user's custom modes; got %q", banned, w)
		}
	}
	if strings.Contains(w, "$(stty -g)") && !strings.Contains(w, "saved=$(stty -g)") {
		t.Errorf("wrapper captures stty -g but not into $saved")
	}
	// The READY OSC must be emitted between `stty raw` and the stage loop: the
	// frontend streams the payload only after READY, so READY proves raw mode
	// is already on (no echo, no line buffering, no readline merge).
	rawAt := strings.Index(w, "stty raw")
	readyAt := strings.Index(w, "NOCX_IB_READY")
	loopAt := strings.Index(w, "while IFS= read")
	if rawAt < 0 || readyAt < 0 || loopAt < 0 {
		t.Fatalf("wrapper lacks raw/ready/loop ordering anchors: %q", w)
	}
	if !(rawAt < readyAt && readyAt < loopAt) {
		t.Errorf("ordering wrong: stty raw must precede READY must precede the stage loop (raw=%d ready=%d loop=%d)", rawAt, readyAt, loopAt)
	}
	// The terminator must be a complete line on its own: the loop compares the
	// whole read line against it, so the frontend's \n-terminated terminator
	// stops the stage even mid-stream.
	if !strings.Contains(w, `"NOCX_IB_EOF" ] && break`) {
		t.Errorf("terminator must anchor the whole line: %q", w)
	}
}

// TestInBandBootstrap_PayloadFraming pins the payload contract: a POSIX-sh
// dispatcher header (shell detection, extraction of the right hook script,
// integration env set only for that script) followed by the three hook
// scripts framed by unique section markers, ending with the completion
// marker. The framing is what makes a truncated or stray-byte stream
// harmless: the completion marker is the LAST line, so a cut stream can
// never source a partial hook script, and stray bytes after the payload
// land outside every section range.
func TestInBandBootstrap_PayloadFraming(t *testing.T) {
	p, err := New(nil).InBandBootstrap("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("InBandBootstrap: %v", err)
	}
	payload := p.Payload

	if !strings.HasSuffix(payload, "# nocx-ib-complete\n") {
		t.Errorf("payload must end with the completion marker line; got suffix %q", payload[len(payload)-40:])
	}
	for _, want := range []string{
		"ZSH_VERSION", "BASH_VERSION", // dispatcher detects the shell from inside it
		"NOCX_IB_BASH_START", "NOCX_IB_BASH_END",
		"NOCX_IB_ZSH_START", "NOCX_IB_ZSH_END",
		"NOCX_IB_POSIX_START", "NOCX_IB_POSIX_END",
		"NOCX_SHELL_INTEGRATION=1",
		"NOCX_PROMPT_MODE=marker-only",
		"NOCX_SESSION_ID='0123456789abcdef0123456789abcdef'",
	} {
		if !strings.Contains(payload, want) {
			t.Errorf("payload missing %q", want)
		}
	}
	// The session id must be single-quoted so the payload survives any shell
	// quoting context.
	if !strings.Contains(payload, "NOCX_SESSION_ID='0123456789abcdef0123456789abcdef' .") {
		t.Errorf("session id must be single-quoted before the source; got %q", payload)
	}

	// Frame integrity: every section marker is on its own line, in order, and
	// no hook script contains a line that would truncate or corrupt the frame.
	lines := strings.Split(payload, "\n")
	sectionOrder := []string{
		"NOCX_IB_BASH_START", "NOCX_IB_BASH_END",
		"NOCX_IB_ZSH_START", "NOCX_IB_ZSH_END",
		"NOCX_IB_POSIX_START", "NOCX_IB_POSIX_END",
	}
	idx := 0
	for _, want := range sectionOrder {
		for ; idx < len(lines); idx++ {
			if lines[idx] == want {
				break
			}
		}
		if idx >= len(lines) {
			t.Fatalf("section marker %q not found as a whole line", want)
		}
	}
	// The terminator must never appear as a payload line: sed would quit
	// early and the stage would truncate.
	for i, ln := range lines {
		if ln == inBandTerminator {
			t.Errorf("payload line %d is the terminator %q — sed would quit early", i, ln)
		}
	}
	// Script content must not collide with the frames: a script line equal to
	// a section marker would open/close a frame early and corrupt the
	// extracted script.
	for name, script := range map[string]string{
		"nocx.bash":  bashScript,
		"nocx.zsh":   zshScript,
		"nocx.posix": posixScript,
	} {
		for _, ln := range strings.Split(script, "\n") {
			if strings.HasPrefix(ln, "NOCX_IB_") || ln == inBandCompleteMarker {
				t.Errorf("%s contains the reserved line %q", name, ln)
			}
		}
	}
}

// TestInBandBootstrap_RejectsBadSessionID pins the fail-closed half: a
// session id that is not the 32-hex shape the ownership protocol anchors
// must be refused, never embedded.
func TestInBandBootstrap_RejectsBadSessionID(t *testing.T) {
	for _, sid := range []string{"", "short", strings.Repeat("g", 32), "0123456789abcdef0123456789abcdef "} {
		if _, err := New(nil).InBandBootstrap(sid); err == nil {
			t.Errorf("InBandBootstrap(%q): expected an error", sid)
		}
	}
}

// TestInBandBootstrap_NeverNUL pins the transport constraint: the payload
// crosses a pty as typed text; a NUL byte would be at best line-noise and at
// worst an injection. The launcher payloads already guarantee this; the
// in-band payload must too.
func TestInBandBootstrap_NeverNUL(t *testing.T) {
	p, err := New(nil).InBandBootstrap("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("InBandBootstrap: %v", err)
	}
	if strings.ContainsRune(p.Wrapper, '\x00') || strings.ContainsRune(p.Payload, '\x00') {
		t.Error("wrapper/payload must not contain NUL bytes")
	}
}

// TestInBandBootstrap_DispatcherFramingExtra asserts the framing survives
// stray bytes AFTER the payload: extra bytes land between the last section
// and the terminator, i.e. outside every extraction range, so the sourced
// script is byte-identical to the embedded one.
func TestInBandBootstrap_DispatcherFramingExtra(t *testing.T) {
	p, err := New(nil).InBandBootstrap("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("InBandBootstrap: %v", err)
	}
	// The completion marker line is the boundary: everything before it is the
	// payload; the marker line itself proves completeness.
	markerAt := strings.LastIndex(p.Payload, "# nocx-ib-complete")
	if markerAt < 0 {
		t.Fatal("payload lacks the completion marker")
	}
	head := p.Payload[:markerAt]
	for _, section := range []string{"NOCX_IB_BASH_START", "NOCX_IB_ZSH_START", "NOCX_IB_POSIX_START"} {
		start := strings.Index(head, section)
		if start < 0 {
			t.Fatalf("payload lacks section %q", section)
		}
	}
}
