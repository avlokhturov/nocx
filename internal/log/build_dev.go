//go:build !release

package log

// releaseBuild is what the sensitive-value tests assert against, so each
// states the behaviour of the build it was compiled into rather than being
// skipped in one of them.
const releaseBuild = false
