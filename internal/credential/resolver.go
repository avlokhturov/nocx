package credential

// WHO MAY RAISE THE UNLOCK — the declaration this file exists to force
// (nocx-k41yv, ADR-0032 as amended).
//
// Transport shape is not intent. An operation may resolve material while it
// is still a request or after it has created a durable run; a report may travel
// through the same pipes and must remain quiet. Every resolution therefore
// declares one of two stances:
//
//   - Operation(reason) asks the vault to become unsealed, waits, and reads.
//   - Report() reads only to describe state and translates sealed to
//     ErrSealedQuiet, which cannot raise a prompt.
//
// There is no default. The zero stance returns ErrStanceUndeclared, and a call
// that omits the stance does not compile. Raw Get belongs only to the
// composition-only MaterialStore used to build this resolver.

import (
	"context"
	"errors"
)

// Stance declares why secret material is being resolved. Its zero value is
// invalid; callers construct one with Operation or Report.
type Stance struct {
	kind   stanceKind
	reason string
}

type stanceKind uint8

const (
	stanceUndeclared stanceKind = iota
	stanceOperation
	stanceReport
)

// Operation declares a user-initiated operation that cannot continue without
// the secret. reason is shown by the vault-owned unlock prompt.
func Operation(reason string) Stance {
	return Stance{kind: stanceOperation, reason: reason}
}

// Report declares a read whose purpose is to describe state. It never raises
// an unlock prompt.
func Report() Stance {
	return Stance{kind: stanceReport}
}

// ErrStanceUndeclared is what a resolution that names no stance gets
// instead of a secret. It is a programming error, surfaced rather than
// guessed at: guessing is how the stance stopped being declared last time.
var ErrStanceUndeclared = errors.New("credential: resolution names no stance")

// ErrSealedQuiet is a sealed vault reported as a fact by a ToReport
// resolution. It deliberately neither wraps the vault's own sealed error
// nor repeats its words: the transport's normalizer recognizes a sealed
// failure by exactly those two fingerprints, so this error cannot become
// the canonical shape and therefore cannot raise a prompt. Callers that
// need to say "sealed" in a status field test for this.
var ErrSealedQuiet = errors.New("the vault cannot answer right now")

// Resolver is the stanced read seam over a SecretStore. Every consumer that
// resolves material on behalf of a person holds THIS, never the store: the
// store's Get has no stance to give, so a holder of the store can bypass
// the declaration, and a seam that can be bypassed is the one that was.
type Resolver interface {
	Resolve(ctx context.Context, id SecretID, why Stance) (Secret, error)
}

// NewResolver wraps a store. sealed recognizes the store's sealed condition.
// ensure raises and waits for the vault-owned unlock for operation reads. A
// nil ensure preserves the sealed error for test seams and headless consumers
// that have no prompt carrier.
func NewResolver(
	store MaterialStore,
	sealed func(error) bool,
	ensure func(context.Context, string) error,
) Resolver {
	return resolver{store: store, sealed: sealed, ensure: ensure}
}

// NewOperationResolver builds the operation-only seam used by connection and
// SSH layers. A store that owns EnsureUnsealed supplies it structurally; test
// stores and headless implementations preserve their ordinary read behavior.
func NewOperationResolver(store MaterialStore) Resolver {
	if store == nil {
		return nil
	}
	var ensure func(context.Context, string) error
	if unsealer, ok := store.(interface {
		EnsureUnsealed(context.Context, string) error
	}); ok {
		ensure = unsealer.EnsureUnsealed
	}
	return NewResolver(store, nil, ensure)
}

type resolver struct {
	store  MaterialStore
	sealed func(error) bool
	ensure func(context.Context, string) error
}

func (r resolver) Resolve(ctx context.Context, id SecretID, why Stance) (Secret, error) {
	switch why.kind {
	case stanceOperation:
		if r.ensure != nil {
			if err := r.ensure(ctx, why.reason); err != nil {
				return Secret{}, err
			}
		}
		return r.store.Get(ctx, id)
	case stanceReport:
		s, err := r.store.Get(ctx, id)
		if err != nil && r.sealed != nil && r.sealed(err) {
			return Secret{}, ErrSealedQuiet
		}
		return s, err
	default:
		return Secret{}, ErrStanceUndeclared
	}
}
