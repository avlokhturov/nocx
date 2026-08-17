// Package lineage owns the SHAPE of a provenance edge: a node records the
// node that created it, the record is immutable, and the chain it joins is
// acyclic and bounded.
//
// It exists because that shape now has two carriers. A session records the
// session that opened it (internal/session, nocx-9hu9d) and a tab records the
// tab that spawned it (internal/content, nocx-isoph.1), and the second one
// arrived asking for exactly the rules the first already had. Two
// implementations of one rule is the regression with a delay fuse AGENTS.md
// names: they agree everywhere anybody looks and disagree somewhere nobody
// did. So internal/session's rules moved here and internal/session calls
// them; there is still exactly one implementation, and it now has two callers
// rather than a copy.
//
// What did NOT move is everything that is about WHAT a node is. Only a
// session registry can say whether a claim names a live incarnation of this
// backend instance; only the store can say whether a tab row exists. Those
// stay with the carrier and are reported through the resolver below, which is
// why Validate takes one instead of a table: this package knows the shape of
// an ancestry and deliberately nothing about its nodes.
//
// The edge answers PROVENANCE ONLY — "A created B" and nothing else. It never
// confers the right to observe or control anything (ADR-0020 §5: a container
// never confers authority), and nothing here reads an ancestry to decide
// whether an operation is allowed.
package lineage

import (
	"errors"
	"fmt"
)

// MaxDepth bounds how many ancestors a node may have. Chosen, not inherited:
// the edge is immutable, so every walk anything ever does over an ancestry —
// the strip's grouping, a later delegation check, a projection — pays for the
// depth admitted here, on input a caller chooses. 64 is far past any chain a
// person opens by hand (the deepest the product can produce today is one tab
// opening the next), and it is a bound only a machine can reach.
//
// It is a refusal rather than a truncation on purpose. A truncated edge would
// record a parent that is not the parent, which is the one thing a provenance
// record may never do.
const MaxDepth = 64

var (
	// ErrSelf: a node cannot be its own parent.
	ErrSelf = errors.New("a node cannot be its own parent")
	// ErrCycle: the proposed parent's own ancestry reaches the child.
	ErrCycle = errors.New("parent edge would close a cycle")
	// ErrTooDeep: the chain the edge would join is longer than the bound.
	ErrTooDeep = errors.New("lineage is deeper than the bound")
)

// Validate decides whether a child may record parent as its lineage edge.
//
// isChild reports whether a node IS the child the edge is being written for —
// a predicate rather than a value because the child is not always the same
// type as the ancestry's nodes: a session's ancestry is walked as full
// incarnation refs while the child is only an id, and folding the two into one
// comparison is how the incarnation would quietly stop being checked.
//
// parentOf resolves one node's parent: the parent, whether it has one, and any
// reason the node could not be resolved at all. A node that resolves to
// (_, false, nil) is a root and ends the walk successfully. An error is
// returned to the caller unchanged — it is the carrier's own statement about
// its own nodes (internal/session's "no live session of that identity", the
// store's "no such tab"), and rewording it here would put a second owner on a
// question this package cannot answer.
//
// The check is at ADMISSION and is never repeated. That is deliberate and it
// is what makes the edge immutable rather than merely unwritten-again: the one
// moment a creator can be verified is while it is still in front of us.
// Afterwards the edge is provenance, and provenance does not stop being true
// when its subject dies (D6) — a parent that exits leaves its children's edges
// exactly as they were.
func Validate[T any](parent T, isChild func(T) bool, parentOf func(T) (T, bool, error)) error {
	if isChild(parent) {
		return ErrSelf
	}
	at := parent
	for depth := 1; depth <= MaxDepth; depth++ {
		next, has, err := parentOf(at)
		if err != nil {
			return err
		}
		if !has {
			return nil
		}
		if isChild(next) {
			return fmt.Errorf("%w: through %v", ErrCycle, at)
		}
		at = next
	}
	return fmt.Errorf("%w of %d", ErrTooDeep, MaxDepth)
}
