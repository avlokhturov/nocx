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
	"strings"
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

// The lifecycle's refusals (nocx-isoph.3). Each one names a state the model
// says is unreachable, and each is reported BEFORE anything is written, so a
// refusal never has to be undone.
var (
	// ErrNoFirstTab: a workspace with no tabs has no meaning, so it is not
	// created empty and then filled — it is created with its first tab.
	ErrNoFirstTab = errors.New("content: a workspace is created together with its first tab")
	// ErrNoFirstPane: the same rule one rung down, and §4.4's mint — a tab
	// is what a pane is dragged out INTO, so the pane comes with it.
	ErrNoFirstPane = errors.New("content: a tab is created together with its first pane")
	// ErrMismatchedContainer: the first tab named a workspace other than the
	// one being created, or the first pane a tab other than the one being
	// created. Re-parenting silently would make the call's own subject a
	// second answer to a question it is already answering.
	ErrMismatchedContainer = errors.New("content: the first member names another container")
	// ErrNoReplacement: the close would leave the application with no tab at
	// all and carried no identity for the one that replaces it. Fails closed
	// — nothing is removed — because the alternative is a state no surface
	// can render, and minting the id here would put a durable pane id in the
	// backend, which §7 refuses.
	ErrNoReplacement = errors.New("content: closing the last tab needs the replacement's identity")
	// ErrDefaultWorkspace: the default workspace is not closed. It never
	// renders, it is where the replacement tab goes, and the ledger records
	// every session nobody named a workspace for under it.
	ErrDefaultWorkspace = errors.New("content: the default workspace is not closed")
	// ErrNoSuchPane: a move naming a pane no row carries. Reported rather
	// than treated as a no-op, so a move never half-applies.
	ErrNoSuchPane = errors.New("content: no such pane")
	// ErrCrossWorkspaceMove: whether a pane may be dragged between
	// workspaces is open (design §12 q. 5) and the atomicity model for a
	// subtree move is undesigned; the inherited requirement is that a
	// partial move fails closed, so the whole move is refused.
	ErrCrossWorkspaceMove = errors.New("content: a pane is not moved between workspaces yet")
)

// The row writers below take the execer sqlite.go already declares — the
// ExecContext surface *sql.DB and *sql.Tx share — so a create and the
// replacement mint go through ONE implementation of "write this row". Two
// would agree until the day they did not.

// ── workspaces ───────────────────────────────────────────────────────────

// CreateWorkspace mints the workspace, its first tab and that tab's first
// pane in ONE transaction (§4.1 of the workspaces UX design). There is
// therefore no moment at which an empty workspace or an empty tab exists,
// which is what makes "a container exists only while it holds a member" cheap
// — the state is unreachable rather than swept up afterwards.
func (s *sqliteContent) CreateWorkspace(ctx context.Context, ws Workspace, firstTab Tab, firstPane Pane) error {
	if strings.TrimSpace(firstTab.ID) == "" {
		return ErrNoFirstTab
	}
	if strings.TrimSpace(firstPane.ID) == "" {
		return ErrNoFirstPane
	}
	if firstTab.WorkspaceID != "" && firstTab.WorkspaceID != ws.ID {
		return fmt.Errorf("%w: tab %s names workspace %s", ErrMismatchedContainer, firstTab.ID, firstTab.WorkspaceID)
	}
	if firstPane.TabID != "" && firstPane.TabID != firstTab.ID {
		return fmt.Errorf("%w: pane %s names tab %s", ErrMismatchedContainer, firstPane.ID, firstPane.TabID)
	}
	firstTab.WorkspaceID = ws.ID
	firstPane.TabID = firstTab.ID
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			if err := insertWorkspace(ctx, tx, ws); err != nil {
				return err
			}
			if err := admitAndInsertTab(ctx, tx, firstTab); err != nil {
				return err
			}
			return insertPane(ctx, tx, firstPane)
		})
	})
}

// insertWorkspace is a plain INSERT, never an upsert: the id is client-minted
// and UNTRUSTED (§7), so a second use of one FAILS rather than overwriting
// the workspace somebody else is working in.
func insertWorkspace(ctx context.Context, db execer, ws Workspace) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO workspaces (id, name, position, created_at) VALUES (?, ?, ?, ?)`,
		ws.ID, ws.Name, ws.Position, time.Now().UnixMilli())
	return err
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
// the two ON DELETE CASCADEs — and the sessions recorded under it, through a
// third. Stated here as well as in the schema because a delete behaviour
// nobody wrote down is a delete behaviour nobody tested.
//
// The DEFAULT workspace is refused. Closing it is not an affordance any
// surface has (§4.2: it never renders), and its row is load bearing twice
// over: the replacement tab goes there, and the ledger's fallback records
// every session nobody named a workspace for against it, so deleting the row
// would take those restore keys with it and then need it back immediately.
func (s *sqliteContent) DeleteWorkspace(ctx context.Context, id string, next Replacement) error {
	if id == DefaultWorkspaceID {
		return ErrDefaultWorkspace
	}
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			// A workspace no row carries is not a failure and not a close:
			// nothing was removed, so nothing may be minted either. The same
			// shape as DeleteTab and DeletePane, and the reason all three
			// check is that a replacement minted for a close that did not
			// happen is a tab the user never asked for.
			var exists int
			if err := tx.QueryRowContext(ctx,
				`SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`, id).Scan(&exists); err != nil {
				return err
			}
			if exists == 0 {
				return nil
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, id); err != nil {
				return err
			}
			return mintReplacementIfEmpty(ctx, tx, next)
		})
	})
}

// ── the lifecycle, one implementation of each rung ───────────────────────

// inTx runs fn in a transaction and commits it, or rolls the whole thing back.
// Every lifecycle step goes through it, which is what makes "the container's
// row goes in the SAME TRANSACTION that removes its last member" a property of
// the code rather than a sentence in a comment.
func (s *sqliteContent) inTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// dissolveTabIfEmpty removes the tab when its last pane has just left, and
// then asks the same question of its workspace. It is called from inside the
// caller's transaction, never on its own.
func dissolveTabIfEmpty(ctx context.Context, tx *sql.Tx, tabID string) error {
	var panes int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM panes WHERE tab_id = ?`, tabID).Scan(&panes); err != nil {
		return err
	}
	if panes > 0 {
		return nil
	}
	var workspaceID string
	switch err := tx.QueryRowContext(ctx,
		`SELECT workspace_id FROM tabs WHERE id = ?`, tabID).Scan(&workspaceID); {
	case errors.Is(err, sql.ErrNoRows):
		return nil
	case err != nil:
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tabs WHERE id = ?`, tabID); err != nil {
		return err
	}
	return dissolveWorkspaceIfEmpty(ctx, tx, workspaceID)
}

// dissolveWorkspaceIfEmpty removes the workspace when its last tab has just
// left. The default is the one exemption, for the reasons DeleteWorkspace
// gives.
func dissolveWorkspaceIfEmpty(ctx context.Context, tx *sql.Tx, workspaceID string) error {
	if workspaceID == DefaultWorkspaceID {
		return nil
	}
	var tabs int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM tabs WHERE workspace_id = ?`, workspaceID).Scan(&tabs); err != nil {
		return err
	}
	if tabs > 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, workspaceID)
	return err
}

// mintReplacementIfEmpty gives the application a tab again when the close
// just took its last one (§4.4 of the workspaces UX design). It goes to the
// DEFAULT workspace, never to the one being closed — otherwise closing a
// workspace resurrects what it just deleted — and it arrives with a pane,
// like every other container here.
//
// In the SAME transaction as the close, so the two ends meet: either the
// application still has the tab it had, or it has the replacement. A caller
// that supplied no identity gets ErrNoReplacement and loses nothing.
func mintReplacementIfEmpty(ctx context.Context, tx *sql.Tx, next Replacement) error {
	var stillOpen int
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM tabs)`).Scan(&stillOpen); err != nil {
		return err
	}
	if stillOpen != 0 {
		return nil
	}
	if strings.TrimSpace(next.TabID) == "" || strings.TrimSpace(next.PaneID) == "" {
		return ErrNoReplacement
	}
	// The default workspace's row may not exist yet — nothing creates it
	// eagerly, and the one being closed may have been the only one. OR
	// IGNORE rather than a check-then-insert: the ledger's fallback writes
	// the same row the same way, and two writers racing to create it must
	// not turn into a failed close.
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO workspaces (id, name, position, created_at) VALUES (?, 'default', 0, ?)`,
		DefaultWorkspaceID, time.Now().UnixMilli()); err != nil {
		return err
	}
	if err := admitAndInsertTab(ctx, tx, Tab{
		ID:          next.TabID,
		WorkspaceID: DefaultWorkspaceID,
		Layout:      LayoutRow,
	}); err != nil {
		return err
	}
	// No lineage parent, and that is deliberate: the replacement was spawned
	// by nobody. Recording the closed tab as its parent would make an
	// automatic housekeeping act look like provenance (§4.2).
	return insertPane(ctx, tx, Pane{
		ID:        next.PaneID,
		TabID:     next.TabID,
		Cwd:       next.Cwd,
		Kind:      PaneLocal,
		SizeShare: 1,
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
func (s *sqliteContent) CreateTab(ctx context.Context, tab Tab, firstPane Pane) error {
	if strings.TrimSpace(firstPane.ID) == "" {
		return ErrNoFirstPane
	}
	if firstPane.TabID != "" && firstPane.TabID != tab.ID {
		return fmt.Errorf("%w: pane %s names tab %s", ErrMismatchedContainer, firstPane.ID, firstPane.TabID)
	}
	firstPane.TabID = tab.ID
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			if err := admitAndInsertTab(ctx, tx, tab); err != nil {
				return err
			}
			return insertPane(ctx, tx, firstPane)
		})
	})
}

// admitAndInsertTab is the tab's write, lineage admission included. It takes
// the transaction rather than opening one because every caller has one open
// already: the walk's ancestry must be the ancestry the insert lands against.
func admitAndInsertTab(ctx context.Context, tx *sql.Tx, tab Tab) error {
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
	_, err := tx.ExecContext(ctx,
		`INSERT INTO tabs (id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tab.ID, tab.WorkspaceID, tab.ParentID, tab.Name, tab.Colour,
		tab.Position, boolToInt(tab.Pinned), string(tab.Layout), tab.SeenAt)
	return err
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
// And it takes its workspace with it when it was the last tab there, and
// mints the replacement when it was the last tab anywhere — all in the one
// transaction (nocx-isoph.3).
func (s *sqliteContent) DeleteTab(ctx context.Context, id string, next Replacement) error {
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			var workspaceID string
			switch err := tx.QueryRowContext(ctx,
				`SELECT workspace_id FROM tabs WHERE id = ?`, id).Scan(&workspaceID); {
			case errors.Is(err, sql.ErrNoRows):
				// Nothing to remove and therefore nothing to dissolve: a
				// delete of a row that is not there is not a failure, and it
				// must not mint a replacement either.
				return nil
			case err != nil:
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM tabs WHERE id = ?`, id); err != nil {
				return err
			}
			if err := dissolveWorkspaceIfEmpty(ctx, tx, workspaceID); err != nil {
				return err
			}
			return mintReplacementIfEmpty(ctx, tx, next)
		})
	})
}

// ── panes ────────────────────────────────────────────────────────────────

// CreatePane adds a pane to a tab that already exists — the split. A tab's
// FIRST pane arrives with the tab, through CreateTab, because a tab with no
// pane may not exist even for the length of one statement.
func (s *sqliteContent) CreatePane(ctx context.Context, pane Pane) error {
	return s.run(ctx, func(ctx context.Context) error {
		return insertPane(ctx, s.db, pane)
	})
}

func insertPane(ctx context.Context, db execer, pane Pane) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO panes (id, tab_id, cwd, kind, endpoint, size_share)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		pane.ID, pane.TabID, pane.Cwd, string(pane.Kind), pane.Endpoint, pane.SizeShare)
	return err
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

// DeletePane removes the pane and then unwinds as far up the chain as the
// removal empties: the tab it was the last pane of, the workspace that tab
// was the last tab of, and the replacement if that was the application's last
// tab. All of it in one transaction — a store that used two would leave a tab
// with no panes visible in between, which is the state §4.1 says cannot
// happen.
func (s *sqliteContent) DeletePane(ctx context.Context, id string, next Replacement) error {
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			var tabID string
			switch err := tx.QueryRowContext(ctx,
				`SELECT tab_id FROM panes WHERE id = ?`, id).Scan(&tabID); {
			case errors.Is(err, sql.ErrNoRows):
				return nil
			case err != nil:
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM panes WHERE id = ?`, id); err != nil {
				return err
			}
			if err := dissolveTabIfEmpty(ctx, tx, tabID); err != nil {
				return err
			}
			return mintReplacementIfEmpty(ctx, tx, next)
		})
	})
}

// MovePane is §4.4 in one statement: the pane's tab_id changes, and the tab
// it left with no panes is removed in the same transaction. Nothing else
// about the pane is written, so its identity, its cwd, its blocks and its
// live pipe are untouched — only a reference moved. That round trip being
// lossless is the whole reason the durable object is the pane and the tab is
// the cheap wrapper (nocx-ehkvy).
func (s *sqliteContent) MovePane(ctx context.Context, paneID, tabID string) error {
	return s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			var from string
			switch err := tx.QueryRowContext(ctx,
				`SELECT tab_id FROM panes WHERE id = ?`, paneID).Scan(&from); {
			case errors.Is(err, sql.ErrNoRows):
				return fmt.Errorf("%w: %s", ErrNoSuchPane, paneID)
			case err != nil:
				return err
			}
			if from == tabID {
				// Already there. Not a dissolution: the source tab is the
				// destination tab and it is not empty.
				return nil
			}
			source, err := tabWorkspace(ctx, tx, from)
			if err != nil {
				return err
			}
			destination, err := tabWorkspace(ctx, tx, tabID)
			if err != nil {
				return err
			}
			if source != destination {
				return fmt.Errorf("%w: %s → %s", ErrCrossWorkspaceMove, source, destination)
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE panes SET tab_id = ? WHERE id = ?`, tabID, paneID); err != nil {
				return err
			}
			// The workspace cannot empty here — the destination tab is in it
			// — but the same rung is asked anyway, because the rule belongs
			// to one implementation and not to whoever remembers to call it.
			return dissolveTabIfEmpty(ctx, tx, from)
		})
	})
}

func tabWorkspace(ctx context.Context, tx *sql.Tx, tabID string) (string, error) {
	var workspaceID string
	switch err := tx.QueryRowContext(ctx,
		`SELECT workspace_id FROM tabs WHERE id = ?`, tabID).Scan(&workspaceID); {
	case errors.Is(err, sql.ErrNoRows):
		return "", fmt.Errorf("%w: %s", ErrNoSuchTab, tabID)
	case err != nil:
		return "", err
	}
	return workspaceID, nil
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
