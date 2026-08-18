package content_test

// RecordCompleted — the ledger's write path for a command that already ended
// (nocx-rtg0.19), which is what history.record lands through now that
// command_history is gone.
//
// These assert the ROW a user's command becomes, and the two rules that make
// it safe: it is one transaction, and a pane that cannot be resolved costs the
// anchor rather than the command.

import (
	"context"
	"encoding/hex"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

func aCompletedCommand(intent string) content.CompletedCommand {
	return content.CompletedCommand{
		Client: "test-client",
		Env:    content.Environment{ID: "local", Kind: content.EnvLocal},
		Cwd:    "/repo",
		Intent: intent,
		Status: content.EntrySuccess,
	}
}

// The headline: a command the renderer reports lands as a closed entry with a
// finished execution, and comes back through the ordinary recall read. Before
// the cutover this row went to a table that could hold no output and had no
// anchor; nothing about the wire changed, only where it lands.
func TestRecordCompleted_WritesAClosedEntryWithItsExecution(t *testing.T) {
	ctx := context.Background()
	_, led := newLedger(t)

	id, err := led.RecordCompleted(ctx, aCompletedCommand("make ci"))
	if err != nil {
		t.Fatalf("RecordCompleted: %v", err)
	}
	if id == "" {
		t.Fatal("RecordCompleted returned an empty id — the backend mints one here")
	}

	got, err := led.Entry(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("Entry(%q) = %+v, %v", id, got, err)
	}
	if got.Phase != content.PhaseClosed || got.Status != content.EntrySuccess {
		t.Fatalf("entry phase/status = %q/%q, want closed/success", got.Phase, got.Status)
	}
	if got.Kind != content.EntryShell {
		t.Fatalf("entry kind = %q, want shell", got.Kind)
	}
	if got.Intent != "make ci" {
		t.Fatalf("entry intent = %q, want the command", got.Intent)
	}
	// ONE execution, and it is finished. A closed entry with no execution
	// would say a command was intended and nothing about whether it ran.
	if len(got.Executions) != 1 {
		t.Fatalf("%d executions, want exactly 1", len(got.Executions))
	}
	if got.Executions[0].EndedAt == nil {
		t.Fatal("the execution has no end — a command that is being reported has already ended")
	}
	// And it is on the ordinary recall read, not in a corner of its own.
	page, err := led.QueryEntries(ctx, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10})
	if err != nil {
		t.Fatalf("QueryEntries: %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].ID != id {
		t.Fatalf("recall page = %+v, want the recorded command", page.Entries)
	}
}

// The anchor arrives with the command when the pane is real (nocx-rtg0.28).
func TestRecordCompleted_AnchorsOnAPaneThatExists(t *testing.T) {
	ctx := context.Background()
	db, led := newLedger(t)
	aPaneUnder(t, db, "ws-1", "tab-1", "pane-1")

	in := aCompletedCommand("go test ./...")
	in.PaneID = strPtr("pane-1")
	id, err := led.RecordCompleted(ctx, in)
	if err != nil {
		t.Fatalf("RecordCompleted: %v", err)
	}
	got, _ := led.Entry(ctx, id)
	if got == nil || got.PaneID == nil || *got.PaneID != "pane-1" {
		t.Fatalf("entry paneId = %+v, want pane-1", got)
	}
}

// AND A PANE THE CHAIN DOES NOT HOLD MUST NOT COST THE COMMAND. This is the
// difference from Submit, which refuses: history.record's caller cannot fix
// the id, and a user losing a recorded command because a layout row was late
// is a worse answer than a block that cannot be restored into a pane.
func TestRecordCompleted_KeepsTheCommandWhenThePaneIsUnknown(t *testing.T) {
	ctx := context.Background()
	_, led := newLedger(t)

	in := aCompletedCommand("echo hi")
	in.PaneID = strPtr("pane-that-was-never-created")
	id, err := led.RecordCompleted(ctx, in)
	if err != nil {
		t.Fatalf("RecordCompleted with an unknown pane: %v — the command must survive", err)
	}
	got, _ := led.Entry(ctx, id)
	if got == nil {
		t.Fatal("no row: the command was lost to an unresolvable pane")
	}
	if got.PaneID != nil {
		t.Fatalf("paneId = %q, want nil rather than a dangling anchor", *got.PaneID)
	}
}

// `pending` is not an outcome. history.record reports commands that ended, so
// a status that means "not started yet" is a caller error rather than a row.
func TestRecordCompleted_RefusesAStatusThatIsNotAnOutcome(t *testing.T) {
	ctx := context.Background()
	_, led := newLedger(t)

	in := aCompletedCommand("sleep 100")
	in.Status = content.EntryPending
	if _, err := led.RecordCompleted(ctx, in); err == nil {
		t.Fatal("RecordCompleted accepted status=pending, want a refusal")
	}
	in.Status = ""
	if _, err := led.RecordCompleted(ctx, in); err == nil {
		t.Fatal("RecordCompleted accepted an empty status, want a refusal")
	}
}

// ONE TRANSACTION, asserted the way the retention tests assert theirs: refuse
// the execution insert, and the entry must not be there either. A row saying a
// command was intended, with nothing about whether it ran, is the state this
// method exists to make unreachable.
func TestRecordCompleted_LeavesNoEntryWhenItsExecutionCannotBeWritten(t *testing.T) {
	ctx := context.Background()
	db, _, path := newLedgerAt(t)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := rawLedger(t, path, hex.EncodeToString(testKey()),
		`CREATE TRIGGER exec_boom BEFORE INSERT ON executions
		 BEGIN SELECT RAISE(ABORT, 'execution refused'); END`,
	); err != nil {
		t.Fatalf("install trigger: %v", err)
	}
	again, err := reopenStore(t, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = again.Close() }()
	led := again.Ledger()

	if _, recErr := led.RecordCompleted(ctx, aCompletedCommand("make ci")); recErr == nil {
		t.Fatal("RecordCompleted succeeded while the execution insert was refused")
	}
	page, pageErr := led.QueryEntries(ctx, content.LedgerQuery{Scope: content.ScopeEverywhere, Limit: 10})
	if pageErr != nil {
		t.Fatalf("QueryEntries: %v", pageErr)
	}
	if len(page.Entries) != 0 {
		t.Fatalf("%d entries after a rolled-back record, want none", len(page.Entries))
	}
	if page.HasRows {
		t.Fatal("the store reports rows after a rolled-back record")
	}
}
