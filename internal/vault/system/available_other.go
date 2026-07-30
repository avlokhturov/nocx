//go:build !linux

package system

// SecretServiceAvailable reports whether a running freedesktop.org Secret
// Service is reachable. Off Linux there is no such thing, so this is always
// false — macOS and Windows reach their keychains through their own APIs, not
// through org.freedesktop.secrets.
//
// This stub exists so the symbol is present on every platform. Without it the
// Linux-only definition would compile fine here and break the darwin build the
// moment any cross-platform code called it, which is a failure nobody would
// see until the release job ran.
func SecretServiceAvailable() bool { return false }
