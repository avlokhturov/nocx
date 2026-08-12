package log

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// A password typed into a running ssh arrives on the data plane as ordinary
// keystrokes, so "the bytes a user typed" and "a secret" are the same thing
// there. These two tests are the pair: the development build must SHOW them,
// because a value nobody can read is a log nobody can debug with, and the
// shipped build must not, whatever the level is set to.
//
// Both run in every build; each asserts the behaviour of the build it is
// compiled into, so neither can pass by being skipped.
func TestSensitive_LogsAccordingToTheBuild(t *testing.T) {
	var buf bytes.Buffer
	lg := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	NewSlogAdapter(lg).Debug("data frame", "payload", Sensitive("hunter2\r"))

	out := buf.String()
	if releaseBuild {
		if strings.Contains(out, "hunter2") {
			t.Fatalf("a release build wrote the user's bytes to the log:\n%s", out)
		}
		if !strings.Contains(out, redactedPlaceholder) {
			t.Fatalf("a release build must say something in place of the bytes:\n%s", out)
		}
		// The length survives: it is what answers "is the pipe moving".
		if !strings.Contains(out, "len=8") {
			t.Fatalf("a release build must keep the length:\n%s", out)
		}
		return
	}
	if !strings.Contains(out, "hunter2") {
		t.Fatalf("a development build must show the bytes, or it cannot be debugged with:\n%s", out)
	}
	// Quoted, so a \r in the payload cannot be reinterpreted by whatever
	// terminal reads the log.
	if !strings.Contains(out, `\r`) {
		t.Fatalf("a development build must quote control bytes:\n%s", out)
	}
}
