package pty

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

func TestLocalPty_ImplementsInterface(t *testing.T) {
	var _ Pty = (*LocalPty)(nil)
}

func TestLocalPty_SpawnAndWrite(t *testing.T) {
	lp := mustSpawn(t, 80, 24)
	defer func() { _ = lp.Close() }()

	n, err := lp.Write([]byte("echo hello\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n == 0 {
		t.Fatal("Write returned 0 bytes")
	}
}

func TestLocalPty_ReadReturnsOutput(t *testing.T) {
	lp := mustSpawn(t, 80, 24)
	defer func() { _ = lp.Close() }()

	_, err := lp.Write([]byte("echo hello\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	buf := make([]byte, 4096)
	var output strings.Builder
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		n, readErr := lp.Read(buf)
		if readErr != nil && readErr != io.EOF {
			t.Fatalf("Read: %v", readErr)
		}
		if n > 0 {
			output.Write(buf[:n])
			if strings.Contains(output.String(), "hello") {
				return
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	t.Fatalf("expected output to contain 'hello', got: %q", output.String())
}

func TestLocalPty_Resize(t *testing.T) {
	lp := mustSpawn(t, 80, 24)
	defer func() { _ = lp.Close() }()

	err := lp.Resize(context.Background(), 132, 43, 0, 0)
	if err != nil {
		t.Fatalf("Resize: %v", err)
	}
}

func TestLocalPty_CloseTwice(t *testing.T) {
	lp := mustSpawn(t, 80, 24)
	if err := lp.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := lp.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func mustSpawn(t testing.TB, cols, rows uint16) *LocalPty {
	t.Helper()
	lp, err := NewLocal(log.NewSlogAdapter(nil), Config{
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	return lp
}

// A macOS .app launched from Finder inherits no locale at all. The child shell
// then computes a non-UTF-8 stdout encoding and every Python/Rich/prompt_toolkit
// TUI silently downgrades non-ASCII output to '?' — which looks exactly like a
// font bug in the renderer. Fill the gap, but never override a deliberate choice.
func TestWithUTF8Locale(t *testing.T) {
	tests := []struct {
		name string
		env  []string
		want string // expected LANG entry, "" = must not be added
	}{
		{
			name: "adds LANG when the environment carries no locale at all (Finder launch)",
			env:  []string{"PATH=/usr/bin", "TERM=xterm-256color"},
			want: "LANG=en_US.UTF-8",
		},
		{
			name: "keeps an inherited LANG untouched",
			env:  []string{"LANG=ru_RU.UTF-8"},
			want: "",
		},
		{
			name: "respects a deliberate non-UTF-8 LANG",
			env:  []string{"LANG=C"},
			want: "",
		},
		{
			name: "LC_ALL alone is enough — do not add LANG",
			env:  []string{"LC_ALL=en_GB.UTF-8"},
			want: "",
		},
		{
			name: "LC_CTYPE alone is enough — do not add LANG",
			env:  []string{"LC_CTYPE=en_US.UTF-8"},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := withUTF8Locale(tt.env)

			var added []string
			for _, kv := range got {
				if !contains(tt.env, kv) {
					added = append(added, kv)
				}
			}

			if tt.want == "" {
				if len(added) != 0 {
					t.Fatalf("expected no additions, got %v", added)
				}
				return
			}
			if len(added) != 1 || added[0] != tt.want {
				t.Fatalf("expected exactly %q to be added, got %v", tt.want, added)
			}
		})
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func TestScrubLauncherSession(t *testing.T) {
	// nocx is developed from inside a coding agent, so its own process carries
	// that agent's session markers. Handing them to a user's shell made
	// `claude` in a tab think it was a child session and turn transcript
	// saving off — a terminal must not leak its launcher's identity.
	env := []string{
		"PATH=/usr/bin",
		"CLAUDECODE=1",
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_SESSION_ID=abc",
		"CLAUDE_PID=123",
		// Coding agents export these for their own tools; leaking them into a
		// PTY makes TUIs render black-and-white.
		"TERM=dumb",
		"NO_COLOR=1",
		"HOME=/Users/someone",
		// Not a session marker: stripping a credential would break the very
		// tool this fix exists for.
		"CLAUDE_API_KEY=secret",
	}

	got := scrubLauncherSession(env)

	for _, unwanted := range []string{"CLAUDECODE=", "CLAUDE_CODE_CHILD_SESSION=", "CLAUDE_CODE_SESSION_ID=", "CLAUDE_PID=", "TERM=", "NO_COLOR="} {
		for _, kv := range got {
			if strings.HasPrefix(kv, unwanted) {
				t.Errorf("launcher session marker survived: %q", kv)
			}
		}
	}

	for _, wanted := range []string{"PATH=/usr/bin", "HOME=/Users/someone", "CLAUDE_API_KEY=secret"} {
		found := false
		for _, kv := range got {
			if kv == wanted {
				found = true
			}
		}
		if !found {
			t.Errorf("scrub removed something it should have kept: %q", wanted)
		}
	}
}

// resolveShell is the one place that decides which shell a local session runs,
// and the reason it is a function rather than four lines inside NewLocal is
// that the decision has to be observable.
//
// It was not. `SHELL` was read straight from the environment and nothing
// recorded the answer, so the shell a run drove was whatever the host had
// exported and no artifact said which. That is not cosmetic here: nocx.bash
// emits the OSC 636 command snapshot and nocx.zsh does not, so the shell
// decides whether tab completion ever learns a command name. Reading one CI
// failure on 2026-08-07 meant downloading trace artifacts and guessing the
// shell from which dotfiles appeared in a file tree, and the guess was still
// not conclusive (nocx-z9s9.9).
func TestResolveShell(t *testing.T) {
	const nixos = "/run/current-system/sw/bin/bash"

	tests := []struct {
		name       string
		env        map[string]string
		present    map[string]bool
		wantShell  string
		wantSource shellSource
	}{
		{
			name:       "SHELL wins when the environment states one",
			env:        map[string]string{"SHELL": "/usr/bin/zsh"},
			present:    map[string]bool{"/bin/bash": true},
			wantShell:  "/usr/bin/zsh",
			wantSource: shellFromEnv,
		},
		{
			name:       "no SHELL: the first candidate that exists",
			present:    map[string]bool{nixos: false, "/bin/bash": true},
			wantShell:  "/bin/bash",
			wantSource: shellFromDetected,
		},
		{
			name:       "no SHELL: candidate order is honoured",
			present:    map[string]bool{nixos: true, "/bin/bash": true},
			wantShell:  nixos,
			wantSource: shellFromDetected,
		},
		{
			name:       "a stripped-down container has neither",
			present:    map[string]bool{},
			wantShell:  "/bin/sh",
			wantSource: shellFromFallback,
		},
		{
			name:       "an empty SHELL is not a statement",
			env:        map[string]string{"SHELL": ""},
			present:    map[string]bool{"/bin/bash": true},
			wantShell:  "/bin/bash",
			wantSource: shellFromDetected,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			shell, source := resolveShell(
				func(k string) string { return tt.env[k] },
				func(p string) bool { return tt.present[p] },
			)
			if shell != tt.wantShell {
				t.Errorf("shell = %q, want %q", shell, tt.wantShell)
			}
			if source != tt.wantSource {
				t.Errorf("source = %q, want %q", source, tt.wantSource)
			}
		})
	}
}

// And the paired assertion AGENTS.md asks for: on an ordinary machine the
// decision is not merely correct, it reaches the log. A resolver nobody can
// read the output of is the arrangement this bead exists to remove.
func TestNewLocal_LogsTheShellItResolved(t *testing.T) {
	var buf bytes.Buffer
	lp, err := NewLocal(
		log.NewSlogAdapter(slog.New(slog.NewTextHandler(&buf, nil))),
		Config{Cols: 80, Rows: 24},
	)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	defer func() { _ = lp.Close() }()

	line := buf.String()
	if !strings.Contains(line, "local pty shell resolved") {
		t.Fatalf("no resolved-shell line in the log:\n%s", line)
	}
	// The path and where it came from, both: "bash" without "SHELL said so"
	// leaves the next reader doing exactly the inference this removes.
	if !strings.Contains(line, "shell=") || !strings.Contains(line, "source=") {
		t.Errorf("the line names neither the shell nor its source:\n%s", line)
	}
}
