package local

// The factory's test-only seams live here, in a _test.go file, and that is
// the honest place for them: nothing in the product configures a shell, an
// environment or a status bound — production takes the defaults, and every
// caller of these four is a test. Declared in factory.go they were four
// functions `deadcode` reports unreachable from main(), and this repository
// refuses to baseline new dead code on purpose (the baseline updater only
// shrinks). A test-only export is not dead code; it is code the production
// build does not contain.

import "time"

// WithShell points the environment resolver at a specific shell binary
// instead of the detected one — the seam the resolver's failure and timeout
// tests drive through.
func WithShell(path string) Option { return func(o *options) { o.shell = path } }

// WithEnv pins the resolved environment instead of running the user's shell.
// It is the seam every test that must control what git sees drives through —
// a fake git on a fixture PATH, a PATH with no git, a real git behind a
// controlled HOME — and it reports EnvResolved: a pinned environment is a
// deliberate answer, not a degradation.
func WithEnv(env []string) Option { return func(o *options) { o.fixedEnv = env } }

// WithStatusEntries overrides the status retention cap. The default is
// git.MaxStatusEntries; a small cap makes a capped status reachable in tests
// without a five-thousand-file repository.
func WithStatusEntries(n int) Option { return func(o *options) { o.statusEntries = n } }

// WithStatusCeilings overrides the status work ceilings — the byte bound on
// the stream and the wall-clock bound on the traversal. The defaults are
// git.MaxStatusBytes and git.MaxStatusWallClock. Tests use this to make a
// cut reachable below the record cap.
func WithStatusCeilings(bytes int64, wall time.Duration) Option {
	return func(o *options) {
		o.statusBytes = bytes
		o.statusWall = wall
	}
}
