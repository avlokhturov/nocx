package session

// The parent edge (nocx-9hu9d). A session records who opened it, by the full
// identity — (backendInstance, sessionId, sessionEpoch) — and the record is
// immutable from the moment the session exists until the registry drops it.
//
// The edge answers PROVENANCE ONLY: it says "A created B" and nothing else. It
// never confers the right to observe or control anything — that is a separate,
// revocable delegation and it belongs to a later epic (ADR-0020 §5: a
// container never confers authority). Nothing in this file reads a parent to
// decide whether an operation is allowed, and nothing later may make it,
// because the answer would then have two owners (AD-8).
//
// The SHAPE of the edge — no self-parent, no cycle, no chain past the bound —
// lives in internal/lineage since nocx-isoph.1, because a tab records its
// parent the same way and one rule may not have two implementations. What is
// still this file's is everything about what a SESSION is: a live incarnation
// of this backend instance, which is a question nothing outside this package
// can answer.
//
// Why the full identity rather than a bare parentId: the identity is what
// tells a record from a previous backend instance, or a previous incarnation
// of the same id, from the session in front of you (nocx-3oupk). A bare id
// re-resolves to whatever holds that id NOW, which is exactly the ambiguity
// the identity exists to remove — and once written the edge is never revisited,
// so an ambiguity admitted here is permanent.

import (
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/lineage"
)

// Ref names one session incarnation completely: which session, and which
// incarnation of it. It is the shape the parent edge carries and the shape an
// observation about a session is addressed to — a value, not a handle, so it
// can be written down, sent over the wire, and compared to a live session long
// after the thing it names has gone.
type Ref struct {
	ID       ID
	Identity Identity
}

// Zero reports whether the ref names nothing. A session with a zero parent ref
// is a root: it was not opened by another session.
func (r Ref) Zero() bool { return r == Ref{} }

// The refusals. Each is a distinct sentinel because each is a different
// statement about the claim, and a caller — the transport, mapping this onto a
// JSON-RPC error — should not have to read a message to tell them apart.
var (
	// ErrParentUnknown: no live session of that identity. Either nothing holds
	// the id, or something does and it is a different incarnation.
	ErrParentUnknown = errors.New("parent names no session held by this registry")
	// ErrParentForeignInstance: the claim names another backend instance. A
	// record out of a previous backend can never resolve to a current session,
	// so admitting it would record a provenance that cannot be true here.
	ErrParentForeignInstance = errors.New("parent names a different backend instance")
	// ErrParentSelf: a session cannot be its own parent.
	ErrParentSelf = lineage.ErrSelf
	// ErrParentCycle: the proposed parent's own ancestry reaches the child.
	ErrParentCycle = lineage.ErrCycle
	// ErrTooDeep: the chain the edge would join is longer than the bound.
	ErrTooDeep = lineage.ErrTooDeep
)

// The three sentinels above are internal/lineage's own, re-exported under this
// package's names rather than restated: they are verdicts about the SHAPE of
// an ancestry, which is the thing that package owns, and a second errors.New
// with the same sentence would be two values a caller has to know to check
// both of. The two above them stay here because they are verdicts about what a
// SESSION is — a live incarnation of this backend instance — and nothing
// outside this package can reach that question (nocx-isoph.1).

// maxLineageDepth bounds how many ancestors a session may have. The bound is
// internal/lineage's, and the reasoning for its value lives there; it is
// named here because this package's tests build a chain of exactly that
// length.
const maxLineageDepth = lineage.MaxDepth

// validateParent decides whether child may record parent as its edge. It is
// the single owner of that question: Open calls it before anything is spawned,
// and a later creator that mints its own child id (a restore path, a delegated
// spawn) enters here too rather than repeating the rules.
//
// The check is at ADMISSION and is never repeated. That is deliberate and it
// is what makes the edge immutable rather than merely unwritten-again: the one
// moment the backend can verify "A created B" is while A is still in front of
// it. Afterwards the edge is provenance, and provenance does not stop being
// true when its subject dies — a parent that exits leaves its children's edges
// exactly as they were (D6).
func (r *Reg) validateParent(child ID, parent Ref) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.validateParentLocked(child, parent)
}

// validateParentLocked is validateParent with r.mu already held — the form
// Open needs, so the walk sees one consistent registry rather than a map
// changing underneath it.
func (r *Reg) validateParentLocked(child ID, parent Ref) error {
	if parent.ID == "" || parent.Identity.InstanceID == "" || parent.Identity.Epoch == 0 {
		return fmt.Errorf("%w: the claim is incomplete", ErrParentUnknown)
	}
	// The instance first, because it is the only component that can be judged
	// without looking anything up, and it is the one whose failure means the
	// claim could never be true here rather than merely is not true now.
	if parent.Identity.InstanceID != r.instanceID {
		return fmt.Errorf("%w: %s", ErrParentForeignInstance, parent.Identity.InstanceID)
	}
	// Self, cycle and depth belong to internal/lineage — the same three rules
	// a tab's parent edge is admitted by (nocx-isoph.1). What stays here is
	// the resolver, because only this registry can answer "does this record
	// name a session I hold": SameIncarnation is the single owner of that
	// question (nocx-3oupk), and the id, the instance and the epoch must all
	// agree. The walk is over Refs rather than ids for the same reason — a
	// bare id re-resolves to whatever holds it NOW.
	return lineage.Validate(parent,
		func(at Ref) bool { return at.ID == child },
		func(at Ref) (Ref, bool, error) {
			s, ok := r.sessions[at.ID]
			if !ok || !at.Identity.SameIncarnation(at.ID, s) {
				return Ref{}, false, fmt.Errorf("%w: %s", ErrParentUnknown, at.ID)
			}
			next, has := s.Parent()
			return next, has, nil
		})
}
