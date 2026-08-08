package control

import (
	"context"
	"strings"
	"sync"
)

// composite acquires several Admissions in a fixed order and releases all of
// them on failure of any.
type composite struct {
	name       string
	admissions []Admission
}

// NewComposite returns an Admission that acquires each of the given admissions
// in order and, if any of them refuses, releases every permit acquired so far
// before returning that rejection.
//
// The order is the contract, not an accident: acquire the conflict admission
// BEFORE the scarce execution permit, so work refused or waiting at the
// conflict gate never occupies an active worker permit (AD-8, constraint 4 of
// the executor contract). Otherwise conflicting requests fill every worker and
// unrelated work stalls.
func NewComposite(admissions ...Admission) Admission {
	names := make([]string, len(admissions))
	for i, a := range admissions {
		names[i] = a.Name()
	}
	return &composite{name: strings.Join(names, "+"), admissions: admissions}
}

// NewCompositeNonblocking combines several NON-BLOCKING admissions into one
// NonblockingAdmission, acquired in order with release of the parts already
// held on failure of any. It is the composite for the submission path
// (probe, dialog): every part's TryAcquire never blocks, so the composite's
// never does either, and the result satisfies NonblockingAdmission — the
// only type a bounded Submission accepts.
//
// The operation path composes WAITING domain gates with the lane through the
// plain NewComposite, whose result is a plain Admission acquired inside the
// task goroutine (operation Run); the two constructors encode the two
// admission classes (ADR-0024). A composite containing a waiting admission
// must not satisfy NonblockingAdmission, so it cannot be passed to
// NewBoundedSubmission by accident.
func NewCompositeNonblocking(admissions ...NonblockingAdmission) NonblockingAdmission {
	names := make([]string, len(admissions))
	plain := make([]Admission, len(admissions))
	for i, a := range admissions {
		names[i] = a.Name()
		plain[i] = a
	}
	return &nonblockingComposite{composite{
		name:       strings.Join(names, "+"),
		admissions: plain,
	}}
}

// nonblockingComposite is a composite whose parts are all non-blocking; the
// marker method is what lets it satisfy NonblockingAdmission while the plain
// composite (which may hold waiting gates) does not.
type nonblockingComposite struct {
	composite
}

func (n *nonblockingComposite) nonblocking() {}

func (c *composite) Name() string { return c.name }

func (c *composite) TryAcquire(ctx context.Context) (Permit, *Rejection) {
	permits := make([]Permit, 0, len(c.admissions))
	for _, a := range c.admissions {
		p, rej := a.TryAcquire(ctx)
		if rej != nil {
			for i := len(permits) - 1; i >= 0; i-- {
				permits[i].Release()
			}
			return nil, rej
		}
		permits = append(permits, p)
	}
	return &compositePermit{permits: permits}, nil
}

// compositePermit releases its parts in reverse acquisition order, exactly
// once. The once guards the composite's own contract rather than trusting
// every part to be idempotent: the parts can come from outside this package.
type compositePermit struct {
	permits []Permit
	once    sync.Once
}

func (p *compositePermit) Release() {
	p.once.Do(func() {
		for i := len(p.permits) - 1; i >= 0; i-- {
			p.permits[i].Release()
		}
	})
}
