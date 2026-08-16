package note

// The encrypted SQLite store (spec §4). Same VFS and same key as the
// history store — adiantum over the wasm build, the key from
// internal/contentkey — and a deliberately different upgrade rule: this
// file is MIGRATED, never rebuilt (see the package comment).
//
// FTS5 is the reason search is a query rather than a scan the frontend does
// over everything it loaded. It arrives as a loadable extension registered
// on every connection (ext/fts5), over the wasm module already in go.mod:
// no second binary and no build tag. Measured on 2026-08-16, including a
// Cyrillic match and snippet() excerpts.

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ncruces/go-sqlite3"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/fts5"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum" // encryption VFS
)

// keyBytes is the size the adiantum VFS takes, and the size contentkey
// produces. A different size is a caller error, not something to pad.
const keyBytes = 32

// busyTimeoutMs matches the history store's: one app, few writers, but a
// backup or a restore can hold the file for a moment.
const busyTimeoutMs = 5000

// schemaVersion is stamped into the file's user_version. Bumping it selects
// the migrations below — it never rebuilds the file.
const schemaVersion = 1

// excerptRunes bounds the excerpt a list row carries. Long enough to
// recognise the note, short enough that a list is not the note.
const excerptRunes = 120

// Config is what Open needs. Everything is required: a notes file with no
// key is not a fallback, it is a leak.
type Config struct {
	Path string
	Key  []byte
}

type store struct {
	db *sql.DB
}

// Open opens (and creates, if it is absent) the notes database. An absent
// file is an empty library; a file that cannot be opened is an error, and
// the caller reports it as UNAVAILABLE rather than as "you have no notes".
func Open(ctx context.Context, cfg Config) (Store, error) {
	if len(cfg.Key) != keyBytes {
		return nil, fmt.Errorf("note: key must be %d bytes, got %d", keyBytes, len(cfg.Key))
	}
	if cfg.Path == "" {
		return nil, errors.New("note: empty path")
	}
	dir := filepath.Dir(cfg.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("note: create %s: %w", dir, err)
	}

	keyHex := hex.EncodeToString(cfg.Key)
	db, err := sqlitedriver.Open("file:"+cfg.Path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		// The key comes first: every statement after it is encrypted, and a
		// pragma before it would be written in the clear.
		if err := c.Exec("PRAGMA hexkey='" + keyHex + "'"); err != nil {
			return fmt.Errorf("note: key: %w", err)
		}
		// FTS5 is per-connection: the pool opens more than one, and a
		// connection without the extension cannot read the index.
		if err := fts5.Register(c); err != nil {
			return fmt.Errorf("note: fts5: %w", err)
		}
		if err := c.Exec(fmt.Sprintf("PRAGMA busy_timeout=%d", busyTimeoutMs)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("note: open %s: %w", cfg.Path, err)
	}

	st := &store{db: db}
	if err := st.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return st, nil
}

// migrate brings the file to schemaVersion. It only ever ADDS: a file
// written by an older build keeps every row it had, which is this store's
// whole contract. The v1 statements are idempotent, so a fresh file and a
// v0 file take the same path.
func (s *store) migrate(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("note: read schema version: %w", err)
	}
	if version > schemaVersion {
		// Written by a NEWER build: refuse rather than write into a shape
		// this build does not understand. Downgrading is how rows get lost.
		return fmt.Errorf("note: database schema %d is newer than this build's %d", version, schemaVersion)
	}
	if version == schemaVersion {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("note: migrate: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, schemaV1); err != nil {
		return fmt.Errorf("note: migrate to v1: %w", err)
	}
	// A file that already carried rows keeps them, and the index is filled
	// from what is there — an FTS table created beside existing rows is
	// empty until it is told about them.
	if _, err = tx.ExecContext(ctx, `INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')`); err != nil {
		return fmt.Errorf("note: build the search index: %w", err)
	}
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("note: stamp schema version: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("note: migrate: %w", err)
	}
	return nil
}

// schemaV1 — the table, the index over it, and the three triggers that keep
// the two in step. `content=` makes the index external-content: the text
// lives once, in notes.
const schemaV1 = `
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  body,
  content='notes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`

func (s *store) Close() error { return s.db.Close() }

func (s *store) List(ctx context.Context) ([]Row, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, body, updated_at FROM notes ORDER BY updated_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("note: list: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []Row{}
	for rows.Next() {
		var id, body string
		var updated int64
		if err := rows.Scan(&id, &body, &updated); err != nil {
			return nil, fmt.Errorf("note: list: %w", err)
		}
		out = append(out, Row{
			ID:        id,
			Title:     DeriveTitle(body),
			Excerpt:   excerptOf(body),
			UpdatedAt: updated,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("note: list: %w", err)
	}
	return out, nil
}

// LoadAll is the backup's read: bodies and timestamps included.
func (s *store) LoadAll(ctx context.Context) ([]Note, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, body, created_at, updated_at FROM notes ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("note: load all: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.Body, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, fmt.Errorf("note: load all: %w", err)
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("note: load all: %w", err)
	}
	return out, nil
}

// ReplaceAll makes the library exactly `notes`, in ONE transaction: a
// restore that half-applied would leave somebody's notes in a state neither
// the backup nor the machine ever had.
func (s *store) ReplaceAll(ctx context.Context, notes []Note) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("note: replace all: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `DELETE FROM notes`); err != nil {
		return fmt.Errorf("note: replace all: %w", err)
	}
	for _, n := range notes {
		if _, err = tx.ExecContext(ctx,
			`INSERT INTO notes (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			n.ID, n.Body, n.CreatedAt, n.UpdatedAt); err != nil {
			return fmt.Errorf("note: replace all: %w", err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("note: replace all: %w", err)
	}
	return nil
}

func (s *store) Get(ctx context.Context, id string) (Note, error) {
	var n Note
	err := s.db.QueryRowContext(ctx,
		`SELECT id, body, created_at, updated_at FROM notes WHERE id = ?`, id).
		Scan(&n.ID, &n.Body, &n.CreatedAt, &n.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, ErrNotFound
	}
	if err != nil {
		return Note{}, fmt.Errorf("note: get: %w", err)
	}
	return n, nil
}

func (s *store) Create(ctx context.Context, n Note) (Note, error) {
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO notes (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		n.ID, n.Body, n.CreatedAt, n.UpdatedAt); err != nil {
		return Note{}, fmt.Errorf("note: create: %w", err)
	}
	return n, nil
}

// Update replaces the body and the updated stamp. created_at is NOT touched:
// an edit is not a new note, and a list ordered by "touched" must still be
// able to say when the note was started.
func (s *store) Update(ctx context.Context, n Note) (Note, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`, n.Body, n.UpdatedAt, n.ID)
	if err != nil {
		return Note{}, fmt.Errorf("note: update: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return Note{}, fmt.Errorf("note: update: %w", err)
	}
	if affected == 0 {
		// Never an INSERT: an update of a note somebody deleted would
		// resurrect it under the id of a thing they threw away.
		return Note{}, ErrNotFound
	}
	return s.Get(ctx, n.ID)
}

func (s *store) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("note: delete: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("note: delete: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

// Search answers the person's words, not FTS5's query language. Whatever
// they typed is turned into a phrase match (§8): a stray quote, an `AND` or
// a `NEAR(` is text somebody typed into a search field, and answering it
// with a parse error would be reporting our implementation as their
// mistake.
func (s *store) Search(ctx context.Context, query string) ([]Row, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		// An empty query is not a search for everything: the list already
		// shows everything, and this seam answers a question nobody asked.
		return []Row{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT n.id, n.body, n.updated_at, snippet(notes_fts, 0, '', '', '…', 12)
FROM notes_fts
JOIN notes n ON n.rowid = notes_fts.rowid
WHERE notes_fts MATCH ?
ORDER BY rank
LIMIT 200`, ftsPhrase(q))
	if err != nil {
		return nil, fmt.Errorf("note: search: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []Row{}
	for rows.Next() {
		var id, body, excerpt string
		var updated int64
		if err := rows.Scan(&id, &body, &updated, &excerpt); err != nil {
			return nil, fmt.Errorf("note: search: %w", err)
		}
		out = append(out, Row{
			ID:        id,
			Title:     DeriveTitle(body),
			Excerpt:   strings.TrimSpace(excerpt),
			UpdatedAt: updated,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("note: search: %w", err)
	}
	return out, nil
}

// ftsPhrase quotes what was typed as ONE phrase, with FTS5's own escape for
// a quote (double it), and appends `*` so a half-typed word still matches —
// search runs while a person is typing, and a query that only answers
// finished words answers nothing until they stop.
func ftsPhrase(q string) string {
	return `"` + strings.ReplaceAll(q, `"`, `""`) + `"*`
}

// excerptOf is the list row's second line: the first non-empty line that is
// not the title, or the title's line when that is all there is.
func excerptOf(body string) string {
	title := DeriveTitle(body)
	seenTitle := false
	for line := range strings.SplitSeq(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		cleaned := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
		if !seenTitle && cleaned == title {
			seenTitle = true
			continue
		}
		return boundRunes(trimmed, excerptRunes)
	}
	return ""
}
