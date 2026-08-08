package export_test

import (
	"context"
	"errors"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/export"
)

// Whether a settings rollback is owed is a fact about what the import
// APPLIED, never about how much there was to put back. An earlier version
// decided it by testing the captured snapshot for emptiness, so a machine
// with nothing set yet — restoring a backup onto a fresh install is the
// obvious case — would have had the export's settings applied and then left
// standing while profiles rolled back. That is the split generation this
// operation exists to prevent, and it survived only because the wired
// provider happens never to hand back an empty map.
func TestRestoreImport_SettingsRollbackIsDecidedByWhatWasApplied(t *testing.T) {
	svc, _ := newRestoreProfileService(t)
	sink := &fakeSettingsSink{}

	_, err := export.RestoreImport(context.Background(), export.RestoreDeps{
		ProfileSvc: svc,
		// The pre-restore generation is EMPTY: nothing had been set.
		Settings: &fakeSettingsProvider{values: map[string]any{}},
		Sink:     sink,
		Content:  &fakeContentDB{restoreErr: errors.New("content store unavailable")},
	}, newGeneration(), &export.PrivateContent{
		Available:      true,
		CommandHistory: []content.CommandRecord{{Command: "ssh prod"}},
	})
	if err == nil {
		t.Fatal("the content failure should have failed the restore")
	}

	// Two Apply calls: the import's, then the rollback's. Before the fix the
	// rollback was skipped because the captured map was empty, so the sink
	// saw exactly one.
	if sink.applyCalls < 2 {
		t.Fatalf("settings rollback was skipped: sink saw %d Apply calls, want the import plus a rollback", sink.applyCalls)
	}
}
