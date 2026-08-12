package app

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/pty"
)

// readShellEnviron returns the environment the shell on the other end of pt
// actually holds — every name, every value, byte for byte.
//
// It replaces a per-OS pair that read the kernel's copy: /proc/<pid>/environ
// on linux, sysctl kern.procargs2 on darwin. The darwin half could never
// work. Since macOS 10.15 the kernel returns a process's ENVIRONMENT only to
// that process; ask about any other pid — a direct child of the caller
// included — and KERN_PROCARGS2 answers with argc and argv and stops. Measured
// on this branch: 103 bytes for the session's shell, of which none were
// environment, with the buffer sized from kern.argmax exactly as Apple's own
// ps does it. `ps -Eww` is the same syscall and prints the same nothing. So
// the assertion that "the capability reaches no environment" was failing in
// internal/app and passing VACUOUSLY in internal/shellintegration, which
// scanned an empty map and found no capability in it (nocx-58gq, nocx-65v6).
//
// Asking the process is not a weaker question — it is a slightly larger one.
// The kernel's copy is the environment at exec; `env` in the shell is that
// plus whatever the rc files exported, which is exactly where the capability
// would have to leak from if the rcfile mechanism were wrong. And it is the
// set a child of this shell would inherit, which is what ADR-0024 decision 2
// is about.
//
// NUL-delimited and base64'd because the transport is a terminal: base64
// survives the line discipline, and `env -0` means a value carrying a space,
// a newline or a quote arrives intact — a whitespace-split of `ps` output
// would silently lose it, and a leak check that can miss is worse than none.
func readShellEnviron(t *testing.T, pt pty.Pty) map[string]string {
	t.Helper()

	// The markers are split across two quoted strings so the shell's own
	// echo of the typed line — which the pty sends straight back — cannot
	// contain them. Only the OUTPUT has them joined.
	const (
		begin = "NOCXENVBEGIN:"
		end   = ":NOCXENVEND"
	)
	cmd := "printf 'NOCXENV''BEGIN:'; /usr/bin/env -0 | base64 | tr -d '\\n'; printf ':NOCXENV''END\\n'\n"
	if _, err := pt.Write([]byte(cmd)); err != nil {
		t.Fatalf("write the environment probe: %v", err)
	}

	type read struct {
		b   []byte
		err error
	}
	reads := make(chan read, 16)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := pt.Read(buf)
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			reads <- read{chunk, err}
			if err != nil {
				return
			}
		}
	}()

	// Bounded, and the bound is the test's — pty.Pty has no read deadline,
	// so a shell that never answers must not be able to hold the package to
	// its own timeout (the failure this file's other half was filed for).
	var out strings.Builder
	deadline := time.After(20 * time.Second)
	for {
		select {
		case r := <-reads:
			out.Write(r.b)
			if i := strings.Index(out.String(), begin); i >= 0 {
				rest := out.String()[i+len(begin):]
				if j := strings.Index(rest, end); j >= 0 {
					return decodeEnviron(t, rest[:j])
				}
			}
			if r.err != nil {
				t.Fatalf("the shell closed before answering the environment probe: %v (read %q)", r.err, out.String())
			}
		case <-deadline:
			t.Fatalf("the shell never answered the environment probe (read %q)", out.String())
		}
	}
}

func decodeEnviron(t *testing.T, encoded string) map[string]string {
	t.Helper()
	// The terminal wraps long lines, so the payload arrives with CR and LF
	// inside it; base64 carries neither.
	clean := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, encoded)
	raw, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		t.Fatalf("decode the environment dump: %v", err)
	}
	env := map[string]string{}
	for _, record := range strings.Split(string(raw), "\x00") {
		if i := strings.IndexByte(record, '='); i > 0 {
			env[record[:i]] = record[i+1:]
		}
	}
	if len(env) == 0 {
		t.Fatal("the environment dump decoded to no entries")
	}
	return env
}
