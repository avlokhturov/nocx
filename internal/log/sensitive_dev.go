//go:build !release

package log

import (
	"log/slog"
	"strconv"
)

// sensitiveValue renders the bytes, because this is a development build and
// the whole point of marking a value Sensitive is that a developer debugging
// an input-routing defect needs to see WHICH keystrokes arrived — a question
// that cannot be answered from the far side of a socket. See the release half
// for the other side of the trade.
//
// Quoted rather than raw: user-typed bytes are control characters as often as
// not — \r, \x03, escape sequences — and an unquoted log line would be
// reinterpreted by whatever terminal reads the log.
func sensitiveValue(s Sensitive) slog.Value {
	return slog.StringValue(strconv.Quote(string(s)))
}
