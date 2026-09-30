package content

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/waittest"
)

// ONE FRAME, ONE TRANSACTION (ADR-0077). A lifecycle frame's writes — here
// the start fact's own: the entry, the environment it ran in, the
// observation it pins, its execution — and the session's cursor commit
// together or not at all. A fault anywhere inside the frame leaves the store
// exactly as it was, and the frame applied again afterwards lands once.

const frameSession = "0123456789abcdef0123456789abcdef"

func openFrameStore(t *testing.T) (*sqliteContent, *sql.DB) {
	t.Helper()
	db, err := openTestStore(t, filepath.Join(t.TempDir(), "content.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("Open returned %T, want the sqlite store", db)
	}
	ctx := context.Background()
	if _, err := s.Layout().CreateWorkspace(ctx,
		Workspace{ID: "ws-frame", Name: "frame"},
		Tab{ID: "tab-frame", WorkspaceID: "ws-frame", Layout: LayoutRow},
		Pane{ID: "pane-frame", TabID: "tab-frame", Cwd: "/", Kind: PaneLocal, SizeShare: 1},
	); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	zero := uint64(0)
	if err := s.Ledger().CreateSession(ctx, Session{ID: frameSession, WorkspaceID: "ws-frame", LifecycleApplied: &zero}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return s, s.db
}

// startFrame is the start fact's writes, as the transport makes them.
func startFrame(s *sqliteContent, entry string) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		led := s.Ledger()
		env := Environment{ID: "local", Kind: EnvLocal}
		if err := led.EnsureEnvironment(ctx, env); err != nil {
			return err
		}
		sessionID := frameSession
		if _, err := led.Submit(ctx, SubmitEntry{
			ID: entry, Client: "lifecycle-shell", EnvironmentID: env.ID, Cwd: "/", Intent: "make build",
			Kind: EntryShell, Source: SourceUser, SessionID: &sessionID,
		}); err != nil {
			return err
		}
		// Read-your-writes inside the frame: the entry just submitted is
		// what the execution below pins against.
		if row, err := led.Entry(ctx, entry); err != nil || row == nil {
			return errors.Join(errors.New("the frame cannot read its own entry"), err)
		}
		if _, err := led.RecordObservation(ctx, Observation{EnvironmentID: env.ID, Confidence: "{}", Criticality: CriticalityRoutine, Payload: "{}"}); err != nil {
			return err
		}
		_, err := led.StartExecution(ctx, StartExecution{EntryID: entry})
		return err
	}
}

// storedFrame is what a frame left behind: the entry's executions (-1 when
// there is no entry) and the session's cursor.
func storedFrame(t *testing.T, s *sqliteContent, entry string) (executions int, cursor uint64) {
	t.Helper()
	ctx := context.Background()
	row, err := s.Ledger().Entry(ctx, entry)
	if err != nil {
		t.Fatalf("Entry: %v", err)
	}
	executions = -1
	if row != nil {
		executions = len(row.Executions)
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT json_extract(payload, '$.lifecycleApplied') FROM sessions WHERE id = ?`, frameSession).Scan(&cursor); err != nil {
		t.Fatalf("reading the cursor: %v", err)
	}
	return executions, cursor
}

func TestALifecycleFrameCommitsItsRowsAndTheCursorTogether(t *testing.T) {
	s, _ := openFrameStore(t)
	if err := s.ApplyLifecycleFrame(context.Background(), frameSession, 120, startFrame(s, "s-dom-frame-0")); err != nil {
		t.Fatalf("ApplyLifecycleFrame: %v", err)
	}
	if executions, cursor := storedFrame(t, s, "s-dom-frame-0"); executions != 1 || cursor != 120 {
		t.Fatalf("after the frame: %d executions, cursor %d — want 1 and 120", executions, cursor)
	}
}

func TestAFaultInsideALifecycleFrameLeavesNeitherItsRowsNorTheCursor(t *testing.T) {
	for _, fault := range []struct {
		name, trigger string
	}{
		// Inside the frame's writes: the execution, its last row.
		{"inside the frame's writes", `CREATE TEMP TRIGGER fault BEFORE INSERT ON executions BEGIN SELECT RAISE(ABORT, 'injected'); END`},
		// After the frame's last row, at the cursor.
		{"between the last row and the cursor", `CREATE TEMP TRIGGER fault BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END`},
	} {
		t.Run(fault.name, func(t *testing.T) {
			s, raw := openFrameStore(t)
			ctx := context.Background()
			// TEMP triggers belong to the connection that made them, and
			// the store has exactly one.
			if _, err := raw.ExecContext(ctx, fault.trigger); err != nil {
				t.Fatalf("injecting the fault: %v", err)
			}
			err := s.ApplyLifecycleFrame(ctx, frameSession, 120, startFrame(s, "s-dom-frame-0"))
			if !errors.Is(err, ErrLifecycleFrameFailed) {
				t.Fatalf("ApplyLifecycleFrame = %v, want ErrLifecycleFrameFailed", err)
			}
			if executions, cursor := storedFrame(t, s, "s-dom-frame-0"); executions != -1 || cursor != 0 {
				t.Fatalf("after the failed frame: executions %d (entry present: %v), cursor %d — want no entry and the cursor where it was",
					executions, executions != -1, cursor)
			}

			// The next coordinator, resuming from the cursor, applies the
			// same frame again: once.
			if _, err := raw.ExecContext(ctx, `DROP TRIGGER fault`); err != nil {
				t.Fatalf("clearing the fault: %v", err)
			}
			if err := s.ApplyLifecycleFrame(ctx, frameSession, 120, startFrame(s, "s-dom-frame-0")); err != nil {
				t.Fatalf("the frame applied again: %v", err)
			}
			if executions, cursor := storedFrame(t, s, "s-dom-frame-0"); executions != 1 || cursor != 120 {
				t.Fatalf("after the frame applied again: %d executions, cursor %d — want 1 and 120", executions, cursor)
			}
		})
	}
}

// A write another goroutine makes while a frame holds the connection is not
// the frame's: it waits for the frame to end and is stored whether the frame
// commits or not.
func TestAWriteOutsideAFrameIsNotRolledBackWithIt(t *testing.T) {
	s, _ := openFrameStore(t)
	ctx := context.Background()
	outside := make(chan error, 1)
	err := s.ApplyLifecycleFrame(ctx, frameSession, 120, func(fctx context.Context) error {
		if err := startFrame(s, "s-dom-frame-0")(fctx); err != nil {
			return err
		}
		go func() {
			_, err := s.Ledger().RecordCompleted(ctx, aRecordedCommand("outside the frame"))
			outside <- err
		}()
		return errors.New("the frame fails after another writer queued")
	})
	if !errors.Is(err, ErrLifecycleFrameFailed) {
		t.Fatalf("ApplyLifecycleFrame = %v, want ErrLifecycleFrameFailed", err)
	}
	if werr := <-outside; werr != nil {
		t.Fatalf("the write outside the frame: %v", werr)
	}
	if executions, cursor := storedFrame(t, s, "s-dom-frame-0"); executions != -1 || cursor != 0 {
		t.Fatalf("the failed frame left %d executions and cursor %d", executions, cursor)
	}
	waittest.WaitFor(t, "the outside write to be stored", func() bool {
		page, err := s.Ledger().ListEntries(ctx, 10)
		return err == nil && len(page) == 1 && page[0].Intent == "outside the frame"
	})
}
