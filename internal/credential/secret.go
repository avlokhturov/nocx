// Package credential provides the Secret type: a non-serializable wrapper
// for plaintext secrets that renders as [REDACTED] everywhere except the
// explicit Use callback.
package credential

import (
	"encoding"
	"encoding/json"
	"fmt"
	"log/slog"
)

// redacted is the canonical rendering of a Secret through every non-binding
// format (String, GoString, LogValue). It is intentionally not a valid
// JSON string token on its own so a misconfigured encoder cannot mistake it
// for real data.
const redacted = "[REDACTED]"

// errSecretNotSerializable is returned by MarshalJSON and MarshalText. It
// names the type so a caller that tries to serialise one finds out at the
// call site, not by shipping "[REDACTED]" where a password was expected.
var errSecretNotSerializable = fmt.Errorf("credential.Secret is not serializable; use Secret.Use to access plaintext")

// Secret wraps a plaintext secret so it cannot be marshaled by accident.
// A struct that embeds or holds a Secret will fail json.Marshal rather
// than emit the value, and every string/log renderer returns [REDACTED].
//
// Plaintext is available only through Use, which bounds the value's
// lifetime to a callback and never hands it out as a string. Callers that
// need a string copy must do so deliberately, inside Use, and are
// responsible for clearing it — see the package brief for the trap.
type Secret struct {
	// value is unexported so a reflect-based encoder cannot reach it via
	// field assignment, and json.Marshal cannot see it (no exported fields).
	value []byte
}

// NewSecret constructs a Secret from a plaintext string. The caller's
// string is copied so later mutation of the source does not affect the
// held secret; use Secret.Use to read it back.
func NewSecret(plaintext string) Secret {
	// Copy so the caller cannot mutate the held bytes after handoff.
	b := make([]byte, len(plaintext))
	copy(b, plaintext)
	return Secret{value: b}
}

// NewSecretBytes is the byte-slice form of NewSecret for callers that
// already hold []byte (e.g. a decrypted key). It copies and clears nothing
// of the caller's slice.
func NewSecretBytes(plaintext []byte) Secret {
	b := make([]byte, len(plaintext))
	copy(b, plaintext)
	return Secret{value: b}
}

// Use runs fn with the plaintext bytes. The plaintext is available only
// for the duration of fn; callers must not retain references to the slice
// after fn returns. Returning an error propagates fn's failure.
//
// This is the single binding accessor. A helper that copies the bytes out
// (e.g. `var s string; secret.Use(func(b []byte) error { s = string(b);
// return nil })`) reintroduces exactly what the type exists to prevent —
// prefer passing Use to the consumer instead.
func (s Secret) Use(fn func([]byte) error) error {
	return fn(s.value)
}

// IsEmpty reports whether the secret holds no plaintext. A zero-value
// Secret and one built from "" both report true.
func (s Secret) IsEmpty() bool {
	return len(s.value) == 0
}

// String renders [REDACTED]. It satisfies fmt.Stringer so the default
// %s/%v verbs and any error wrapping the Secret stay safe.
func (s Secret) String() string {
	return redacted
}

// GoString renders [REDACTED] for the %#v verb. Without it, %#v would
// print the struct fields (and though value is unexported, the verb still
// emits credential.Secret{value:[]byte{...}} via reflect in some
// contexts) — this guarantees the redaction.
func (s Secret) GoString() string {
	return redacted
}

// Format implements fmt.Formatter so every verb renders [REDACTED]. This
// covers %s, %v, %d, %x and any other verb a caller might reach for; it
// is belt-and-suspenders on top of Stringer/GoString and is what makes
// fmt.Sprintf("%v", secret) provably safe regardless of verb.
func (s Secret) Format(f fmt.State, _ rune) {
	_, _ = f.Write([]byte(redacted))
}

// LogValue returns an slog.Value that renders [REDACTED]. slog reaches
// for LogValue automatically when a Secret is passed as an attribute, so
// `slog.Info("connected", "password", secret)` cannot leak.
func (s Secret) LogValue() slog.Value {
	return slog.StringValue(redacted)
}

// MarshalJSON refuses to serialize a Secret. Returning an error (rather
// than a redacted string) makes the failure loud at the call site: a
// struct that embeds Secret will fail json.Marshal instead of silently
// shipping "[REDACTED]" where a real value was expected.
func (s Secret) MarshalJSON() ([]byte, error) {
	return nil, errSecretNotSerializable
}

// MarshalText refuses to encode a Secret as text. encoding/json falls back
// to MarshalText for types that do not implement MarshalJSON when a Secret
// appears as a map key or in a TextMarshaler slot; refusing here closes
// that path too.
func (s Secret) MarshalText() ([]byte, error) {
	return nil, errSecretNotSerializable
}

// Compile-time guarantees that Secret satisfies the redaction interfaces.
var (
	_ fmt.Stringer           = Secret{}
	_ fmt.GoStringer         = Secret{}
	_ fmt.Formatter          = Secret{}
	_ slog.LogValuer         = Secret{}
	_ json.Marshaler         = Secret{}
	_ encoding.TextMarshaler = Secret{}
)
