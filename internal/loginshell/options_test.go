package loginshell

// The resolver's test-only seams live here, in a _test.go file, and that is
// the honest place for them: nothing in the product replaces a lookup —
// production takes the defaults, which is the whole point of a package whose
// answer must be the machine's own. Declared in loginshell.go they are three
// functions `deadcode` reports unreachable from main(), and this repository
// refuses to baseline new dead code on purpose. A test-only seam is not dead
// code; it is code the production build does not contain. Same arrangement,
// and the same reasoning, as internal/git/local's options_test.go.

// WithAccountReader replaces the OS account-database lookup — the seam that
// lets a test ask what nocx does with an answer this machine does not give:
// a zsh account on a bash host, a reader that fails, a record naming a shell
// that is not installed.
func WithAccountReader(f func() (string, error)) Option {
	return func(r *resolver) { r.account = f }
}

// WithLookupEnv replaces the environment lookup, so the $SHELL step can be
// exercised without exporting anything into the test process.
func WithLookupEnv(f func(string) string) Option {
	return func(r *resolver) { r.lookupEnv = f }
}

// WithExists replaces the "is this path on the machine" probe. It is what
// makes the candidate list and the not-installed cases testable at all: the
// alternative is a suite whose answer depends on which shells the machine
// running it happens to have.
func WithExists(f func(string) bool) Option {
	return func(r *resolver) { r.exists = f }
}
