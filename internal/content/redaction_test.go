package content

// What survives of the interim table's own tests (nocx-rtg0.19).
//
// command_history is gone and with it every test that exercised its rows: the
// round-trip, the incrementing rowid, and the five rewrite cases are all
// answered for the ledger in ledger_redaction_test.go, which is the store
// that holds masked command text now. What could NOT move is below — the
// rebuild's own promise, which belongs to the schema mechanism rather than to
// either table.

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/log"
)

// The rebuild that the schema bump triggers must say how many rows it
// discarded — "your history was discarded" is a fact the user is entitled
// to, and the number is the only measure of it.
func TestSchemaRebuildLogsRowsDiscarded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")

	// Fabricate a PREVIOUS schema and stamp it. The table below no longer
	// exists in this build at all — nocx-rtg0.19 deleted it — which is
	// exactly why it is the right fixture: a file written by an older nocx
	// is a file holding tables this one does not know, and the rebuild must
	// count what it is about to discard before dropping it.
	rawExec(
		t, path,
		`CREATE TABLE command_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			command TEXT NOT NULL, cwd TEXT NOT NULL, host TEXT NOT NULL,
			status TEXT NOT NULL, exit_code INTEGER, started_at INTEGER,
			ended_at INTEGER, trusted INTEGER NOT NULL DEFAULT 0,
			masked_count INTEGER NOT NULL DEFAULT 0,
			masked_kinds TEXT NOT NULL DEFAULT '[]') STRICT`,
		`INSERT INTO command_history (command, cwd, host, status) VALUES ('echo old-1', '/', '', 'success')`,
		`INSERT INTO command_history (command, cwd, host, status) VALUES ('echo old-2', '/', '', 'success')`,
		`PRAGMA user_version=1`,
	)
	var discards []int
	recording := &captureLogger{warn: func(_ string, args ...any) {
		// slog-style key-value pairs: "was", 1, "now", 2, "rowsDiscarded", 2.
		for i := 0; i+1 < len(args); i += 2 {
			if args[i] == "rowsDiscarded" {
				if n, ok := args[i+1].(int); ok {
					discards = append(discards, n)
				}
			}
		}
	}}
	db, err := Open(context.Background(), Config{
		Path:   path,
		Key:    schemaTestKey(),
		Budget: testBudgetInternal(),
		Logger: recording,
	})
	if err != nil {
		t.Fatalf("Open over the v1 file: %v", err)
	}
	defer func() { _ = db.Close() }()

	if len(discards) != 1 || discards[0] != 2 {
		t.Errorf("rebuild reported rowsDiscarded = %v, want exactly [2]", discards)
	}
	// And the store works on the rebuilt shape: a command records, into the
	// ledger, which is the only place one lives now.
	if _, err := db.Ledger().RecordCompleted(context.Background(), CompletedCommand{
		Client: "rebuild-test",
		Env:    Environment{ID: "local", Kind: EnvLocal},
		Cwd:    "/", Intent: "after-rebuild", Status: EntrySuccess,
	}); err != nil {
		t.Fatalf("RecordCompleted after rebuild: %v", err)
	}
}

// newStoreAt opens a fresh store at path with the internal test key.
func newStoreAt(t *testing.T, path string) (ContentDB, string) {
	t.Helper()
	db, err := openTestStore(t, path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return db, path
}

type captureLogger struct {
	warn func(msg string, args ...any)
}

func (c *captureLogger) Debug(string, ...any)                   {}
func (c *captureLogger) Info(string, ...any)                    {}
func (c *captureLogger) Warn(msg string, args ...any)           { c.warn(msg, args...) }
func (c *captureLogger) Error(string, ...any)                   {}
func (c *captureLogger) With(...any) log.Logger                 { return c }
func (c *captureLogger) WithContext(context.Context) log.Logger { return c }
