package procwatch_test

// darwin is the platform that answers: kqueue's EVFILT_PROC delivers
// NOTE_EXEC for a process this backend started.
const observationSupported = true

// gateShell is zsh and not sh, because macOS's /bin/sh replaces its own image
// with bash milliseconds after it starts — measured, and exactly the event
// these tests are about, which would make it a gate that reports itself.
const gateShell = "/bin/zsh"
