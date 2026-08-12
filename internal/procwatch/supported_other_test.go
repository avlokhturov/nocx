//go:build !darwin

package procwatch_test

// Everywhere else the honest answer is that nothing is observed; see the
// package comment for why a /proc poll is not the fallback.
const observationSupported = false

// gateShell is never started here — every test that needs a child skips —
// but the helper still has to compile.
const gateShell = "/bin/sh"
