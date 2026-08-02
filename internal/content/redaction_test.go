package content

// The structured redaction segment (the round's store half): rows carry
// kind/span/prefix/suffix alongside the masked command, Add returns the
// stable id the save path rewrites by, and RewriteRedaction replaces one
// segment with a vault reference — idempotently, by stable id.

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/log"
)

func redactedRecord(marker string, redactions []Redaction) CommandRecord {
	r := CommandRecord{
		Command: marker, Cwd: "/srv", Host: "", Status: StatusSuccess,
		MaskedCount: len(redactions),
		MaskedKinds: []string{"openai", "jwt"},
		Redactions:  redactions,
	}
	return r
}

func TestRedactionsRoundTrip(t *testing.T) {
	db, path := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	segs := []Redaction{
		{Kind: "openai", Start: 10, End: 21, Prefix: "sk-p", Suffix: "7890"},
		{Kind: "jwt", Start: 30, End: 45, Prefix: "eyJh", Suffix: "sw5c"},
	}
	id, err := db.CommandHistory().Add(ctx, redactedRecord("curl masked", segs))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if id <= 0 {
		t.Fatalf("Add returned id %d, want > 0 (the stable identity)", id)
	}

	got, err := db.CommandHistory().GetByID(ctx, id)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got == nil {
		t.Fatal("GetByID returned nil for a row just added")
	}
	if len(got.Redactions) != 2 {
		t.Fatalf("redactions = %+v, want the two stored segments", got.Redactions)
	}
	for i, want := range segs {
		if got.Redactions[i] != want {
			t.Errorf("redaction %d = %+v, want %+v", i, got.Redactions[i], want)
		}
	}

	// A row with no secrets stores an empty list, never null.
	plainID, err := db.CommandHistory().Add(ctx, CommandRecord{Command: "plain", Cwd: "/srv", Host: "", Status: StatusSuccess})
	if err != nil {
		t.Fatalf("Add plain: %v", err)
	}
	plain, err := db.CommandHistory().GetByID(ctx, plainID)
	if err != nil {
		t.Fatalf("GetByID plain: %v", err)
	}
	if len(plain.Redactions) != 0 {
		t.Errorf("plain redactions = %+v, want empty", plain.Redactions)
	}

	// The bytes really crossed the disk: a fresh store over the same file
	// reads the same row back.
	if cerr := db.Close(); cerr != nil {
		t.Fatalf("Close: %v", cerr)
	}
	again, aerr := openTestStore(t, path)
	if aerr != nil {
		t.Fatalf("reopen: %v", aerr)
	}
	defer func() { _ = again.Close() }()
	reRead, err := again.CommandHistory().GetByID(ctx, id)
	if err != nil || reRead == nil {
		t.Fatalf("GetByID after reopen: %v (nil=%v)", err, reRead == nil)
	}
	if len(reRead.Redactions) != 2 {
		t.Errorf("redactions after reopen = %+v", reRead.Redactions)
	}
}

func TestAddReturnsStableIncrementingIDs(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	first, err := db.CommandHistory().Add(ctx, CommandRecord{Command: "id-1", Cwd: "/srv", Host: "", Status: StatusSuccess})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	second, err := db.CommandHistory().Add(ctx, CommandRecord{Command: "id-2", Cwd: "/srv", Host: "", Status: StatusSuccess})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if second <= first {
		t.Fatalf("ids not strictly increasing: %d then %d", first, second)
	}
}

func TestRewriteRedactionReplacesSpanAndDropsSegment(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	segs := []Redaction{
		{Kind: "openai", Start: 31, End: 42, Prefix: "sk-p", Suffix: "7890"},
		{Kind: "url-userinfo", Start: 56, End: 59, Prefix: "", Suffix: ""},
	}
	id, err := db.CommandHistory().Add(ctx, redactedRecord(
		`curl -H "Authorization: Bearer sk-p...7890" https://user:***@api.example.com`, segs,
	))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	ref := "{{secret:openrouter.ai}}"
	if err := db.CommandHistory().RewriteRedaction(ctx, id, segs[0], ref); err != nil {
		t.Fatalf("RewriteRedaction: %v", err)
	}
	row, gerr := db.CommandHistory().GetByID(ctx, id)
	if gerr != nil || row == nil {
		t.Fatalf("GetByID: %v (nil=%v)", gerr, row == nil)
	}
	want := `curl -H "Authorization: Bearer {{secret:openrouter.ai}}" https://user:***@api.example.com`
	if row.Command != want {
		t.Errorf("command = %q, want %q", row.Command, want)
	}
	if len(row.Redactions) != 1 || row.Redactions[0] != segs[1] {
		t.Errorf("redactions = %+v, want only the untouched segment %+v", row.Redactions, segs[1])
	}
}

func TestRewriteRedactionKeepsOtherSegments(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	segs := []Redaction{
		{Kind: "openai", Start: 6, End: 17, Prefix: "sk-p", Suffix: "7890"},
		{Kind: "jwt", Start: 22, End: 33, Prefix: "eyJh", Suffix: "sw5c"},
	}
	id, err := db.CommandHistory().Add(ctx, redactedRecord("TOKEN=sk-p...7890 jwt=eyJh...sw5c https://api", segs))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if rerr := db.CommandHistory().RewriteRedaction(ctx, id, segs[1], "{{secret:jwt-key}}"); rerr != nil {
		t.Fatalf("RewriteRedaction: %v", rerr)
	}
	row, err := db.CommandHistory().GetByID(ctx, id)
	if err != nil || row == nil {
		t.Fatalf("GetByID: %v", err)
	}
	if want := "TOKEN=sk-p...7890 jwt={{secret:jwt-key}} https://api"; row.Command != want {
		t.Errorf("command = %q, want %q", row.Command, want)
	}
	if len(row.Redactions) != 1 || row.Redactions[0] != segs[0] {
		t.Errorf("redactions = %+v, want only %+v", row.Redactions, segs[0])
	}
}

func TestRewriteRedactionIsIdempotent(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	segs := []Redaction{{Kind: "openai", Start: 0, End: 11, Prefix: "sk-p", Suffix: "7890"}}
	id, err := db.CommandHistory().Add(ctx, redactedRecord("sk-p...7890", segs))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	ref := "{{secret:openrouter.ai}}"
	if rerr := db.CommandHistory().RewriteRedaction(ctx, id, segs[0], ref); rerr != nil {
		t.Fatalf("first rewrite: %v", rerr)
	}
	after, err := db.CommandHistory().GetByID(ctx, id)
	if err != nil || after == nil {
		t.Fatalf("GetByID: %v", err)
	}
	// A retried save re-sends the span captured at record time. The first
	// attempt consumed it; the retry must no-op byte-for-byte, not replace
	// text at stale offsets.
	if rerr := db.CommandHistory().RewriteRedaction(ctx, id, segs[0], ref); rerr != nil {
		t.Fatalf("retried rewrite must be a no-op, got %v", rerr)
	}
	again, err := db.CommandHistory().GetByID(ctx, id)
	if err != nil || again == nil {
		t.Fatalf("GetByID after retry: %v", err)
	}
	if again.Command != after.Command {
		t.Errorf("command changed on retry: %q → %q", after.Command, again.Command)
	}
	if len(again.Redactions) != len(after.Redactions) {
		t.Errorf("redactions changed on retry: %+v → %+v", after.Redactions, again.Redactions)
	}
}

func TestRewriteRedactionUnknownRow(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()
	err := db.CommandHistory().RewriteRedaction(ctx, 9999, Redaction{Kind: "openai", Start: 0, End: 5}, "{{secret:x}}")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// A span that is not one of the row's current redactions (it was already
// consumed, or never was one) is a no-op even when the offsets still fit —
// the redactions list is the idempotency authority, not the text.
func TestRewriteRedactionStaleSpanNoOps(t *testing.T) {
	db, _ := newStoreAt(t, filepath.Join(t.TempDir(), "content.db"))
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	segs := []Redaction{{Kind: "openai", Start: 0, End: 11, Prefix: "sk-p", Suffix: "7890"}}
	id, err := db.CommandHistory().Add(ctx, redactedRecord("sk-p...7890", segs))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	// A DIFFERENT kind at the same offsets: not a current redaction.
	err = db.CommandHistory().RewriteRedaction(ctx, id, Redaction{Kind: "jwt", Start: 0, End: 11}, "{{secret:y}}")
	if err != nil {
		t.Fatalf("stale span must no-op, got %v", err)
	}
	row, err := db.CommandHistory().GetByID(ctx, id)
	if err != nil || row == nil {
		t.Fatalf("GetByID: %v", err)
	}
	if row.Command != "sk-p...7890" {
		t.Errorf("command = %q, want unchanged", row.Command)
	}
	if len(row.Redactions) != 1 {
		t.Errorf("redactions = %+v, want the original segment intact", row.Redactions)
	}
}

// The rebuild that the schema bump triggers must say how many rows it
// discarded — "your history was discarded" is a fact the user is entitled
// to, and the number is the only measure of it.
func TestSchemaRebuildLogsRowsDiscarded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")

	// Fabricate the PREVIOUS schema: the v1 table (no redactions column)
	// with two rows, stamped user_version=1 — the exact state a database
	// written before this round is in.
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
	// And the store works on the rebuilt shape.
	if _, err := db.CommandHistory().Add(context.Background(), CommandRecord{Command: "after-rebuild", Cwd: "/", Host: "", Status: StatusSuccess}); err != nil {
		t.Fatalf("Add after rebuild: %v", err)
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
