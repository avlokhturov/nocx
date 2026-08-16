package content_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/log"
)

// testBudget is a valid two-number budget for tests: retention below the
// physical ceiling, hysteresis inside (0,1).
var testBudget = content.Budget{
	RetentionBytes:   1 << 30,
	DiskCeilingBytes: 2 << 30,
	CompactionFloor:  0.8,
}

func testKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

func newTestStore(t *testing.T) (content.ContentDB, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	}
	ctx := context.Background()
	db, err := content.Open(ctx, cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, dir
}

func markerRecord(marker string) content.CommandRecord {
	return content.CommandRecord{
		Command: marker,
		Cwd:     "/srv/api",
		Host:    "",
		Status:  content.StatusSuccess,
	}
}

// The file, its WAL and its SHM are 0600 inside a 0700 directory, carry no
// SQLite header and no plaintext of a row we wrote, and reopen with the key.
func TestOpenCreatesEncryptedStoreWithAtRestPosture(t *testing.T) {
	db, dir := newTestStore(t)
	ctx := context.Background()
	if _, addErr := db.CommandHistory().Add(ctx, markerRecord("canary-51e21c88-command")); addErr != nil {
		t.Fatalf("Add: %v", addErr)
	}

	fi, statDirErr := os.Stat(dir)
	if statDirErr != nil {
		t.Fatalf("stat dir: %v", statDirErr)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %o, want 700", fi.Mode().Perm())
	}

	// The WAL and SHM exist only while the store is live — a clean close
	// checkpoints and removes them — so check all three mid-session.
	for _, name := range []string{"content.db", "content.db-wal", "content.db-shm"} {
		path := filepath.Join(dir, name)
		data, readErr := os.ReadFile(path) //nolint:gosec // test reading files the store created
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		fi, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatalf("stat %s: %v", name, statErr)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", name, fi.Mode().Perm())
		}
		if len(data) >= 15 && string(data[:15]) == "SQLite format 3" {
			t.Errorf("%s has a plaintext SQLite header", name)
		}
		if strings.Contains(string(data), "canary-51e21c88-command") {
			t.Errorf("%s contains plaintext of a written row", name)
		}
	}

	// After a clean close, the surviving file is only content.db, still
	// 0600 and still encrypted.
	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
	mainData, readErr := os.ReadFile(filepath.Join(dir, "content.db")) //nolint:gosec // test reading a store-created file
	if readErr != nil {
		t.Fatalf("read content.db after close: %v", readErr)
	}
	if strings.Contains(string(mainData), "canary-51e21c88-command") {
		t.Error("content.db contains plaintext after close")
	}
	for _, name := range []string{"content.db-wal", "content.db-shm"} {
		if _, statErr := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(statErr) {
			t.Errorf("%s still exists after a clean close (want checkpointed away)", name)
		}
	}

	// Reopen with the key: the record is there.
	db2, reopenErr := content.Open(ctx, content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	})
	if reopenErr != nil {
		t.Fatalf("reopen: %v", reopenErr)
	}
	defer func() { _ = db2.Close() }()
	recs, listErr := db2.CommandHistory().List(ctx, 10)
	if listErr != nil {
		t.Fatalf("List: %v", listErr)
	}
	if len(recs) != 1 || recs[0].Command != "canary-51e21c88-command" {
		t.Fatalf("reopened store read %+v, want the marker record", recs)
	}
}

func TestHistoryRecordAuthorSurvivesRestartInLedger(t *testing.T) {
	db, dir := newTestStore(t)
	ctx := context.Background()

	records := []content.CommandRecord{
		{
			Author:  string(content.EntryAgent),
			Command: "agent-cmd",
			Cwd:     "/srv/api",
			Host:    "",
			Status:  content.StatusSuccess,
		},
		{
			Author:  string(content.EntryShell),
			Command: "shell-cmd",
			Cwd:     "/srv/api",
			Host:    "",
			Status:  content.StatusSuccess,
		},
	}
	for _, rec := range records {
		if _, err := db.CommandHistory().Add(ctx, rec); err != nil {
			t.Fatalf("Add %q: %v", rec.Command, err)
		}
	}

	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
	db2, err := content.Open(ctx, content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = db2.Close() }()

	entries, err := db2.Ledger().ListEntries(ctx, 10)
	if err != nil {
		t.Fatalf("ListEntries after reopen: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries after reopen = %+v, want 2 durable rows", entries)
	}
	if entries[0].Kind != content.EntryShell || entries[0].Intent != "shell-cmd" {
		t.Fatalf("newest ledger entry = %+v, want shell-cmd", entries[0])
	}
	if entries[1].Kind != content.EntryAgent || entries[1].Intent != "agent-cmd" {
		t.Fatalf("older ledger entry = %+v, want agent-cmd", entries[1])
	}

	history, err := db2.CommandHistory().List(ctx, 10)
	if err != nil {
		t.Fatalf("List after reopen: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history after reopen = %+v, want 2 rows", history)
	}
	if history[0].Author != string(content.EntryShell) || history[0].Command != "shell-cmd" {
		t.Fatalf("newest history row = %+v, want shell author", history[0])
	}
	if history[1].Author != string(content.EntryAgent) || history[1].Command != "agent-cmd" {
		t.Fatalf("older history row = %+v, want agent author", history[1])
	}
}

// A wrong key fails at Open, leaves the file byte-identical, and creates no
// second, unencrypted file.
func TestWrongKeyFailsCleanly(t *testing.T) {
	db, dir := newTestStore(t)
	ctx := context.Background()
	if _, err := db.CommandHistory().Add(ctx, markerRecord("wrongkey-marker")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}

	path := filepath.Join(dir, "content.db")
	before, err := os.ReadFile(path) //nolint:gosec // test comparing bytes before/after a wrong-key open
	if err != nil {
		t.Fatalf("read before: %v", err)
	}
	entriesBefore := dirEntries(t, dir)

	wrong := make([]byte, 32)
	for i := range wrong {
		wrong[i] = 0xff
	}
	_, err = content.Open(ctx, content.Config{
		Path:   path,
		Key:    wrong,
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	})
	if err == nil {
		t.Fatal("Open with the wrong key succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "not a database") {
		t.Errorf("wrong-key error = %q, want a 'not a database' class error", err)
	}

	after, err := os.ReadFile(path) //nolint:gosec // test comparing bytes before/after a wrong-key open
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Error("wrong-key open modified the database file")
	}
	if strings.Contains(string(after), "wrongkey-marker") {
		t.Error("database file contains plaintext after a wrong-key open")
	}
	// No new files (no second, unencrypted database, no stray journal).
	entriesAfter := dirEntries(t, dir)
	if len(entriesAfter) != len(entriesBefore) {
		t.Errorf("wrong-key open created new files: before %v, after %v", entriesBefore, entriesAfter)
	}

	// The right key still works.
	db2, err := content.Open(ctx, content.Config{
		Path:   path,
		Key:    testKey(),
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("reopen with right key after wrong-key attempt: %v", err)
	}
	defer func() { _ = db2.Close() }()
	recs, err := db2.CommandHistory().List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1", len(recs))
	}
}

func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestAddListGetByIDFindByPrefix(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	recs := []content.CommandRecord{
		{Command: "kubectl get pods", Cwd: "/repo", Host: "", Status: content.StatusSuccess},
		{Command: "kubectl get svc", Cwd: "/repo", Host: "", Status: content.StatusRunning},
		{Command: "ssh prod deploy", Cwd: "/srv/api", Host: "prod.example.com", Status: content.StatusFailure},
	}
	for _, r := range recs {
		if _, err := hist.Add(ctx, r); err != nil {
			t.Fatalf("Add %q: %v", r.Command, err)
		}
	}

	got, err := hist.List(ctx, 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 || got[0].Command != "ssh prod deploy" || got[1].Command != "kubectl get svc" {
		t.Fatalf("List(2) = %+v, want the two newest, newest first", got)
	}

	one, err := hist.GetByID(ctx, got[0].ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if one == nil || one.Command != "ssh prod deploy" || one.Host != "prod.example.com" {
		t.Fatalf("GetByID = %+v", one)
	}
	missing, err := hist.GetByID(ctx, 99999)
	if err != nil || missing != nil {
		t.Fatalf("GetByID(missing) = %v, %v; want nil, nil", missing, err)
	}

	prefixed, err := hist.FindByPrefix(ctx, "kubectl", 10)
	if err != nil {
		t.Fatalf("FindByPrefix: %v", err)
	}
	if len(prefixed) != 2 || prefixed[0].Command != "kubectl get svc" {
		t.Fatalf("FindByPrefix(kubectl) = %+v", prefixed)
	}
	// A literal % in the prefix must not act as a wildcard.
	lit, err := hist.FindByPrefix(ctx, "ssh %", 10)
	if err != nil {
		t.Fatalf("FindByPrefix literal: %v", err)
	}
	if len(lit) != 0 {
		t.Fatalf("FindByPrefix(ssh %%) matched %d rows, want 0 (wildcards escaped)", len(lit))
	}
}

// The rungs: directory is the exact (cwd, host) pair (the overlay's own
// semantics), host is the exact host, everywhere is unfiltered. The store
// answers from the asked rung and never widens it.
func TestQueryScopesPagingAndHasRows(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	// A fresh store: HasRows=false — the transport answers source=session.
	page, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query on fresh store: %v", err)
	}
	if page.HasRows || page.Exhausted != true || len(page.Entries) != 0 {
		t.Fatalf("fresh store page = %+v, want no rows, exhausted, empty", page)
	}

	add := func(cmd, cwd, host string) {
		t.Helper()
		if _, addErr := hist.Add(ctx, content.CommandRecord{Command: cmd, Cwd: cwd, Host: host, Status: content.StatusSuccess}); addErr != nil {
			t.Fatalf("Add %q: %v", cmd, addErr)
		}
	}
	add("cd /srv/api", "/srv/api", "")
	add("ls -la", "/srv/api", "")
	add("kubectl get pods", "/srv/api", "prod.example.com")
	add("ssh deploy", "/srv/api", "prod.example.com")
	add("make test", "/repo", "")

	// directory = (cwd, host). Remote rows are not in the local directory
	// rung even though the cwd matches; local rows in other dirs are not.
	page, err = hist.Query(ctx, content.ScopeDirectory, "/srv/api", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query directory: %v", err)
	}
	if len(page.Entries) != 2 || !page.Exhausted || !page.HasRows {
		t.Fatalf("directory(local /srv/api) = %+v", page)
	}
	for _, e := range page.Entries {
		if e.Host != "" {
			t.Fatalf("directory rung leaked a remote row: %+v", e)
		}
	}

	page, err = hist.Query(ctx, content.ScopeDirectory, "/srv/api", "prod.example.com", 50, nil, "")
	if err != nil {
		t.Fatalf("Query directory remote: %v", err)
	}
	if len(page.Entries) != 2 {
		t.Fatalf("directory(prod /srv/api) = %d rows, want 2", len(page.Entries))
	}

	// host rung: "" is the local machine.
	page, err = hist.Query(ctx, content.ScopeHost, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query host local: %v", err)
	}
	if len(page.Entries) != 3 || page.Entries[0].Command != "make test" {
		t.Fatalf("host(local) = %+v, want 3 rows newest first", page.Entries)
	}

	// everywhere, newest first.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 2, nil, "")
	if err != nil {
		t.Fatalf("Query everywhere: %v", err)
	}
	if len(page.Entries) != 2 || page.Exhausted {
		t.Fatalf("everywhere page(2) = %+v, want 2 rows, not exhausted", page)
	}
	if page.Entries[0].Command != "make test" || page.Entries[1].Command != "ssh deploy" {
		t.Fatalf("everywhere order = %q, %q", page.Entries[0].Command, page.Entries[1].Command)
	}

	// paging: before = last id of the previous page; only strictly older rows.
	// Five rows, page size 2: page 1 is rows 5,4; page 2 is rows 3,2 and is
	// NOT exhausted (row 1 remains); page 3 is row 1 and is exhausted.
	before := page.Entries[1].ID
	page2, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 2, &before, "")
	if err != nil {
		t.Fatalf("Query page 2: %v", err)
	}
	if len(page2.Entries) != 2 || page2.Exhausted {
		t.Fatalf("page 2 = %+v, want 2 rows, not exhausted (one row remains)", page2)
	}
	if page2.Entries[0].ID >= before || page2.Entries[1].ID >= before {
		t.Fatalf("page 2 contains rows not strictly older than the cursor")
	}
	before = page2.Entries[1].ID
	page3, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 2, &before, "")
	if err != nil {
		t.Fatalf("Query page 3: %v", err)
	}
	if len(page3.Entries) != 1 || !page3.Exhausted {
		t.Fatalf("page 3 = %+v, want the last row, exhausted", page3)
	}
}

// ── text filter (nocx-ms7v) and coverage ────────────────────────────────

// The filter is a case-insensitive substring over command, applied WITHIN the
// rung the caller asked for — the server never silently widens. instr() has
// no wildcard grammar, so "%" and "_" in the search text match literally.
func TestQueryTextFilterWithinRung(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	add := func(cmd, cwd, host string) {
		t.Helper()
		if _, addErr := hist.Add(ctx, content.CommandRecord{Command: cmd, Cwd: cwd, Host: host, Status: content.StatusSuccess}); addErr != nil {
			t.Fatalf("Add %q: %v", cmd, addErr)
		}
	}
	add("make deploy", "/srv/api", "")
	add("Make Deploy PROD", "/srv/api", "")
	add("rm -rf build", "/srv/api", "")
	add("make deploy", "/srv/api", "prod.example.com") // same cwd, remote host
	add("make test", "/repo", "")
	add("grep '100%_done'", "/repo", "") // the % and _ are literal

	// Within the directory rung: the remote row and the other cwd are out,
	// even though their commands match the filter.
	page, err := hist.Query(ctx, content.ScopeDirectory, "/srv/api", "", 50, nil, "deploy")
	if err != nil {
		t.Fatalf("Query directory+deploy: %v", err)
	}
	got := make([]string, 0, len(page.Entries))
	for _, e := range page.Entries {
		got = append(got, e.Command)
	}
	if len(got) != 2 || got[0] != "Make Deploy PROD" || got[1] != "make deploy" {
		t.Fatalf("directory+deploy = %q, want the two local /srv/api matches newest first", got)
	}

	// Case-insensitive: an upper-case needle finds the lower-case command.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "DEPLOY")
	if err != nil {
		t.Fatalf("Query everywhere+DEPLOY: %v", err)
	}
	if len(page.Entries) != 3 {
		t.Fatalf("everywhere+DEPLOY = %d rows, want 3 (both /srv/api dirs + remote)", len(page.Entries))
	}

	// The empty filter is no filter: the whole rung, same as omitting text.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query everywhere+empty: %v", err)
	}
	if len(page.Entries) != 6 {
		t.Fatalf("everywhere+empty = %d rows, want 6 (no filter)", len(page.Entries))
	}

	// % and _ are literals, not LIKE wildcards: the needle matches the
	// command that contains it and nothing else.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "100%_done")
	if err != nil {
		t.Fatalf("Query everywhere+literal: %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Command != "grep '100%_done'" {
		t.Fatalf("everywhere+literal = %+v, want only the literal row", page.Entries)
	}

	// A needle with no matches is an empty page from a store that has rows:
	// HasRows stays true, so the transport still answers source=store — the
	// empty answer and the unanswerable question must not look alike.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "zzz-no-such-command")
	if err != nil {
		t.Fatalf("Query everywhere+miss: %v", err)
	}
	if len(page.Entries) != 0 || !page.HasRows || !page.Exhausted {
		t.Fatalf("everywhere+miss = %+v, want empty page, HasRows, exhausted", page)
	}
}

// Coverage is the store-wide horizon — the oldest retained entry's ended_at —
// independent of the rung and the filter: retention is store-wide, so the
// answer's horizon is too. A fresh store reports no horizon.
func TestQueryCoverageIsStoreWideHorizon(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	// A fresh store holds nothing: no horizon to state.
	page, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query on fresh store: %v", err)
	}
	if page.Coverage != nil {
		t.Fatalf("fresh store coverage = %v, want nil", *page.Coverage)
	}

	old := int64(1_000)
	mid := int64(2_000)
	newest := int64(3_000)
	add := func(cmd, cwd, host string, endedAt int64) {
		t.Helper()
		if _, addErr := hist.Add(ctx, content.CommandRecord{Command: cmd, Cwd: cwd, Host: host, Status: content.StatusSuccess, EndedAt: &endedAt}); addErr != nil {
			t.Fatalf("Add %q: %v", cmd, addErr)
		}
	}
	add("oldest", "/old", "", old)
	// A running entry (ended_at NULL) must not corrupt the MIN — NULLs are
	// ignored, so the horizon stays the oldest completed row.
	if _, addErr := hist.Add(ctx, content.CommandRecord{Command: "running", Cwd: "/old", Host: "", Status: content.StatusRunning}); addErr != nil {
		t.Fatalf("Add running: %v", addErr)
	}
	add("newest", "/new", "", newest)
	add("middle", "/old", "", mid)

	// Store-wide: the oldest row lives in /old; a query on the /new rung —
	// whose own rows are all recent — still reports the store's horizon.
	page, err = hist.Query(ctx, content.ScopeDirectory, "/new", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query /new: %v", err)
	}
	if page.Coverage == nil || *page.Coverage != old {
		t.Fatalf("/new rung coverage = %v, want store-wide %d", page.Coverage, old)
	}

	// The filter does not narrow the horizon either: a needle matching only
	// the newest row still reports the oldest retained entry.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "newest")
	if err != nil {
		t.Fatalf("Query filter=newest: %v", err)
	}
	if page.Coverage == nil || *page.Coverage != old {
		t.Fatalf("filtered coverage = %v, want store-wide %d", page.Coverage, old)
	}
	if len(page.Entries) != 1 || page.Entries[0].Command != "newest" {
		t.Fatalf("filter=newest entries = %+v, want only the newest row", page.Entries)
	}

	// And the unfiltered everywhere page reports the same horizon.
	page, err = hist.Query(ctx, content.ScopeEverywhere, "", "", 50, nil, "")
	if err != nil {
		t.Fatalf("Query everywhere: %v", err)
	}
	if page.Coverage == nil || *page.Coverage != old {
		t.Fatalf("everywhere coverage = %v, want %d", page.Coverage, old)
	}
}

// ── concurrency: one writer, many readers, no lost rows ──────────────────

func TestConcurrentReadersWithOneWriter(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	const total = 1000
	var wg sync.WaitGroup
	errCh := make(chan error, 16)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := range total {
			if _, err := hist.Add(ctx, content.CommandRecord{
				Command: fmt.Sprintf("cmd-%d", i), Cwd: "/repo", Host: "", Status: content.StatusSuccess,
			}); err != nil {
				errCh <- fmt.Errorf("writer: %w", err)
				return
			}
		}
	}()

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				page, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 10, nil, "")
				if err != nil {
					errCh <- fmt.Errorf("reader: %w", err)
					return
				}
				_, _ = page, page.Exhausted
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}

	recs, err := hist.List(ctx, total+1)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != total {
		t.Fatalf("got %d rows, want %d (no rows lost)", len(recs), total)
	}
}

// ── error paths the caller must be able to act on ────────────────────────

// Disk full: a per-process file-size cap makes the next write fail with an
// actionable error instead of a panic, and the store stays usable after the
// condition clears.
func TestDiskFullProducesActionableError(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	hist := db.CommandHistory()

	var lim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &lim); err != nil {
		t.Fatalf("getrlimit: %v", err)
	}
	original := lim
	// Without this, the first oversized write delivers SIGXFSZ, whose default
	// action terminates the process — the very panic we are proving absent.
	signal.Ignore(syscall.SIGXFSZ)
	lim.Cur = 64 * 1024
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &lim); err != nil {
		t.Fatalf("setrlimit: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &original) })

	big := strings.Repeat("x", 2<<20) // 2 MiB row, far over the cap
	if _, err := hist.Add(ctx, content.CommandRecord{Command: big, Cwd: "/", Host: "", Status: content.StatusSuccess}); err == nil {
		t.Fatal("oversized write succeeded, want a disk-full-class error")
	}

	// The store is intact: after the limit is lifted, small writes work and
	// the failed write left nothing behind.
	_ = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &original)
	if _, err := hist.Add(ctx, markerRecord("after-full")); err != nil {
		t.Fatalf("Add after the condition cleared: %v", err)
	}
	recs, err := hist.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 || recs[0].Command != "after-full" {
		t.Fatalf("records after disk-full = %+v, want exactly the one clean row", recs)
	}
}

// A directory that is not writable yields an error, not a panic. The store
// enforces its own 0700 posture on the directory at Open and keeps its WAL
// file descriptors open mid-session, so the observable boundary is Open:
// a path whose parent cannot be a directory must fail cleanly.
func TestUnwritableDirectoryProducesError(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}

	_, err := content.Open(context.Background(), content.Config{
		Path:   filepath.Join(blocker, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Logger: log.NewSlogAdapter(nil),
	})
	if err == nil {
		t.Fatal("Open under a regular file succeeded, want an error")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Open returned a timeout, want the filesystem error: %v", err)
	}

	// A genuinely read-only location (the store re-asserts 0700 on
	// directories it owns, so an own-parent chmod cannot produce a
	// permission error; an unwritable filesystem can).
	t.Run("read-only filesystem", func(t *testing.T) {
		if _, err := os.Stat("/proc"); err != nil {
			t.Skip("/proc not available")
		}
		_, err := content.Open(context.Background(), content.Config{
			Path:   "/proc/nocx-contentdb-test/content.db",
			Key:    testKey(),
			Budget: testBudget,
			Logger: log.NewSlogAdapter(nil),
		})
		if err == nil {
			t.Fatal("Open on a read-only filesystem succeeded, want an error")
		}
		if errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Open returned a timeout, want the filesystem error: %v", err)
		}
	})
}

// ── lifecycle ────────────────────────────────────────────────────────────

func TestAddAfterCloseReturnsErrClosed(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
	_, err := db.CommandHistory().Add(ctx, markerRecord("late"))
	if !errors.Is(err, content.ErrClosed) {
		t.Fatalf("Add after Close = %v, want ErrClosed", err)
	}
	if secondCloseErr := db.Close(); secondCloseErr != nil {
		t.Fatalf("second Close = %v, want nil (idempotent)", secondCloseErr)
	}
}

// auto_vacuum is decided at creation (nocx-rtg0.11): INCREMENTAL at open and
// still INCREMENTAL after a reopen.
func TestAutoVacuumDecidedAtCreation(t *testing.T) {
	db, dir := newTestStore(t)
	ctx := context.Background()
	if _, err := db.CommandHistory().Add(ctx, markerRecord("av")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}

	// The test opens its own keyed connection to read the pragma the way a
	// raw caller would (the store does not expose PRAGMA access).
	av := readAutoVacuum(t, filepath.Join(dir, "content.db"))
	if av != 2 {
		t.Fatalf("auto_vacuum = %d, want 2 (INCREMENTAL)", av)
	}
}

// readAutoVacuum opens a keyed connection the way a raw caller would and
// reads PRAGMA auto_vacuum. The store does not expose PRAGMA access; the
// test needs a raw view to assert the creation-time decision.
func readAutoVacuum(t *testing.T, path string) int {
	t.Helper()
	db, err := driver.Open("file:"+path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		if err := c.Exec("PRAGMA hexkey='" + keyHex(t) + "'"); err != nil {
			return err
		}
		return c.Exec("PRAGMA busy_timeout=5000")
	})
	if err != nil {
		t.Fatalf("open keyed conn: %v", err)
	}
	defer func() { _ = db.Close() }()
	var av int
	if err := db.QueryRow("PRAGMA auto_vacuum").Scan(&av); err != nil {
		t.Fatalf("auto_vacuum: %v", err)
	}
	return av
}

func keyHex(t *testing.T) string {
	t.Helper()
	k := testKey()
	var b strings.Builder
	for _, c := range k {
		fmt.Fprintf(&b, "%02x", c)
	}
	return b.String()
}

// ── History policy behaviour (settings wired to the store) ───────────────

// Keep-history-off: a command runs and no row appears — through the store,
// not the toggle's own state. The decision applies live: toggling back on
// records again without a restart.
func TestAddHonorsDisabledHistory(t *testing.T) {
	policy := content.NewPolicy()
	policy.SetEnabled(false)

	dir := t.TempDir()
	db, err := content.Open(context.Background(), content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Policy: policy,
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	hist := db.CommandHistory()

	// A command runs while history is off: no row appears, no error.
	if _, addErr := hist.Add(context.Background(), markerRecord("off-1")); addErr != nil {
		t.Fatalf("Add while disabled returned an error: %v", addErr)
	}
	recs, err := hist.List(context.Background(), 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 0 {
		t.Fatalf("history disabled but %d rows appeared", len(recs))
	}

	// Live toggle: enabled again, the next command is recorded.
	policy.SetEnabled(true)
	if _, addErr := hist.Add(context.Background(), markerRecord("on-1")); addErr != nil {
		t.Fatalf("Add: %v", addErr)
	}
	recs, err = hist.List(context.Background(), 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 || recs[0].Command != "on-1" {
		t.Fatalf("after re-enable rows = %+v, want exactly the new command", recs)
	}
}

// Retention by age: the transition is what is proven. An old command added
// while retention is off survives; turning retention on and recording a new
// command sweeps the old one — removed from nocx, not hidden.
func TestRetentionSweepRemovesOldCommands(t *testing.T) {
	policy := content.NewPolicy() // retention off (0 = unbounded)
	dir := t.TempDir()
	db, err := content.Open(context.Background(), content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Policy: policy,
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	hist := db.CommandHistory()
	ctx := context.Background()

	old := time.Now().Add(-48 * time.Hour).UnixMilli()
	oldRec := content.CommandRecord{Command: "old-command", Cwd: "/old", Host: "", Status: content.StatusSuccess, EndedAt: &old}
	if _, addErr := hist.Add(ctx, oldRec); addErr != nil {
		t.Fatalf("Add old: %v", addErr)
	}

	// Retention is off: the old command survives.
	recs, err := hist.List(ctx, 10)
	if err != nil || len(recs) != 1 {
		t.Fatalf("before retention: %d rows (err %v), want the old command kept", len(recs), err)
	}

	// Turn retention on (1 day) and record a fresh command: the sweep runs
	// in that writer turn and removes the old one.
	policy.SetRetentionDays(1)
	now := time.Now().UnixMilli()
	fresh := content.CommandRecord{Command: "fresh-command", Cwd: "/new", Host: "", Status: content.StatusSuccess, EndedAt: &now}
	if _, addErr := hist.Add(ctx, fresh); addErr != nil {
		t.Fatalf("Add fresh: %v", addErr)
	}

	recs, err = hist.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 || recs[0].Command != "fresh-command" {
		t.Fatalf("after sweep rows = %+v, want only the fresh command (old one removed)", recs)
	}
}

// The nocx-rtg0.16 guard: a row recorded NOW survives the age sweep that
// runs in the same writer turn as the INSERT when retention is 30 days (the
// owner's value). The defect this pins: a caller clocking in
// performance.now() units made every ended_at land in January 1970, so the
// sweep deleted each row microseconds after it was written. The store
// cannot tell a 1970 timestamp from a real one — the sweep must only ever
// see wall-clock epoch milliseconds, which is the transport's boundary
// check. What the store itself must never regress is this: a fresh
// epoch-millisecond row survives a retention sweep.
func TestRetentionSweepKeepsFreshRowAt30Days(t *testing.T) {
	policy := content.NewPolicy()
	policy.SetRetentionDays(30)
	dir := t.TempDir()
	db, err := content.Open(context.Background(), content.Config{
		Path:   filepath.Join(dir, "content.db"),
		Key:    testKey(),
		Budget: testBudget,
		Policy: policy,
		Logger: log.NewSlogAdapter(nil),
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	hist := db.CommandHistory()
	ctx := context.Background()

	now := time.Now().UnixMilli()
	rec := content.CommandRecord{Command: "recorded-now", Cwd: "/now", Host: "", Status: content.StatusSuccess, EndedAt: &now}
	if _, addErr := hist.Add(ctx, rec); addErr != nil {
		t.Fatalf("Add: %v", addErr)
	}

	recs, err := hist.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 1 || recs[0].Command != "recorded-now" {
		t.Fatalf("rows after Add with retention 30d = %+v, want the fresh row to survive the same-turn sweep", recs)
	}
}

// The mask facts ride the row: a record written with masked_count and
// masked_kinds reads them back identically through List and Query, and a
// record without them reads back 0/[] — the durable facts describe the
// masked command, never the secret itself.
func TestMaskFactsRoundTrip(t *testing.T) {
	db, _ := newTestStore(t)
	hist := db.CommandHistory()
	ctx := context.Background()

	withFacts := markerRecord("curl -H \"Authorization: Bearer sk-p...7890\" https://api")
	withFacts.MaskedCount = 1
	withFacts.MaskedKinds = []string{"openai"}
	if _, addErr := hist.Add(ctx, withFacts); addErr != nil {
		t.Fatalf("Add: %v", addErr)
	}

	plain := markerRecord("echo hello")
	if _, addErr := hist.Add(ctx, plain); addErr != nil {
		t.Fatalf("Add plain: %v", addErr)
	}

	recs, err := hist.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("List = %d rows, want 2", len(recs))
	}
	if recs[0].Command != "echo hello" {
		t.Fatalf("newest row = %q, want the plain record", recs[0].Command)
	}
	if recs[0].MaskedCount != 0 || len(recs[0].MaskedKinds) != 0 {
		t.Errorf("plain record facts = %d %v, want 0 nil", recs[0].MaskedCount, recs[0].MaskedKinds)
	}
	if recs[1].MaskedCount != 1 || len(recs[1].MaskedKinds) != 1 || recs[1].MaskedKinds[0] != "openai" {
		t.Errorf("masked record facts = %d %v, want 1 [openai]", recs[1].MaskedCount, recs[1].MaskedKinds)
	}

	page, err := hist.Query(ctx, content.ScopeEverywhere, "", "", 10, nil, "")
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if page.Entries[0].MaskedCount != 0 || page.Entries[1].MaskedCount != 1 {
		t.Errorf("query facts = %d %d, want 0 then 1", page.Entries[0].MaskedCount, page.Entries[1].MaskedCount)
	}
}

// ── atomic private-content restore (the export restore operation's seam) ─

// A normal machine: a private-content block with history rows is restored
// whole, and the rows keep their timestamps and facts.
func TestRestorePrivate_RestoresHistoryRows(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	started := int64(1700000000000)
	ended := int64(1700000001000)
	records := []content.CommandRecord{
		{
			Command: "ssh prod", Cwd: "/home/dev", Host: "local", Status: content.StatusSuccess,
			StartedAt: &started, EndedAt: &ended, Trusted: true,
		},
		{Command: "git push", Cwd: "/home/dev/nocx", Host: "local", Status: content.StatusFailure},
	}
	if err := db.RestorePrivate(ctx, nil, records); err != nil {
		t.Fatalf("RestorePrivate: %v", err)
	}

	recs, err := db.CommandHistory().List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("rows after restore = %d, want 2", len(recs))
	}
	// List is newest first; find the ssh prod row by command.
	var found *content.CommandRecord
	for i := range recs {
		if recs[i].Command == "ssh prod" {
			found = &recs[i]
		}
	}
	if found == nil {
		t.Fatal("restored row 'ssh prod' missing")
	}
	if found.StartedAt == nil || *found.StartedAt != started || found.EndedAt == nil || *found.EndedAt != ended {
		t.Errorf("restored timestamps not preserved: %+v", found)
	}
	if !found.Trusted {
		t.Errorf("restored row lost Trusted: %+v", found)
	}
}

// A block that carries conversations is refused on the SQLite backing (they
// are stubbed until agent mode) — and the refusal must leave the store
// untouched: refusing after writing the history rows would be the partial
// restore the atomicity contract exists to prevent.
func TestRestorePrivate_ConversationsRefusedAtomically(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	err := db.RestorePrivate(ctx, []content.Conversation{{ID: "conv-1", Title: "t"}}, []content.CommandRecord{
		{Command: "ssh prod", Cwd: "/", Host: "local", Status: content.StatusSuccess},
	})
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Fatalf("err = %v, want ErrNotImplemented", err)
	}
	recs, err := db.CommandHistory().List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 0 {
		t.Errorf("history rows written despite conversation refusal: %d", len(recs))
	}
}

// Cancellation before the writer accepts the request changes nothing on
// disk — the pre-commit half of the restore operation's interval.
func TestRestorePrivate_CancelledBeforeAcceptanceChangesNothing(t *testing.T) {
	db, _ := newTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := db.RestorePrivate(ctx, nil, []content.CommandRecord{
		{Command: "ssh prod", Cwd: "/", Host: "local", Status: content.StatusSuccess},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	recs, err := db.CommandHistory().List(context.Background(), 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(recs) != 0 {
		t.Errorf("rows written despite pre-acceptance cancellation: %d", len(recs))
	}
}

// A closed store refuses the restore cleanly — and a restore of nothing is
// still a no-op success, never a write to a closed store.
func TestRestorePrivate_ClosedStoreRefuses(t *testing.T) {
	db, _ := newTestStore(t)
	if closeErr := db.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
	err := db.RestorePrivate(context.Background(), nil, []content.CommandRecord{
		{Command: "ssh prod", Cwd: "/", Host: "local", Status: content.StatusSuccess},
	})
	if !errors.Is(err, content.ErrClosed) {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
}
