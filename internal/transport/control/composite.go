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
