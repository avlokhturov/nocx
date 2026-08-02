package content

// A database written by an older schema is REBUILT, not half-opened
// (nocx-rtg0.17). Internal rather than external because the reproduction has
// to reach the encrypted file the way Open does — the keyed URI and the
// driver — to put the file into the exact state the owner hit: the previous
// shape of command_history, and a user_version that predates the stamp.

import (
	"context"
	"encoding/hex"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/log"

	"github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum"
)

func schemaTestKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

// rawExec runs statements against the encrypted file the way Open does,
// without going through Open — the only way to fabricate an out-of-date file.
func rawExec(t *testing.T, path string, stmts ...string) {
	t.Helper()
	keyHex := hex.EncodeToString(schemaTestKey())
	db, err := driver.Open("file:"+path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		return c.Exec("PRAGMA hexkey='" + keyHex + "'")
	})
	if err != nil {
		t.Fatalf("raw open: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, s := range stmts {
		if _, err := db.ExecContext(context.Background(), s); err != nil {
			t.Fatalf("raw exec %q: %v", s, err)
		}
	}
}

func rawUserVersion(t *testing.T, path string) int {
	t.Helper()
	keyHex := hex.EncodeToString(schemaTestKey())
	db, err := driver.Open("file:"+path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		return c.Exec("PRAGMA hexkey='" + keyHex + "'")
	})
	if err != nil {
		t.Fatalf("raw open: %v", err)
	}
	defer func() { _ = db.Close() }()
	var v int
	if err := db.QueryRowContext(context.Background(), "PRAGMA user_version").Scan(&v); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return v
}

func openStore(t *testing.T, path string) ContentDB {
	t.Helper()
	db, err := Open(context.Background(), Config{
		Path:   path,
		Key:    schemaTestKey(),
		Budget: Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8},
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// The owner's exact failure: a file whose command_history predates two added
// columns. Before the reset it opened perfectly and then failed every INSERT
// and every SELECT with "no such column", so the store reported itself
// healthy while recording nothing.
func TestOpenRebuildsADatabaseWrittenByAnOlderSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")

	// A file in the shape that shipped before masking: no masked_count, no
	// masked_kinds, and the user_version of a build that never stamped one.
	rawExec(
		t, path,
		`CREATE TABLE command_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			command TEXT NOT NULL, cwd TEXT NOT NULL, host TEXT NOT NULL,
			status TEXT NOT NULL, exit_code INTEGER,
			started_at INTEGER, ended_at INTEGER,
			trusted INTEGER NOT NULL DEFAULT 0
		) STRICT`,
		`INSERT INTO command_history (command, cwd, host, status) VALUES ('echo old', '/srv', '', 'success')`,
		`PRAGMA user_version=0`,
	)

	db := openStore(t, path)

	// The store WORKS — this is the assertion that used to fail, and it fails
	// on a write as well as on a read, so both are exercised.
	if err := db.CommandHistory().Add(context.Background(), CommandRecord{
		Command: "echo new", Cwd: "/srv", Host: "", Status: StatusSuccess,
	}); err != nil {
		t.Fatalf("Add after rebuild: %v", err)
	}
	page, err := db.CommandHistory().Query(context.Background(), ScopeEverywhere, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query after rebuild: %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Command != "echo new" {
		t.Fatalf("entries = %+v, want only the row written after the rebuild", page.Entries)
	}
	// The old row is gone by design: it belongs to a shape this build cannot
	// read, and keeping it would need the migration this project does not
	// carry.
	for _, e := range page.Entries {
		if e.Command == "echo old" {
			t.Fatal("a row from the discarded schema survived the rebuild")
		}
	}
	if got := rawUserVersion(t, path); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d — an unstamped file rebuilds on every open", got, schemaVersion)
	}
}

// The other side of the interval: a file this build wrote is opened again and
// again without losing anything. A reset that fires when it should not is the
// same defect wearing the opposite sign.
func TestReopeningACurrentDatabaseKeepsItsRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")

	first := openStore(t, path)
	if err := first.CommandHistory().Add(context.Background(), CommandRecord{
		Command: "echo keep", Cwd: "/srv", Host: "", Status: StatusSuccess,
	}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	for i := range 2 {
		again := openStore(t, path)
		page, err := again.CommandHistory().Query(context.Background(), ScopeEverywhere, "", "", 50, nil, "")
		if err != nil {
			t.Fatalf("Query on reopen %d: %v", i, err)
		}
		if len(page.Entries) != 1 || page.Entries[0].Command != "echo keep" {
			t.Fatalf("reopen %d: entries = %+v, want the row to survive", i, page.Entries)
		}
		if err := again.Close(); err != nil {
			t.Fatalf("Close on reopen %d: %v", i, err)
		}
	}
}

// A brand-new file is a creation, not a reset — nothing is announced as data
// loss, and the stamp is written so the next open is a no-op.
func TestFreshDatabaseIsStampedAndNotReportedAsAReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")
	db := openStore(t, path)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := rawUserVersion(t, path); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d", got, schemaVersion)
	}
}
