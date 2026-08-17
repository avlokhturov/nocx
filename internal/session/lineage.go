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
// Why the full identity rather than a bare parentId: the identity is what
// tells a record from a previous backend instance, or a previous incarnation
// of the same id, from the session in front of you (nocx-3oupk). A bare id
// re-resolves to whatever holds that id NOW, which is exactly the ambiguity
// the identity exists to remove — and once written the edge is never revisited,
// so an ambiguity admitted here is permanent.

import (
	"errors"
	"fmt"
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
	ErrParentSelf = errors.New("a session cannot be its own parent")
	// ErrParentCycle: the proposed parent's own ancestry reaches the child.
	ErrParentCycle = errors.New("parent edge would close a cycle")
	// ErrTooDeep: the chain the edge would join is longer than the bound.
	ErrTooDeep = errors.New("lineage is deeper than the bound")
)

// maxLineageDepth bounds how many ancestors a session may have. Chosen, not
// inherited: the edge is immutable, so every walk anything ever does over an
// ancestry — the strip's grouping, a later delegation check, a projection —
// pays for the depth admitted here, on input a caller chooses. 64 is far past
// any chain a person opens by hand (the deepest the product can produce today
// is one tab opening the next), and it is the same order as writeQueueDepth:
// a bound that only a machine can reach.
//
// It is a refusal rather than a truncation on purpose. A truncated edge would
// record a parent that is not the parent, which is the one thing a provenance
// record may never do.
const maxLineageDepth = 64

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
	if parent.ID == child {
		return ErrParentSelf
	}

	at := parent
	for depth := 1; depth <= maxLineageDepth; depth++ {
		s, ok := r.sessions[at.ID]
		// SameIncarnation is the single owner of "does this record name this
		// session" (nocx-3oupk); the id, the instance and the epoch must all
		// agree, and asking it here rather than comparing fields is what keeps
		// one answer to that question.
		if !ok || !at.Identity.SameIncarnation(at.ID, s) {
			return fmt.Errorf("%w: %s", ErrParentUnknown, at.ID)
		}
		next, has := s.Parent()
		if !has {
			return nil
		}
		if next.ID == child {
			return fmt.Errorf("%w: through %s", ErrParentCycle, at.ID)
		}
		at = next
	}
	return fmt.Errorf("%w of %d", ErrTooDeep, maxLineageDepth)
}
