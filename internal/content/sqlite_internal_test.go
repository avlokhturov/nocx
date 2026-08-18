package content

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"

	"github.com/shady2k/nocx/internal/log"
)

const (
	canaryMarker = "CANARY-7f3a9c21-command-text-must-never-appear-in-plaintext"
	testKeyHex   = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
)

func testBudgetInternal() Budget {
	return Budget{RetentionBytes: 1 << 30, DiskCeilingBytes: 2 << 30, CompactionFloor: 0.8}
}

func testKeyInternal() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

func openTestStore(t *testing.T, path string) (ContentDB, error) {
	t.Helper()
	return Open(context.Background(), Config{
		Path:   path,
		Key:    testKeyInternal(),
		Budget: testBudgetInternal(),
		Logger: log.NewSlogAdapter(nil),
	})
}

// openKeyedConn opens a raw keyed connection the way the store does. Test
// only: the store does not expose raw connections.
func openKeyedConn(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := driver.Open("file:"+path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		if err := c.Exec("PRAGMA hexkey='" + testKeyHex + "'"); err != nil {
			return err
		}
		if err := c.Exec("PRAGMA busy_timeout=5000"); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("open keyed conn: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// scanForMarker reports whether the file carries a plaintext SQLite header or
// the canary marker.
func scanForMarker(t *testing.T, path, label string) (header, plain bool) {
	t.Helper()
	data, err := os.ReadFile(path) //nolint:gosec // test helper scanning package-created files
	if err != nil {
		if os.IsNotExist(err) {
			return false, false
		}
		t.Fatalf("read %s: %v", label, err)
	}
	header = len(data) >= 15 && string(data[:15]) == "SQLite format 3"
	plain = strings.Contains(string(data), canaryMarker)
	return
}

// ── the plaintext canary (ADR-0018 amendment, correctness check 1) ───────

// Every file-creating path this package exposes must go through the keyed
// VFS. The canary writes a marker row, exercises each path, and greps every
// file the package created: confidentiality (no plaintext, no header) AND
// usability (the destination reopens with the key and reads its data — a
// random-keyed file would pass the plaintext grep and be useless, which is
// the subtler failure).
func TestPlaintextCanary(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	path := filepath.Join(dir, "content.db")

	db, openErr := openTestStore(t, path)
	if openErr != nil {
		t.Fatalf("Open: %v", openErr)
	}
	hist := db.CommandHistory()
	if _, addErr := hist.Add(ctx, CommandRecord{Command: canaryMarker, Cwd: "/srv", Host: "", Status: StatusSuccess}); addErr != nil {
		t.Fatalf("Add: %v", addErr)
	}

	// 1. The store's own files: db, -wal, -shm. No header, no plaintext.
	for _, name := range []string{"content.db", "content.db-wal", "content.db-shm"} {
		header, plain := scanForMarker(t, filepath.Join(dir, name), name)
		if header || plain {
			t.Errorf("%s leaked: header=%v plaintext=%v", name, header, plain)
		}
	}

	// 2. The backup destination (the store's supported copy path).
	snap := filepath.Join(dir, "snapshot.db")
	if backupErr := db.Backup(ctx, snap); backupErr != nil {
		t.Fatalf("Backup: %v", backupErr)
	}
	header, plain := scanForMarker(t, snap, "snapshot.db")
	if header || plain {
		t.Fatalf("backup leaked: header=%v plaintext=%v", header, plain)
	}
	assertReadsMarker(t, snap, "backup destination", "SELECT command FROM command_history WHERE command = '"+canaryMarker+"'")

	// 3. VACUUM INTO through the keyed URI — the documented form — must be
	// encrypted AND usable.
	vac := filepath.Join(dir, "vacuum.db")
	raw := openKeyedConn(t, path)
	if _, err := raw.Exec("VACUUM INTO '" + keyedURI(vac, testKeyHex) + "'"); err != nil { //nolint:gosec // keyedURI is package code under test
		t.Fatalf("keyed VACUUM INTO: %v", err)
	}
	header, plain = scanForMarker(t, vac, "vacuum.db")
	if header || plain {
		t.Fatalf("keyed VACUUM INTO leaked: header=%v plaintext=%v", header, plain)
	}
	assertReadsMarker(t, vac, "keyed VACUUM INTO destination", "SELECT command FROM command_history WHERE command = '"+canaryMarker+"'")

	// 4. ATTACH through the keyed URI, writing into the attached database.
	att := filepath.Join(dir, "attached.db")
	if _, err := raw.Exec("ATTACH DATABASE '" + keyedURI(att, testKeyHex) + "' AS a"); err != nil { //nolint:gosec // keyedURI is package code under test
		t.Fatalf("keyed ATTACH: %v", err)
	}
	if _, err := raw.Exec("CREATE TABLE a.t (a TEXT)"); err != nil {
		t.Fatalf("create in attached: %v", err)
	}
	if _, err := raw.Exec("INSERT INTO a.t VALUES ('" + canaryMarker + "')"); err != nil {
		t.Fatalf("insert into attached: %v", err)
	}
	header, plain = scanForMarker(t, att, "attached.db")
	if header || plain {
		t.Fatalf("keyed ATTACH leaked: header=%v plaintext=%v", header, plain)
	}
	assertReadsMarker(t, att, "keyed ATTACH destination", "SELECT a FROM t")

	// 5. The unkeyed forms MUST fail loudly, not write plaintext. Verified
	// empirically: on an adiantum connection, an unkeyed destination is
	// refused ("unable to open database file") and at worst leaves a
	// zero-byte file — never a plaintext database.
	badVac := filepath.Join(dir, "bad-vacuum.db")
	if _, err := raw.Exec("VACUUM INTO '" + badVac + "'"); err == nil { //nolint:gosec // deliberately unkeyed destination
		t.Fatal("unkeyed VACUUM INTO succeeded, want a loud failure")
	}
	if header, plain := scanForMarker(t, badVac, "bad-vacuum.db"); header || plain {
		t.Fatalf("unkeyed VACUUM INTO leaked: header=%v plaintext=%v", header, plain)
	}
	badAtt := filepath.Join(dir, "bad-attach.db")
	if _, err := raw.Exec("ATTACH DATABASE '" + badAtt + "' AS b"); err != nil { //nolint:gosec // deliberately unkeyed destination
		// ATTACH itself may succeed; the first write must not.
		if _, err2 := raw.Exec("CREATE TABLE b.t (a TEXT)"); err2 == nil {
			t.Fatal("unkeyed ATTACH wrote a table, want a loud failure")
		}
	}
	if header, plain := scanForMarker(t, badAtt, "bad-attach.db"); header || plain {
		t.Fatalf("unkeyed ATTACH leaked: header=%v plaintext=%v", header, plain)
	}

	// 6. The whole directory, final sweep: no file carries the marker.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		header, plain := scanForMarker(t, filepath.Join(dir, e.Name()), e.Name())
		if plain {
			t.Errorf("final sweep: %s contains the canary marker in plaintext", e.Name())
		}
		if header && e.Name() != "content.db" && e.Name() != "snapshot.db" {
			// content.db/snapshot.db have no header either; this branch is
			// defensive and would fire on any unencrypted SQLite file.
			t.Errorf("final sweep: %s has a plaintext SQLite header", e.Name())
		}
	}
}

// assertReadsMarker reopens an encrypted destination with the key and checks
// the canary row is there — usability, not only confidentiality. The query is
// the caller's: the backup and VACUUM destinations carry the store schema
// (command_history), the ATTACH destination carries the test's own table.
func assertReadsMarker(t *testing.T, path, label, query string) {
	t.Helper()
	conn := openKeyedConn(t, path)
	var v string
	if err := conn.QueryRow(query).Scan(&v); err != nil { //nolint:gosec // query is the caller's fixed literal
		t.Fatalf("%s does not reopen with the key: %v (random-keyed or plaintext?)", label, err)
	}
	if v != canaryMarker {
		t.Fatalf("%s reopened but read %q, want the canary marker", label, v)
	}
}

// ── backup consistency (correctness check 2) ─────────────────────────────

// The snapshot must contain rows that are still only in the WAL at backup
// time (never checkpointed), and the destination must be a complete,
// standalone, encrypted database.
func TestBackupProducesConsistentEncryptedSnapshot(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	path := filepath.Join(dir, "content.db")

	db, openErr := openTestStore(t, path)
	if openErr != nil {
		t.Fatalf("Open: %v", openErr)
	}
	hist := db.CommandHistory()
	const rows = 50
	for i := range rows {
		if _, err := hist.Add(ctx, CommandRecord{
			Command: fmt.Sprintf("cmd-%d", i), Cwd: "/repo", Host: "", Status: StatusSuccess,
		}); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	// Deliberately do NOT checkpoint: the newest rows are WAL-only.
	walData, err := os.ReadFile(path + "-wal") //nolint:gosec // test asserting a live WAL exists
	if err != nil || len(walData) == 0 {
		t.Fatalf("expected a live WAL before backup, err=%v", err)
	}

	snap := filepath.Join(dir, "snapshot.db")
	if backupErr := db.Backup(ctx, snap); backupErr != nil {
		t.Fatalf("Backup: %v", backupErr)
	}

	header, plain := scanForMarker(t, snap, "snapshot.db")
	if header || plain {
		t.Fatalf("snapshot leaked: header=%v plaintext=%v", header, plain)
	}

	// The snapshot is a complete standalone database: reopen it directly.
	conn := openKeyedConn(t, snap)
	var n int
	if err := conn.QueryRow("SELECT count(*) FROM command_history").Scan(&n); err != nil {
		t.Fatalf("snapshot has no command_history: %v", err)
	}
	if n != rows {
		t.Fatalf("snapshot holds %d rows, want %d (WAL-only rows lost)", n, rows)
	}
	var newest string
	if err := conn.QueryRow("SELECT command FROM command_history ORDER BY id DESC LIMIT 1").Scan(&newest); err != nil {
		t.Fatalf("read newest: %v", err)
	}
	if newest != fmt.Sprintf("cmd-%d", rows-1) {
		t.Fatalf("newest in snapshot = %q, want the last written row", newest)
	}
}

// ── multi-process locking (correctness check 3) ──────────────────────────

// The children run inside the test binary: the writer inserts rows through
// the public store API until killed; the checkpointer loops the WAL
// checkpoint on a raw keyed connection until killed.
func TestContentDBChild(t *testing.T) {
	switch os.Getenv("NOCX_CONTENT_CHILD") {
	case "writer":
		childWriter(t)
	case "checkpointer":
		childCheckpointer(t)
	case "evictor":
		childEvictor(t)
	default:
		t.Skip("not a child invocation")
	}
}

// newChild re-execs this test binary in the given role against the given
// database. Shared by every cross-process test here so the re-exec pattern
// has one implementation: the role and the path are the whole interface.
func newChild(t *testing.T, role, path string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestContentDBChild") //nolint:gosec // standard Go test re-exec pattern
	cmd.Env = append(
		os.Environ(),
		"NOCX_CONTENT_CHILD="+role,
		"NOCX_CONTENT_PATH="+path,
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s child: %v", role, err)
	}
	return cmd
}

func childWriter(t *testing.T) {
	db, err := openTestStore(t, os.Getenv("NOCX_CONTENT_PATH"))
	if err != nil {
		os.Exit(3)
	}
	defer func() { _ = db.Close() }()
	ctx := context.Background()
	hist := db.CommandHistory()
	for i := 0; ; i++ {
		if _, err := hist.Add(ctx, CommandRecord{
			Command: fmt.Sprintf("child-row-%d", i), Cwd: "/proc", Host: "", Status: StatusSuccess,
		}); err != nil {
			os.Exit(4)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func childCheckpointer(t *testing.T) {
	conn := openKeyedConn(t, os.Getenv("NOCX_CONTENT_PATH"))
	defer func() { _ = conn.Close() }()
	for {
		if _, err := conn.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
			os.Exit(5)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// Two processes on one database, including a kill during a checkpoint and a
// kill mid-write: the database must reopen readable with integrity intact.
func TestTwoProcessesShareDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "content.db")

	writer := newChild(t, "writer", path)
	checkpointer := newChild(t, "checkpointer", path)

	// Let both processes work on the shared database, then kill the
	// checkpointer mid-checkpoint and the writer mid-write.
	time.Sleep(800 * time.Millisecond)
	if err := checkpointer.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("kill checkpointer: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := writer.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("kill writer: %v", err)
	}
	_, _ = checkpointer.Process.Wait()
	_, _ = writer.Process.Wait()

	// Reopen: readable, integrity intact, and the committed prefix survived.
	ctx := context.Background()
	db, err := openTestStore(t, path)
	if err != nil {
		t.Fatalf("reopen after cross-process kills: %v", err)
	}
	defer func() { _ = db.Close() }()

	conn := openKeyedConn(t, path)
	var integrity string
	if err := conn.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want ok", integrity)
	}

	var n int
	if err := conn.QueryRow("SELECT count(*) FROM command_history").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n == 0 {
		t.Fatal("no rows survived two processes writing to one database")
	}
	if _, err := db.CommandHistory().Query(ctx, ScopeEverywhere, "", "", 10, nil, ""); err != nil {
		t.Fatalf("query after kills: %v", err)
	}

	// The same database keeps working across processes: a fresh store writes.
	if _, err := db.CommandHistory().Add(ctx, CommandRecord{Command: "after-kills", Cwd: "/", Host: "", Status: StatusSuccess}); err != nil {
		t.Fatalf("Add after kills: %v", err)
	}
}

// The retention sweep is best-effort by design: the INSERT is already
// durable when the sweep runs, so a sweep failure must log and leave Add
// successful — otherwise a caller retrying Add would duplicate the command.
func TestRetentionSweepFailureIsBestEffort(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "content.db")
	db, err := openTestStore(t, path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	sc, ok := db.(*sqliteContent)
	if !ok {
		t.Fatalf("store is %T, want *sqliteContent", db)
	}
	sc.policy.SetRetentionDays(1)
	sc.sweep = func(context.Context, int64) error { return errors.New("sweep failed") }

	now := time.Now().UnixMilli()
	if _, addErr := db.CommandHistory().Add(context.Background(), CommandRecord{
		Command: "sweep-failure-row", Cwd: "/", Host: "", Status: StatusSuccess, EndedAt: &now,
	}); addErr != nil {
		t.Fatalf("Add with a failing sweep returned an error: %v", addErr)
	}
	recs, err := db.CommandHistory().List(context.Background(), 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 {
		t.Fatalf("rows = %d, want the inserted row to survive a failed sweep", len(recs))
	}
}
