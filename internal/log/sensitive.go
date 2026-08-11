package log

import "log/slog"

// Sensitive wraps a value that a DEVELOPMENT build may log and a shipped
// build may not — user-typed bytes above all: the terminal's data plane
// carries exactly what the person at the keyboard pressed, so it carries
// every password they type into a program that asks for one.
//
// The decision lives HERE rather than at the call sites. A caller that has to
// remember to redact is a caller that will one day forget, and there is no
// way to audit "did every logger of user bytes make the right choice" across
// a codebase — whereas "is there a path from Sensitive to a shipped log line"
// is one file to read. The call site states WHAT the value is; this package
// states what is done with it.
//
// It works through slog.LogValuer, which the handler resolves at write time,
// so an unresolved Sensitive cannot leak through a Sprintf somewhere: the
// only rendering of it is the one below.
//
//	log.Debug("data frame", "payload", log.Sensitive(frame.Payload))
//
// Debug level is a separate, weaker guard and not a substitute for this one:
// levels are configuration and can be turned up in the field, while the build
// tag is chosen once when the artefact is made.
type Sensitive []byte

// LogValue renders the wrapped value according to the build. slog calls this
// when the attribute reaches a handler.
func (s Sensitive) LogValue() slog.Value { return sensitiveValue(s) }

// redactedPlaceholder is what a shipped build prints instead of the bytes.
// The LENGTH is kept because it answers the field question — "is the pipe
// moving, and how much" — without saying anything about what moved.
const redactedPlaceholder = "redacted"
