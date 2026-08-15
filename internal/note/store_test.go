package note_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ncruces/go-sqlite3"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum"

	"github.com/shady2k/nocx/internal/note"
)

// The key is the caller's; these tests only need one that is the right size.
func testKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 1)
	}
	return k
}

func openStore(t *testing.T) (note.Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notes.db")
	st, err := note.Open(context.Background(), note.Config{Path: path, Key: testKey()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, path
}

func TestOpenOnAnAbsentFileIsAnEmptyLibrary(t *testing.T) {
	st, _ := openStore(t)
	rows, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("want an empty library, got %d rows", len(rows))
	}
}

func TestARoundTripPreservesTheBodyExactly(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	// Newlines, trailing whitespace and non-ASCII: a note is somebody's
	// text, and a store that "cleans" it has changed what they wrote.
	body := "# Заголовок\n\n  ssh -L 8080:localhost:8080 host  \n\nконец\n"
	created, err := st.Create(ctx, note.Note{ID: "n1", Body: body, CreatedAt: 10, UpdatedAt: 10})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := st.Get(ctx, created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Body != body {
		t.Fatalf("body round trip differs:\nwant %q\ngot  %q", body, got.Body)
	}
	if got.CreatedAt != 10 || got.UpdatedAt != 10 {
		t.Fatalf("timestamps not preserved: %+v", got)
	}
}

func TestGetOnAMissingNoteIsErrNotFound(t *testing.T) {
	st, _ := openStore(t)
	if _, err := st.Get(context.Background(), "nope"); !errors.Is(err, note.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestUpdateAndDelete(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	if _, err := st.Create(ctx, note.Note{ID: "n1", Body: "first", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := st.Update(ctx, note.Note{ID: "n1", Body: "second", UpdatedAt: 2}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got, err := st.Get(ctx, "n1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Body != "second" || got.UpdatedAt != 2 {
		t.Fatalf("update did not land: %+v", got)
	}
	// Created stays what it was: an edit is not a new note.
	if got.CreatedAt != 1 {
		t.Fatalf("createdAt moved on update: %+v", got)
	}
	if err = st.Delete(ctx, "n1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err = st.Get(ctx, "n1"); !errors.Is(err, note.ErrNotFound) {
		t.Fatalf("want ErrNotFound after delete, got %v", err)
	}
	if _, err = st.Update(ctx, note.Note{ID: "n1", Body: "x"}); err == nil {
		t.Fatal("update of a deleted note must fail, not resurrect it")
	} else if !errors.Is(err, note.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestListIsNewestFirst(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	for _, n := range []note.Note{
		{ID: "old", Body: "old", CreatedAt: 1, UpdatedAt: 1},
		{ID: "new", Body: "new", CreatedAt: 2, UpdatedAt: 30},
		{ID: "mid", Body: "mid", CreatedAt: 3, UpdatedAt: 20},
	} {
		if _, err := st.Create(ctx, n); err != nil {
			t.Fatalf("Create %s: %v", n.ID, err)
		}
	}
	rows, err := st.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := []string{rows[0].ID, rows[1].ID, rows[2].ID}
	want := []string{"new", "mid", "old"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("list order = %v, want %v (most recently touched first)", got, want)
		}
	}
}

func TestSearchFindsAWordThatIsOnlyInTheBody(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	if _, err := st.Create(ctx, note.Note{
		ID: "n1", Body: "Deploy notes\n\nkubectl rollout status api-server\n", CreatedAt: 1, UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := st.Create(ctx, note.Note{
		ID: "n2", Body: "Something else entirely\n", CreatedAt: 2, UpdatedAt: 2,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	hits, err := st.Search(ctx, "rollout")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].ID != "n1" {
		t.Fatalf("want exactly n1, got %+v", hits)
	}
	// The excerpt is what a result row shows, so it has to contain the word
	// that matched — otherwise the row cannot explain why it is there.
	if !strings.Contains(strings.ToLower(hits[0].Excerpt), "rollout") {
		t.Fatalf("excerpt does not carry the match: %q", hits[0].Excerpt)
	}
}

func TestSearchMatchesCyrillic(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	if _, err := st.Create(ctx, note.Note{
		ID: "n1", Body: "Заметка\n\nперезапустить прокси на стенде\n", CreatedAt: 1, UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	hits, err := st.Search(ctx, "прокси")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("want one hit for a cyrillic word, got %d", len(hits))
	}
}

func TestSearchOnAnEmptyQueryAnswersNothing(t *testing.T) {
	st, _ := openStore(t)
	ctx := context.Background()
	if _, err := st.Create(ctx, note.Note{ID: "n1", Body: "x", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	hits, err := st.Search(ctx, "   ")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("an empty query is not a search for everything: got %d", len(hits))
	}
}

func TestSearchRefusesNothingItCannotParse(t *testing.T) {
	// FTS5's query syntax is a language: a person typing `foo"` or `AND`
	// into a search field must get a result or an empty list, never a
	// parse error from a query language they did not know they were using.
	st, _ := openStore(t)
	ctx := context.Background()
	if _, err := st.Create(ctx, note.Note{ID: "n1", Body: "quoted \"thing\" here", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	for _, q := range []string{`"`, `foo"`, `AND`, `*`, `NEAR(`, `a OR`} {
		if _, err := st.Search(ctx, q); err != nil {
			t.Fatalf("Search(%q) returned an error to the user: %v", q, err)
		}
	}
	hits, err := st.Search(ctx, `"thing"`)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("a quoted word still matches: got %d", len(hits))
	}
}

func TestTheSchemaHasNoTitleColumn(t *testing.T) {
	// The title is derived from the body every time it is read (spec §7). A
	// column here would be a second owner of one fact, and the two disagree
	// the first time somebody edits the first line.
	_, path := openStore(t)
	db := openRaw(t, path)
	defer db.Close() //nolint:errcheck
	rows, err := db.Query(`SELECT name FROM pragma_table_info('notes')`)
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == "title" {
			t.Fatal("the notes table has a title column; the title is derived, never stored")
		}
	}
}

func TestASchemaChangeKeepsEveryRow(t *testing.T) {
	// The rule this store exists to keep (spec §4.2): internal/content
	// REBUILDS its file when the schema version changes, discarding the
	// rows deliberately — right for a log, robbery for authored text. A
	// notes build that copied that would fail here.
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "notes.db")
	st, err := note.Open(ctx, note.Config{Path: path, Key: testKey()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err = st.Create(ctx, note.Note{ID: "n1", Body: "keep me", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err = st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Age the file: a database written by an EARLIER schema of this store.
	db := openRaw(t, path)
	if _, err = db.Exec("PRAGMA user_version = 1"); err != nil {
		t.Fatalf("age the file: %v", err)
	}
	if err = db.Close(); err != nil {
		t.Fatalf("close raw: %v", err)
	}

	reopened, err := note.Open(ctx, note.Config{Path: path, Key: testKey()})
	if err != nil {
		t.Fatalf("reopen after a schema change: %v", err)
	}
	defer reopened.Close() //nolint:errcheck
	got, err := reopened.Get(ctx, "n1")
	if err != nil {
		t.Fatalf("the note did not survive the schema change: %v", err)
	}
	if got.Body != "keep me" {
		t.Fatalf("body changed across the migration: %q", got.Body)
	}
}

func TestOpenRefusesAKeyThatIsNotAKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.db")
	if _, err := note.Open(context.Background(), note.Config{Path: path, Key: []byte("short")}); err == nil {
		t.Fatal("a wrong-sized key must be refused, not silently accepted")
	}
	if _, err := note.Open(context.Background(), note.Config{Path: path}); err == nil {
		t.Fatal("no key at all must be refused: an unencrypted notes file is not a fallback")
	}
}

func TestOpenReportsAPathItCannotUse(t *testing.T) {
	// The failing external call every store must answer for: the file
	// system said no. Unavailable is an error the product can show, never
	// an empty library.
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("arrange: %v", err)
	}
	_, err := note.Open(context.Background(), note.Config{
		Path: filepath.Join(blocker, "notes.db"),
		Key:  testKey(),
	})
	if err == nil {
		t.Fatal("Open must fail when the path cannot hold a database")
	}
}

func TestTheFileIsEncryptedAtRest(t *testing.T) {
	// The key is not decoration: the body must not be readable in the file.
	st, path := openStore(t)
	if _, err := st.Create(context.Background(), note.Note{
		ID: "n1", Body: "correct-horse-battery-staple", CreatedAt: 1, UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	raw, err := os.ReadFile(path) //nolint:gosec // a path this test made
	if err != nil {
		t.Fatalf("read the file: %v", err)
	}
	if strings.Contains(string(raw), "correct-horse-battery-staple") {
		t.Fatal("the note's text is readable in the database file")
	}
}

/** openRaw opens the same encrypted file directly, for the assertions that
 *  are about the FILE rather than about the store's API. */
func openRaw(t *testing.T, path string) *sql.DB {
	t.Helper()
	keyHex := ""
	for _, b := range testKey() {
		keyHex += string("0123456789abcdef"[b>>4]) + string("0123456789abcdef"[b&0x0f])
	}
	db, err := sqlitedriver.Open("file:"+path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		return c.Exec("PRAGMA hexkey='" + keyHex + "'")
	})
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	return db
}
