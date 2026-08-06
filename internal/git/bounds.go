package git

import "time"

// The work ceilings and retention cap, shared as policy between the
// implementations (spec §5.1 "Bounding"). The values are the unmeasured
// constants of spec §9, recorded there as risks rather than defects; each
// would be settled by the measurement its comment names.

// MaxStatusEntries is the retention cap for the status lists: the parser
// retains the first MaxStatusEntries records and keeps counting the rest.
// 5,000 is large enough that a real change set is never capped and small
// enough that a stray un-ignored node_modules is caught (spec §9.1).
const MaxStatusEntries = 5000

// MaxStatusBytes is the byte half of the status work ceiling. Counting past
// the retention point is a NUL scan that costs nothing, but
// --untracked-files=all makes git traverse the filesystem and format a record
// for every file, so a generated tree with millions of untracked files would
// hold a subprocess open for as long as the traversal takes. At the byte
// ceiling the stream is cut and the result is Completeness: cut with a lower
// bound. 16 MiB is roughly 150k records at the 100-byte typical record — far
// above the retention cap, so a merely-capped status still completes exactly.
const MaxStatusBytes = 16 << 20

// MaxStatusWallClock is the wall-clock half of the status work ceiling. The
// byte ceiling bounds what we read; this bounds a traversal that produces no
// output — a stuck filesystem, a network share — so the child cannot be held
// open silently. Together they are what make the cut state reachable below
// the record cap (spec §9.1, D9).
const MaxStatusWallClock = 30 * time.Second

// MaxStderrBytes is the per-invocation stderr bound. Past it, output is
// discarded — never an error, because a stderr writer that errors stops the
// reader while the child is still writing and deadlocks the invocation — and
// the result reports that the bound was reached.
const MaxStderrBytes = 64 << 10

// MaxCommitOutputBytes bounds each of stdout and stderr captured for a failed
// commit's account. The commit surface shows git's own account of a failure
// (D11), and a silently clipped account is a worse lie than one that admits
// it, so the bound is reported rather than hidden.
const MaxCommitOutputBytes = 64 << 10
