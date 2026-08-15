// Package note is the notes library: text a person wrote down, kept
// encrypted, searched by what is inside it.
//
// Spec: .internal/specs/2026-08-16-notes-design.md.
//
// The one rule that separates this package from internal/content, and the
// reason it is a package at all rather than three tables in that one:
//
//	THIS STORE NEVER DISCARDS.
//
// internal/content stamps a schema version and REBUILDS its file when the
// version moves — every table dropped, every row gone — because a
// half-broken history store is worse than none and a command log can be
// re-made by living. Text somebody wrote cannot. So a schema change here
// ships with a migration or it does not ship, and a file that cannot be
// opened is an ERROR the product shows, never an empty library it implies.
package note

import (
	"context"
	"errors"
)

// ErrNotFound is "no note with that id" — the client's error, not the
// server's, and the only outcome a caller has to tell apart.
var ErrNotFound = errors.New("note: not found")

// Note is one record. There is no Title field: the title is DERIVED from
// the body every time it is read (DeriveTitle), because a stored title
// beside the text it comes from is two owners of one fact, and they
// disagree the first time somebody edits the first line.
type Note struct {
	ID string `json:"id"`
	// Title is DERIVED on the way out (wireNote), never read from the
	// database and never accepted from a caller. It travels with the note so
	// the tab's title has one owner: a renderer deriving its own would be
	// the second, and the two would disagree the first time somebody edits
	// the first line.
	Title     string `json:"title"`
	Body      string `json:"body"`
	CreatedAt int64  `json:"createdAt"` // epoch ms
	UpdatedAt int64  `json:"updatedAt"` // epoch ms
}

// Row is what a LIST shows: a note without its body. The list is a list —
// sending every note's prose so a row can render forty pixels of it is a
// cost that stays invisible until the library is big.
type Row struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Excerpt   string `json:"excerpt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Store is the persistence seam. Implemented by the encrypted SQLite store
// in this package; substituted in tests through this interface, never by
// reaching into the database.
type Store interface {
	List(ctx context.Context) ([]Row, error)
	// LoadAll is the BACKUP's read: every note WITH its body and its
	// timestamps. List is deliberately not this — a list is a list, and the
	// difference is the whole reason both exist.
	LoadAll(ctx context.Context) ([]Note, error)
	// ReplaceAll is the RESTORE's write: the library becomes exactly this,
	// in one transaction. A restore that could half-apply would leave
	// somebody's notes in a state neither the backup nor the machine ever
	// had.
	ReplaceAll(ctx context.Context, notes []Note) error
	Get(ctx context.Context, id string) (Note, error)
	Create(ctx context.Context, n Note) (Note, error)
	Update(ctx context.Context, n Note) (Note, error)
	Delete(ctx context.Context, id string) error
	Search(ctx context.Context, query string) ([]Row, error)
	Close() error
}
