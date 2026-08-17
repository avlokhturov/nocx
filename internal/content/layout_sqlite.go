package content

// The SQLite implementation of LayoutRepository (nocx-isoph.1). Every
// mutation goes through the single writer goroutine (run, in sqlite.go —
// design §5.3); every read goes through the pool directly.
//
// The methods hang off *sqliteContent and are returned as the seam by
// Layout(); there is no wrapper type because, unlike the ledger, nothing here
// collides with a command_history method name.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/shady2k/nocx/internal/lineage"
)

var _ LayoutRepository = (*sqliteContent)(nil)

// ErrNoSuchTab is returned when a lineage parent names no tab. It is the
// STORE's own statement — internal/lineage refuses shapes and deliberately
// knows nothing about nodes — and it is reported before the insert rather
// than left to the foreign key, because the ancestry walk has to resolve the
// same row anyway and a half-answered walk is worse than a refusal.
var ErrNoSuchTab = errors.New("content: no such tab")

// ── workspaces ───────────────────────────────────────────────────────────

func (s *sqliteContent) CreateWorkspace(ctx context.Context, ws Workspace) error {
	return s.run(ctx, func(ctx context.Context) error {
		// A plain INSERT, never an upsert: the id is client-minted and
		// UNTRUSTED (§7), so a second use of one FAILS rather than
		// overwriting the workspace somebody else is working in.
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO workspaces (id, name, position, created_at) VALUES (?, ?, ?, ?)`,
			ws.ID, ws.Name, ws.Position, time.Now().UnixMilli())
		return err
	})
}

func (s *sqliteContent) Workspaces(ctx context.Context) ([]Workspace, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, position FROM workspaces ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Workspace{}
	for rows.Next() {
		var ws Workspace
		if err := rows.Scan(&ws.ID, &ws.Name, &ws.Position); err != nil {
			return nil, err
		}
		out = append(out, ws)
	}
	return out, rows.Err()
}

// DeleteWorkspace takes the workspace's tabs and their panes with it, through
// the two ON DELETE CASCADEs. Stated here as well as in the schema because a
// delete behaviour nobody wrote down is a delete behaviour nobody tested.
func (s *sqliteContent) DeleteWorkspace(ctx context.Context, id string) error {
	return s.run(ctx, func(ctx context.Context) error {
		_, err := s.db.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, id)
		return err
	})
}

// ── tabs ─────────────────────────────────────────────────────────────────

// CreateTab admits the lineage edge and then writes the row, both in ONE
// transaction: the ancestry the walk read must be the ancestry the insert
// lands against, or a concurrent create could stretch a chain past the bound
// between the two.
//
// The walk itself belongs to internal/lineage — the same three rules
// (self, cycle, depth) a session's parent is admitted by, and there is
// exactly one implementation of them. What stays here is the resolver,
// because only the store can say whether a tab row exists.
func (s *sqliteContent) CreateTab(ctx context.Context, tab Tab) error {
	return s.run(ctx, func(ctx context.Context) error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()

		if tab.ParentID != nil {
			if err := lineage.Validate(*tab.ParentID,
				func(at string) bool { return at == tab.ID },
				func(at string) (string, bool, error) {
					var parent sql.NullString
					row := tx.QueryRowContext(ctx, `SELECT parent_id FROM tabs WHERE id = ?`, at)
					switch err := row.Scan(&parent); {
					case errors.Is(err, sql.ErrNoRows):
						return "", false, fmt.Errorf("%w: %s", ErrNoSuchTab, at)
					case err != nil:
						return "", false, err
					}
					return parent.String, parent.Valid, nil
				}); err != nil {
				return err
			}
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO tabs (id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			tab.ID, tab.WorkspaceID, tab.ParentID, tab.Name, tab.Colour,
			tab.Position, boolToInt(tab.Pinned), string(tab.Layout), tab.SeenAt); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func (s *sqliteContent) Tabs(ctx context.Context, workspaceID string) ([]Tab, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at
		   FROM tabs WHERE workspace_id = ? ORDER BY position, id`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Tab{}
	for rows.Next() {
		var (
			t      Tab
			parent sql.NullString
			name   sql.NullString
			colour sql.NullString
			pinned int
			layout string
			seenAt sql.NullInt64
		)
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &parent, &name, &colour,
			&t.Position, &pinned, &layout, &seenAt); err != nil {
			return nil, err
		}
		t.ParentID = nullableString(parent)
		t.Name = nullableString(name)
		t.Colour = nullableString(colour)
		t.Pinned = pinned != 0
		t.Layout = TabLayout(layout)
		if seenAt.Valid {
			v := seenAt.Int64
			t.SeenAt = &v
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteTab takes the tab's panes with it (ON DELETE CASCADE) and leaves any
// tab that records it as lineage parent standing, with a null parent (ON
// DELETE SET NULL) — the honest "provenance lost" state. See the interface
// for why neither of the other two behaviours fits.
func (s *sqliteContent) DeleteTab(ctx context.Context, id string) error {
	return s.run(ctx, func(ctx context.Context) error {
		_, err := s.db.ExecContext(ctx, `DELETE FROM tabs WHERE id = ?`, id)
		return err
	})
}

// ── panes ────────────────────────────────────────────────────────────────

func (s *sqliteContent) CreatePane(ctx context.Context, pane Pane) error {
	return s.run(ctx, func(ctx context.Context) error {
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO panes (id, tab_id, cwd, kind, endpoint, size_share)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			pane.ID, pane.TabID, pane.Cwd, string(pane.Kind), pane.Endpoint, pane.SizeShare)
		return err
	})
}

func (s *sqliteContent) Panes(ctx context.Context, tabID string) ([]Pane, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, tab_id, cwd, kind, endpoint, size_share
		   FROM panes WHERE tab_id = ? ORDER BY id`, tabID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Pane{}
	for rows.Next() {
		var (
			p        Pane
			kind     string
			endpoint sql.NullString
		)
		if err := rows.Scan(&p.ID, &p.TabID, &p.Cwd, &kind, &endpoint, &p.SizeShare); err != nil {
			return nil, err
		}
		p.Kind = PaneKind(kind)
		p.Endpoint = nullableString(endpoint)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *sqliteContent) DeletePane(ctx context.Context, id string) error {
	return s.run(ctx, func(ctx context.Context) error {
		_, err := s.db.ExecContext(ctx, `DELETE FROM panes WHERE id = ?`, id)
		return err
	})
}

// ── helpers ──────────────────────────────────────────────────────────────

func nullableString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
