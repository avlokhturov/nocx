package vault

import (
	"context"
	"fmt"

	"github.com/shady2k/nocx/internal/credential"
)

// Phase tracks how far a cross-store operation progressed before interruption.
// The journal is written first, then the provider call (§4.2), because a
// go-keyring call that times out may still complete later — and an unjournalled
// late write would be permanently undiscoverable.
type Phase string

const (
	// PhasePrepared means the identifier was journaled but the provider has not
	// been called yet.
	PhasePrepared Phase = "prepared"

	// PhaseSecretWritten means the new secret was written to the provider but
	// the caller has not yet attached a metadata target.
	PhaseSecretWritten Phase = "secret-written"

	// PhaseMetadataRepointed means the metadata owner has been atomically
	// repointed to the new identifier. The old secret is still in the provider
	// and should be deleted best-effort.
	PhaseMetadataRepointed Phase = "metadata-repointed"
)

// JournalEntry records one in-flight cross-store operation. Identifiers and
// routing only — never secret bytes (ADR-0011 §4).
type JournalEntry struct {
	Op     string              `json:"op"`
	OldID  credential.SecretID `json:"oldId,omitempty"`
	NewID  credential.SecretID `json:"newId"`
	Target string              `json:"target"`
	Phase  Phase               `json:"phase"`
}

// String returns a compact representation for logging. It emits identifiers
// and routing only — never secret bytes.
func (e JournalEntry) String() string {
	if e.Op == "" {
		return "<cleared>"
	}
	return fmt.Sprintf("%s old=%s new=%s target=%q phase=%s", e.Op, e.OldID, e.NewID, e.Target, e.Phase)
}

// Reconcile processes journal entries left from an interrupted operation.
// It is idempotent: the second run is a no-op.
//
// Entries in PhasePrepared or PhaseSecretWritten with an empty Target
// represent a new secret that was never referenced by metadata — the orphan
// is deleted and the entry cleared.
//
// Entries in PhaseMetadataRepointed represent a completed metadata repoint
// with a possibly-stale old secret. The new secret is verified accessible,
// then the old secret is deleted best-effort.
//
// An entry whose provider is not in reg, or whose identifier is malformed,
// is retained (never cleared) and returned in the blocked slice. It is never
// re-routed to another provider (spec §6 invariant 5).
//
// doc is modified in place. The caller must save the document after Reconcile
// returns.
func Reconcile(ctx context.Context, doc *Document, reg *Registry) []JournalEntry {
	var blocked []JournalEntry

	for i := range doc.Journal {
		entry := &doc.Journal[i]
		if entry.Op == "" {
			continue // already cleared
		}

		providerID, err := parseID(entry.NewID)
		if err != nil {
			blocked = append(blocked, *entry)
			continue
		}

		wp, ok := reg.Writable(providerID)
		if !ok {
			// Provider unknown or not writable — retain and report.
			// Never re-route to another provider (spec §6).
			blocked = append(blocked, *entry)
			continue
		}

		switch entry.Phase {
		case PhasePrepared, PhaseSecretWritten:
			if entry.Target == "" {
				// Nothing downstream can have happened — the caller had not
				// yet attached a metadata target. Delete the orphan secret
				// and clear the entry.
				if err := wp.Delete(ctx, entry.NewID); err != nil {
					// Transient provider failure — retain the entry so the
					// orphan is retried on the next startup.
					blocked = append(blocked, *entry)
					continue
				}
				*entry = JournalEntry{}
			}
			// Non-empty target but phase not yet repointed: metadata was
			// changed atomically but the journal was not updated before the
			// crash. Retain for investigation — do not assume forward or back.

		case PhaseMetadataRepointed:
			// Verify the new secret is accessible.
			if _, err := wp.Get(ctx, entry.NewID); err != nil {
				blocked = append(blocked, *entry)
				continue
			}
			// Delete the old secret through its own provider — OldID and NewID
			// may route to different providers (cross-provider rotation).
			if entry.OldID != "" {
				oldProvID, err := parseID(entry.OldID)
				if err != nil {
					blocked = append(blocked, *entry)
					continue
				}
				oldWp, ok := reg.Writable(oldProvID)
				if !ok {
					blocked = append(blocked, *entry)
					continue
				}
				if err := oldWp.Delete(ctx, entry.OldID); err != nil {
					blocked = append(blocked, *entry)
					continue
				}
			}
			*entry = JournalEntry{}
		}
	}

	return blocked
}
