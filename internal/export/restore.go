package export

import (
	"context"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// Restore — the whole profiles + groups + settings + content transaction
// ---------------------------------------------------------------------------

// RestoreDeps are the repositories the restore operation writes into. The
// operation owns the SEQUENCING: it never hands these to a caller and asks
// the caller to keep the stores at one generation.
type RestoreDeps struct {
	// ProfileSvc is the single write path for profiles and groups. The
	// restore commits the imported configuration through AtomicImport and,
	// on a post-commit failure, returns the store to the captured
	// generation through AtomicReplace.
	ProfileSvc *profile.ProfileService
	// Settings snapshots the pre-restore settings generation for rollback.
	// It is the read side of the same registry the sink writes; nil means
	// no settings surface exists, and a settings-carrying export then
	// fails exactly as ImportConfiguration does (nocx-ojxa).
	Settings SettingsProvider
	// Sink applies the export's settings. nil with a settings-carrying
	// export is an error (nocx-ojxa).
	Sink SettingsSink
	// Content receives the private content block (conversations and
	// command history) as one atomic restore. nil is correct when the
	// payload carries no private content; carrying content with no store
	// is an error (nocx-ojxa).
	Content content.ContentDB
}

// RestoreImport applies a configuration export — and, when priv carries
// private content, that block too — to the local stores as ONE operation.
// It is the only supported way to import: the transport must not sequence
// the stores itself, because a failure between two independently sequenced
// phases leaves the stores at different generations and there is no
// sequence a caller can choose that avoids it.
//
// # The interval the operation guarantees
//
// The commit point is the first durable write: the single-file
// profiles+groups write inside AtomicImport. The invariant has two ends:
//
//   - BEFORE the commit point, cancellation is accepted and changes
//     nothing on disk. The only work before the first write is reading
//     snapshots (profiles, groups, settings) and validating the payload;
//     a cancelled context returns an error with every store untouched.
//
//   - FROM the commit point ON, the domain owns completion or rollback
//     and returns only after its invariant is restored. A settings or
//     content failure is followed by AtomicReplace + settings re-apply,
//     which return the configuration to the captured generation, and the
//     content restore is atomic in the store (ContentDB.RestorePrivate is
//     one transaction), so a failure leaves content at the OLD generation
//     too. The CLOSING EVENT of the interval is the error return: when
//     RestoreImport returns an error, every store is at the generation it
//     was in before the operation began.
//
// On success every store is at the NEW generation. A settings-carrying
// export imported without a sink fails, exactly as ImportConfiguration.
func RestoreImport(ctx context.Context, deps RestoreDeps, cfg *ConfigExport, priv *PrivateContent) (*ImportResult, error) {
	// Phase 1 — prepare. Nothing durable: read-only snapshots. Cancellation
	// is accepted up to the commit point; these are the only pre-commit
	// calls, and they change nothing on disk.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snap, err := deps.ProfileSvc.Snapshot()
	if err != nil {
		return nil, fmt.Errorf("restore: snapshot configuration: %w", err)
	}
	var oldSettings map[string]any
	if deps.Settings != nil {
		oldSettings, err = deps.Settings.All()
		if err != nil {
			return nil, fmt.Errorf("restore: snapshot settings: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Phase 2 — commit the configuration: profiles and groups in one
	// atomic file write, then settings in one atomic document write. The
	// first write is the commit point; past it the operation owns
	// completion or rollback (see the doc comment).
	result := deps.ProfileSvc.AtomicImport(stripSecretBindings(cfg.Profiles), cfg.Groups)
	if len(result.ImportErrors) > 0 {
		// AtomicImport validates the whole document before its single
		// write, so a validation failure left the store unchanged.
		return nil, fmt.Errorf("import failed: %s", result.ImportErrors[0])
	}
	// Whether a settings rollback is owed is decided here, by what the
	// export carries, not later by how much there was to put back.
	settingsApplied := len(cfg.Settings) > 0
	if err := restoreSettings(deps.Sink, cfg.Settings); err != nil {
		// Profiles committed; settings did not. Roll the profiles back
		// before reporting, or the two are split.
		if rbErr := rollbackConfig(deps, snap, oldSettings, settingsApplied); rbErr != nil {
			return nil, fmt.Errorf("%v (and rollback failed: %v)", err, rbErr)
		}
		return nil, err
	}

	// Phase 3 — private content, atomically in the store. A failure or a
	// cancellation here leaves content at the OLD generation (the store
	// aborts its transaction), so rolling the configuration back returns
	// every store to the OLD generation — never a split.
	if err := restorePrivateBlock(ctx, deps.Content, priv); err != nil {
		if rbErr := rollbackConfig(deps, snap, oldSettings, settingsApplied); rbErr != nil {
			return nil, fmt.Errorf("%v (and rollback failed: %v)", err, rbErr)
		}
		return nil, err
	}

	return &ImportResult{
		ProfilesImported: result.ProfilesImported,
		GroupsImported:   result.GroupsImported,
	}, nil
}

// rollbackConfig returns the configuration (profiles, groups, settings) to
// the captured pre-restore generation. It never consults ctx: the domain
// owns completion of the rollback, and a cancellation must not be able to
// strand the operation between generations.
//
// The settings half rests on ONE assumption, stated here because the
// correctness is otherwise a coincidence: SettingsProvider.All returns a
// COMPLETE snapshot, not only the keys that differ from their defaults. The
// wired adapter does — it hands back settings.Registry's whole snapshot —
// so re-applying it restores every key the failed import touched. If a
// future provider returned a sparse map, a key the import ADDED would have
// no entry to restore it from and would survive the rollback: profiles at
// the old generation, that setting at the new one, which is the split this
// operation exists to prevent. A provider that cannot promise completeness
// needs a sink that can delete, not a wider map here.
//
// The condition mirrors the apply side (restoreSettings applies whenever
// the export carries settings) rather than testing oldSettings for
// emptiness: whether a rollback is owed is a fact about what was applied,
// never about how much there was to put back.
func rollbackConfig(deps RestoreDeps, snap profile.ConfigSnapshot, oldSettings map[string]any, settingsApplied bool) error {
	if err := deps.ProfileSvc.AtomicReplace(snap); err != nil {
		return fmt.Errorf("roll back profiles and groups: %w", err)
	}
	if settingsApplied && deps.Sink != nil {
		if err := deps.Sink.Apply(oldSettings); err != nil {
			return fmt.Errorf("roll back settings: %w", err)
		}
	}
	return nil
}

// restorePrivateBlock applies the carried private content through the
// store's own atomic restore. It is a no-op when the payload carries
// nothing. A block that carries content with no store to put it in fails:
// silently dropping what the archive promised to carry is the defect this
// fixes (nocx-ojxa).
func restorePrivateBlock(ctx context.Context, db content.ContentDB, priv *PrivateContent) error {
	if priv == nil || !priv.Available {
		// The payload carries nothing to restore.
		return nil
	}
	if db == nil {
		return errors.New("restore private content: no content database is available")
	}
	return db.RestorePrivate(ctx, priv.Conversations, priv.CommandHistory)
}
