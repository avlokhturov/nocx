package lineage_test

// The five refusals and the two acceptances, against an ancestry the test
// owns outright: a map from node to parent. internal/session's own suite
// exercises the same rules through a live registry, and internal/content's
// through the store — this one is what says the rules are the SAME rules.

import (
	"errors"
	"fmt"
	"testing"

	"github.com/shady2k/nocx/internal/lineage"
)

// chain builds a parentOf over an explicit map. A node absent from the map is
// unresolvable — the carrier's own failure, reported as errAbsent.
var errAbsent = errors.New("no such node")

func chain(parents map[string]string, present ...string) func(string) (string, bool, error) {
	known := map[string]bool{}
	for _, p := range present {
		known[p] = true
	}
	for child, parent := range parents {
		known[child] = true
		known[parent] = true
	}
	return func(at string) (string, bool, error) {
		if !known[at] {
			return "", false, fmt.Errorf("%w: %s", errAbsent, at)
		}
		p, has := parents[at]
		return p, has, nil
	}
}

func is(child string) func(string) bool {
	return func(at string) bool { return at == child }
}

// A parent with no ancestry of its own is a root, and a root is always a
// legal parent. The paired "and on a normal machine it succeeds" for every
// refusal below.
func TestRootParentIsAccepted(t *testing.T) {
	if err := lineage.Validate("a", is("b"), chain(nil, "a")); err != nil {
		t.Fatalf("root parent: %v", err)
	}
}

// A chain shorter than the bound is walked to its root and accepted.
func TestChainWithinTheBoundIsAccepted(t *testing.T) {
	parents := map[string]string{"c": "b", "b": "a"}
	if err := lineage.Validate("c", is("d"), chain(parents)); err != nil {
		t.Fatalf("chain within the bound: %v", err)
	}
}

func TestSelfParentIsRefused(t *testing.T) {
	if err := lineage.Validate("a", is("a"), chain(nil, "a")); !errors.Is(err, lineage.ErrSelf) {
		t.Fatalf("self-parent: err = %v, want ErrSelf", err)
	}
}

// The child is already an ancestor of the proposed parent, so the edge would
// close a cycle. It is found by the walk, not by the resolver.
func TestCycleIsRefused(t *testing.T) {
	parents := map[string]string{"c": "b", "b": "a"}
	if err := lineage.Validate("c", is("a"), chain(parents)); !errors.Is(err, lineage.ErrCycle) {
		t.Fatalf("cycle: err = %v, want ErrCycle", err)
	}
}

// The bound counts the CHILD's ancestors, and both ends of it are asserted:
// the last accepted chain gives the child exactly MaxDepth ancestors, and one
// more is refused. n0 is a root, so n(k) has k ancestors and a child of n(k)
// would have k+1.
func TestDepthBoundIsTheLastAcceptedChain(t *testing.T) {
	parents := map[string]string{}
	name := func(i int) string { return fmt.Sprintf("n%d", i) }
	for i := 1; i <= lineage.MaxDepth; i++ {
		parents[name(i)] = name(i - 1)
	}
	// A child of n(MaxDepth-1) has exactly MaxDepth ancestors: accepted.
	if err := lineage.Validate(name(lineage.MaxDepth-1), is("new"), chain(parents)); err != nil {
		t.Fatalf("a child with exactly MaxDepth ancestors: %v", err)
	}
	// A child of n(MaxDepth) would have MaxDepth+1: refused.
	if err := lineage.Validate(name(lineage.MaxDepth), is("new"), chain(parents)); !errors.Is(err, lineage.ErrTooDeep) {
		t.Fatalf("one past the bound: err = %v, want ErrTooDeep", err)
	}
}

// The resolver's own failure — the carrier saying "I do not hold that node" —
// reaches the caller unchanged. Wrapping it here would put a second owner on
// a question this package cannot answer.
func TestResolverFailureReachesTheCallerUnchanged(t *testing.T) {
	err := lineage.Validate("ghost", is("b"), chain(nil))
	if !errors.Is(err, errAbsent) {
		t.Fatalf("unresolvable parent: err = %v, want errAbsent", err)
	}
	// And it is refused rather than smuggled in as one of this package's own
	// verdicts: an unknown node is not a root.
	if errors.Is(err, lineage.ErrCycle) || errors.Is(err, lineage.ErrTooDeep) || errors.Is(err, lineage.ErrSelf) {
		t.Fatalf("carrier failure reported as a lineage verdict: %v", err)
	}
}

// A failure partway UP the chain is reported too — the walk does not treat an
// unresolvable ancestor as the end of the ancestry, which would accept an edge
// whose depth nobody measured.
func TestUnresolvableAncestorIsRefused(t *testing.T) {
	parents := map[string]string{"b": "missing-a"}
	resolve := func(at string) (string, bool, error) {
		if at == "missing-a" {
			return "", false, fmt.Errorf("%w: %s", errAbsent, at)
		}
		p, has := parents[at]
		return p, has, nil
	}
	if err := lineage.Validate("b", is("c"), resolve); !errors.Is(err, errAbsent) {
		t.Fatalf("unresolvable ancestor: err = %v, want errAbsent", err)
	}
}
