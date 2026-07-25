package credential

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestSecretMarshalJSONErrors(t *testing.T) {
	s := NewSecret("hunter2")

	// Direct marshal of the Secret itself.
	if _, err := json.Marshal(s); err == nil {
		t.Fatal("json.Marshal(Secret) should error, got nil")
	} else if !strings.Contains(err.Error(), "Secret") {
		t.Errorf("error should name the Secret type, got: %v", err)
	}

	// Marshal of a struct containing a Secret — the load-bearing case.
	type login struct {
		User string `json:"user"`
		Pass Secret `json:"pass"`
	}
	if _, err := json.Marshal(login{User: "alice", Pass: s}); err == nil {
		t.Fatal("json.Marshal of struct containing Secret should error")
	} else if !strings.Contains(err.Error(), "Secret") {
		t.Errorf("struct marshal error should name the Secret type, got: %v", err)
	}
}

func TestSecretMarshalTextErrors(t *testing.T) {
	s := NewSecret("hunter2")
	// A type that embeds Secret as a text-typed field still cannot encode:
	// encoding/json calls MarshalText when no MarshalJSON is preferred, and
	// a custom encoder using TextMarshaler must also fail.
	if _, err := s.MarshalText(); err == nil {
		t.Fatal("MarshalText should error")
	} else if !strings.Contains(err.Error(), "Secret") {
		t.Errorf("MarshalText error should name the Secret type, got: %v", err)
	}
}

func TestSecretFormatsRedacted(t *testing.T) {
	s := NewSecret("hunter2")

	cases := map[string]string{
		"%s":  redacted,
		"%v":  redacted,
		"%#v": redacted,
		"%d":  redacted,
		"%x":  redacted,
	}
	for verb, want := range cases {
		if got := fmt.Sprintf(verb, s); got != want {
			t.Errorf("Sprintf(%q, secret) = %q, want %q", verb, got, want)
		}
	}

	// fmt.Stringer direct.
	if got := s.String(); got != redacted {
		t.Errorf("String() = %q, want %q", got, redacted)
	}
	if got := s.GoString(); got != redacted {
		t.Errorf("GoString() = %q, want %q", got, redacted)
	}

	// Plaintext must never appear in any rendered form.
	for _, verb := range []string{"%s", "%v", "%#v", "%d", "%x"} {
		if strings.Contains(fmt.Sprintf(verb, s), "hunter2") {
			t.Errorf("Sprintf(%q, secret) leaked plaintext", verb)
		}
	}
}

func TestSecretSlogRedacted(t *testing.T) {
	s := NewSecret("hunter2")

	// Assert on emitted log bytes, not on a struct field — per the brief.
	var buf bytes.Buffer
	h := slog.NewTextHandler(&buf, nil)
	logger := slog.New(h)
	logger.Info("connected", "password", s)

	out := buf.String()
	if strings.Contains(out, "hunter2") {
		t.Errorf("slog output leaked plaintext: %s", out)
	}
	if !strings.Contains(out, "password=[REDACTED]") {
		t.Errorf("slog output should render [REDACTED], got: %s", out)
	}
}

func TestSecretUseHandsPlaintext(t *testing.T) {
	s := NewSecret("hunter2")

	var got string
	err := s.Use(func(b []byte) error {
		got = string(b)
		return nil
	})
	if err != nil {
		t.Fatalf("Use returned error: %v", err)
	}
	if got != "hunter2" {
		t.Errorf("Use callback got %q, want hunter2", got)
	}
}

func TestSecretUsePropagatesError(t *testing.T) {
	s := NewSecret("hunter2")
	want := fmt.Errorf("callback failed")
	err := s.Use(func(b []byte) error { return want })
	if err != want {
		t.Errorf("Use error = %v, want %v", err, want)
	}
}

func TestSecretIsEmpty(t *testing.T) {
	var zero Secret
	if !zero.IsEmpty() {
		t.Error("zero Secret should be empty")
	}
	if !NewSecret("").IsEmpty() {
		t.Error("NewSecret(\"\") should be empty")
	}
	if NewSecret("x").IsEmpty() {
		t.Error("NewSecret(\"x\") should not be empty")
	}
}

func TestSecretNewSecretCopies(t *testing.T) {
	// Mutating the source string after handoff must not affect the secret.
	// (Strings are immutable in Go, but the byte copy matters for the
	// bytes-form constructor; this test documents the contract.)
	src := []byte{'a', 'b', 'c'}
	s := NewSecretBytes(src)
	src[0] = 'Z'
	var got []byte
	_ = s.Use(func(b []byte) error { got = append(got, b...); return nil })
	if string(got) != "abc" {
		t.Errorf("NewSecretBytes did not copy: got %q, want abc", string(got))
	}
}
