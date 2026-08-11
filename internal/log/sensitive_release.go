//go:build release

package log

import "log/slog"

// sensitiveValue renders a placeholder and the length, never the bytes: a
// shipped binary must have no path that writes a user's keystrokes — and so
// their passwords — to a file, whatever the log level is set to. See the
// development half for why the other build shows them.
//
// The length survives because it answers the question the field actually
// asks, which is "is the pipe moving, and how much", and it says nothing
// about what moved.
func sensitiveValue(s Sensitive) slog.Value {
	return slog.GroupValue(
		slog.String("value", redactedPlaceholder),
		slog.Int("len", len(s)),
	)
}
