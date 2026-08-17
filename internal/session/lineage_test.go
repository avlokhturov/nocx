package session

// The parent edge (nocx-9hu9d): a child session records who opened it, by the
// FULL identity — (backendInstance, sessionId, sessionEpoch) — and the record
// is immutable from the moment the session exists until the registry drops it.
//
// The edge answers PROVENANCE ONLY. Nothing here grants a parent the right to
// observe or control a child; that is a separate revocable delegation and it
// belongs to a later epic (ADR-0020 §5 — a container never confers authority).
//
// The three refusals the bead names are driven here, plus the two bounds this
// change decided: an unresolvable parent and a lineage deeper than
// maxLineageDepth. Two of the five — a self-parent and a cycle — cannot be
// reached through Open today, because the child id is minted inside Open and
// no caller can name it; they are driven against the validator directly, which
// is the seam a later creator (a restore path, a delegated spawn) will hand a
// child id it did not just mint.

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
)

func newLineageReg(t *testing.T) *Reg {
	t.Helper()
	return New(log.NewSlogAdapter(nil), &stubPTYFactory{stub: pty.NewStub(log.NewSlogAdapter(nil))})
}

func openRoot(t *testing.T, r *Reg) Session {
	t.Helper()
	s, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	return s
}

func refOf(s Session) Ref {
	return Ref{ID: s.ID(), Identity: s.Identity()}
}

// The happy path: a child opened with a parent carries that parent's full
// identity, and a session opened without one carries no edge at all.
func TestOpen_ChildCarriesFullParentIdentity(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)

	if _, has := parent.Parent(); has {
		t.Fatal("a session opened with no parent must carry no edge")
	}

	child, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(parent)})
	if err != nil {
		t.Fatalf("open child: %v", err)
	}
	got, has := child.Parent()
	if !has {
		t.Fatal("child carries no parent edge")
	}
	if got.ID != parent.ID() {
		t.Errorf("parent id = %q, want %q", got.ID, parent.ID())
	}
	if got.Identity != parent.Identity() {
		t.Errorf("parent identity = %+v, want %+v", got.Identity, parent.Identity())
	}
}

// A parent naming a different backend instance is refused: the whole point of
// carrying the instance is that a record out of a previous backend can never
// resolve to a current session of the same id.
func TestOpen_RefusesParentFromAnotherBackendInstance(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)

	foreign := refOf(parent)
	foreign.Identity.InstanceID = InstanceID("ffffffffffffffffffffffffffffffff")

	_, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: foreign})
	if !errors.Is(err, ErrParentForeignInstance) {
		t.Fatalf("open with a foreign instance: err = %v, want ErrParentForeignInstance", err)
	}
}

// A parent naming a session this registry does not hold is refused, and so is
// one naming a session id at the wrong epoch — a later incarnation of an id is
// a different session, and admitting it would record a provenance that never
// happened.
func TestOpen_RefusesUnresolvableParent(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)

	absent := refOf(parent)
	absent.ID = NewID()
	if _, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: absent}); !errors.Is(err, ErrParentUnknown) {
		t.Fatalf("open naming an absent parent: err = %v, want ErrParentUnknown", err)
	}

	staleEpoch := refOf(parent)
	staleEpoch.Identity.Epoch++
	if _, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: staleEpoch}); !errors.Is(err, ErrParentUnknown) {
		t.Fatalf("open naming another incarnation: err = %v, want ErrParentUnknown", err)
	}
}

// A session may not be its own parent. Unreachable through Open — the child id
// is minted inside it — so it is driven at the validator, which is where a
// later creator that supplies its own child id would enter.
func TestValidateParent_RefusesSelfParent(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)

	err := r.validateParent(parent.ID(), refOf(parent))
	if !errors.Is(err, ErrParentSelf) {
		t.Fatalf("self-parent: err = %v, want ErrParentSelf", err)
	}
}

// A parent whose own ancestry reaches the child is a cycle, and the walk finds
// it however deep it sits. Same unreachability as the self-parent above, same
// seam.
func TestValidateParent_RefusesCycle(t *testing.T) {
	r := newLineageReg(t)
	a := openRoot(t, r)
	b, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(a)})
	if err != nil {
		t.Fatalf("open b: %v", err)
	}
	c, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(b)})
	if err != nil {
		t.Fatalf("open c: %v", err)
	}

	// a ← b ← c, and now a claims c as its parent: a is its own grandparent.
	if err := r.validateParent(a.ID(), refOf(c)); !errors.Is(err, ErrParentCycle) {
		t.Fatalf("cycle: err = %v, want ErrParentCycle", err)
	}
}

// The depth bound. A chain longer than maxLineageDepth is refused rather than
// walked: the edge is immutable, so every later ancestry walk pays for what is
// admitted here.
func TestOpen_RefusesLineageDeeperThanTheBound(t *testing.T) {
	r := newLineageReg(t)
	cur := openRoot(t, r)
	// The bound counts ANCESTORS: the root has none, and after this loop cur
	// has exactly maxLineageDepth of them — the last chain that is accepted.
	// One more open is the one that must be refused.
	for range maxLineageDepth {
		next, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(cur)})
		if err != nil {
			t.Fatalf("open within the bound: %v", err)
		}
		cur = next
	}
	if _, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(cur)}); !errors.Is(err, ErrTooDeep) {
		t.Fatalf("open past the bound: err = %v, want ErrTooDeep", err)
	}
}

// The interval, both ends: the edge exists from the moment the child exists
// until the registry drops the child's record — and NOT until the parent's
// record goes. A parent's death never rewrites, clears or invalidates the edge
// (D6), and neither does anything else: Parent returns a copy, so a caller
// cannot write back through the value it was handed.
func TestParentEdge_IsImmutableForTheSessionsLifetime(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)
	child, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: refOf(parent)})
	if err != nil {
		t.Fatalf("open child: %v", err)
	}
	want, _ := child.Parent()

	// The value handed out is a copy: writing to it must not reach the record.
	mutated, _ := child.Parent()
	mutated.ID = NewID()
	mutated.Identity.Epoch = 99
	if mutated == want {
		t.Fatal("the copy was not actually changed, so the assertion below proves nothing")
	}
	if got, _ := child.Parent(); got != want {
		t.Errorf("edge after mutating the returned copy = %+v, want %+v", got, want)
	}

	// The parent dies; the child keeps its provenance and keeps it unchanged.
	if err := r.Close(parent.ID()); err != nil {
		t.Fatalf("close parent: %v", err)
	}
	got, has := child.Parent()
	if !has {
		t.Fatal("the edge vanished when the parent closed: provenance is not liveness")
	}
	if got != want {
		t.Errorf("edge after the parent closed = %+v, want %+v", got, want)
	}

	// And opening further sessions does not disturb it.
	openRoot(t, r)
	if got, _ := child.Parent(); got != want {
		t.Errorf("edge after later opens = %+v, want %+v", got, want)
	}
}

// Nothing on the session surface may take a parent edge. This is the
// structural half of "cannot be rewritten": the value-copy test above proves a
// caller cannot write through what it is handed, and this proves there is no
// second door — the day someone adds SetParent, this fails.
func TestSessionSurface_HasNoParentMutator(t *testing.T) {
	iface := reflect.TypeOf((*Session)(nil)).Elem()
	refType := reflect.TypeOf(Ref{})
	for i := range iface.NumMethod() {
		m := iface.Method(i)
		for arg := range m.Type.NumIn() {
			if m.Type.In(arg) == refType {
				t.Errorf("Session.%s takes a Ref: the parent edge is immutable and nothing may write it after creation", m.Name)
			}
		}
	}
}

// A refused edge opens nothing. The validation runs before any process is
// spawned or any channel dialed, so a bad claim costs a shell nobody asked
// for — and leaves no session in the registry to inherit it.
func TestOpen_RefusedParentLeavesNoSession(t *testing.T) {
	r := newLineageReg(t)
	parent := openRoot(t, r)
	before := len(r.List())

	foreign := refOf(parent)
	foreign.Identity.InstanceID = InstanceID("ffffffffffffffffffffffffffffffff")
	if _, err := r.Open(context.Background(), Config{Cols: 80, Rows: 24, Parent: foreign}); err == nil {
		t.Fatal("open with a foreign instance succeeded")
	}
	if got := len(r.List()); got != before {
		t.Errorf("registry holds %d sessions after a refused open, want %d", got, before)
	}
}
