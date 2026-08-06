package git

import (
	"fmt"

	"github.com/shady2k/nocx/internal/session"
)

// Domain error markers for the git package. Transport switches on these to
// surface the right user-facing state; each wraps a distinguishable type the
// UI layer can map to an action, the way internal/ssh/errors.go does for
// connection failures. Invocation failures that carry no state of their own
// (a git command that exits non-zero) are ordinary fmt errors whose message
// includes git's own output — the transport re-polls on any of them.

// ErrUnknownBinding — Acquire or Close named a binding id that does not exist
// or is already closed. A binding id is not a bearer token; it is also
// unguessable (minted from crypto/rand), so reaching this error through
// guessing is not possible.
type ErrUnknownBinding struct {
	ID string
}

func (e *ErrUnknownBinding) Error() string {
	return fmt.Sprintf("git: unknown binding %q", e.ID)
}

// ErrNotOwned — the caller does not Own the binding's session (D15). The
// binding exists; the caller may not use it. This is the authorisation check
// that lives inside Acquire so no handler can forget it.
type ErrNotOwned struct {
	ID        string
	SessionID session.ID
}

func (e *ErrNotOwned) Error() string {
	return fmt.Sprintf("git: binding %q belongs to session %q, which the caller does not own", e.ID, e.SessionID)
}

// ErrHandleReleased — a method was called on a Handle after its release func
// ran. The handle is valid from Acquire until release and invalid after;
// this error is the second end of that interval.
type ErrHandleReleased struct{}

func (e *ErrHandleReleased) Error() string { return "git: handle released" }

// ErrNothingToCommit — Commit was refused before invocation because nothing
// is staged. Running git commit here would run the pre-commit hook and then
// fail confusingly; the refusal happens first (spec §5.1 "commit.go").
type ErrNothingToCommit struct{}

func (e *ErrNothingToCommit) Error() string { return "git: nothing is staged to commit" }

// ErrAmendUnborn — Commit with amend=true was refused before invocation
// because the branch is unborn: there is nothing to amend, and git's own
// answer ("You have nothing to amend") is a post-hoc refusal of an operation
// we already know is impossible.
type ErrAmendUnborn struct{}

func (e *ErrAmendUnborn) Error() string { return "git: cannot amend a commit on an unborn branch" }

// ErrConflicted — StageAll or UnstageAll was refused while any entry is
// conflicted (D19). Both operations are destructive in exactly that state:
// git add -A marks the conflict resolved using the marker-laden worktree
// file, and bare git reset deletes .git/MERGE_HEAD — silently aborting the
// merge. Measured on git 2.55, not reasoned.
type ErrConflicted struct {
	Path string
}

func (e *ErrConflicted) Error() string {
	return fmt.Sprintf("git: cannot stage or unstage all while %q is conflicted", e.Path)
}
