package content

// The SQLite implementation of LayoutRepository (nocx-isoph.1). Every
// mutation goes through the single writer goroutine (run, in sqlite.go —
// design §5.3); every read goes through the pool directly.
//
// The methods hang off *sqliteContent and are returned as the seam by
// Layout(); there is no wrapper type because, unlike the ledger, nothing here
// collides with a command_history method name.
//
// THE IDEMPOTENCY OF A CREATE (nocx-isoph.2, §7). Every id in this chain is
// minted by the frontend and is therefore UNTRUSTED, so a create has exactly
// three answers: the id is free and the rows are written; the id is taken by
// the SAME request and what is already there is returned (Replayed); the id
// is taken by a DIFFERENT request and it is ErrIDConflict, with nothing
// changed. The second answer is what AD-9 buys — the socket drops, the answer
// to a create is lost, the renderer asks again, and without this that retry
// is a second workspace.
//
// The mechanism is the ledger's, and the deviation from it is deliberate.
// `entries` binds its untrusted id to TWO things, entries.client and
// entries.digest — "who sent it and what they asked". These rows keep the
// second and drop the first, because:
//
//   - the retry the key exists for arrives on a NEW CONNECTION. That is what
//     "the socket dropped" means, and a connection-scoped client would turn
//     exactly the case §7 names into a conflict;
//   - a layout row is application-wide, not connection-scoped. A workspace
//     created on one connection is renamed on the next, so "who sent it" is
//     not a property of the object at all;
//   - and it would confer nothing anyway. §7 is explicit that knowing an id
//     is evidence of nothing — a UUIDv7 embeds a timestamp and is guessable
//     by construction — so a client binding here would read as an
//     authorization check while being none.
//
// The digest covers the WHOLE request, content included: a creation with
// content has no answer that names only its container, so it has no key that
// binds only one either.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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
	// ErrNoSuchWorkspace: a decoration or a reorder naming a workspace no row
	// carries. The store's own statement, reported before the write.
	ErrNoSuchWorkspace = errors.New("content: no such workspace")
	// ErrNotAPermutation: a reorder that does not name exactly the members of
	// the container it reorders, once each. A reorder takes the WHOLE order
	// on purpose — a partial list would need a second rule for where
	// everything else goes, and two rules for one order disagree eventually.
	ErrNotAPermutation = errors.New("content: reorder is not a permutation of the container's members")
)

// ── the create key ───────────────────────────────────────────────────────

// createDigest binds an untrusted id to what was asked for. The store derives
// it from the request (the client never sends it — that would be forgeable),
// so a replay of one id cannot alias a different object. The field order is
// fixed, so the hash is deterministic.
func createDigest(kind string, fields ...any) string {
	h := sha256.New()
	enc := json.NewEncoder(h)
	_ = enc.Encode(append([]any{kind}, fields...))
	return hex.EncodeToString(h.Sum(nil))
}

func workspaceFields(ws Workspace) []any { return []any{ws.ID, ws.Name, ws.Colour, ws.Position} }

func tabFields(t Tab) []any {
	return []any{
		t.ID, t.WorkspaceID, t.ParentID, t.Name, t.Colour,
		t.Position, t.Pinned, string(t.Layout), t.SeenAt,
	}
}

func paneFields(p Pane) []any {
	return []any{p.ID, p.TabID, p.Cwd, string(p.Kind), p.Endpoint, p.SizeShare}
}

func workspaceDigest(ws Workspace, firstTab Tab, firstPane Pane) string {
	return createDigest("workspace", workspaceFields(ws), tabFields(firstTab), paneFields(firstPane))
}

func tabDigest(t Tab, firstPane Pane) string {
	return createDigest("tab", tabFields(t), paneFields(firstPane))
}

func paneDigest(p Pane) string { return createDigest("pane", paneFields(p)) }

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
func (s *sqliteContent) CreateWorkspace(ctx context.Context, ws Workspace, firstTab Tab, firstPane Pane) (Created[NewWorkspace], error) {
	if strings.TrimSpace(firstTab.ID) == "" {
		return Created[NewWorkspace]{}, ErrNoFirstTab
	}
	if strings.TrimSpace(firstPane.ID) == "" {
		return Created[NewWorkspace]{}, ErrNoFirstPane
	}
	if firstTab.WorkspaceID != "" && firstTab.WorkspaceID != ws.ID {
		return Created[NewWorkspace]{}, fmt.Errorf("%w: tab %s names workspace %s", ErrMismatchedContainer, firstTab.ID, firstTab.WorkspaceID)
	}
	if firstPane.TabID != "" && firstPane.TabID != firstTab.ID {
		return Created[NewWorkspace]{}, fmt.Errorf("%w: pane %s names tab %s", ErrMismatchedContainer, firstPane.ID, firstPane.TabID)
	}
	firstTab.WorkspaceID = ws.ID
	firstPane.TabID = firstTab.ID
	digest := workspaceDigest(ws, firstTab, firstPane)
	var out Created[NewWorkspace]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			// The id is taken: this is a retry of the same ask or an alias of
			// a different one, and the digest is what tells them apart (§7).
			// The DEFAULT workspace lands here too — the backend mints it
			// with no digest, so a create naming it can never be a replay,
			// which is right: it never renders and the renderer has no name
			// to ask with.
			switch existing, err := workspaceByID(ctx, tx, ws.ID); {
			case err == nil:
				if existing.digest != digest {
					return ErrIDConflict
				}
				made, readErr := storedWorkspace(ctx, tx, existing.Workspace, firstTab.ID, firstPane.ID)
				if readErr != nil {
					return readErr
				}
				out = Created[NewWorkspace]{Object: made, Replayed: true}
				return nil
			case !errors.Is(err, ErrNoSuchWorkspace):
				return err
			}
			if err := insertWorkspace(ctx, tx, ws, digest); err != nil {
				return err
			}
			if err := admitAndInsertTab(ctx, tx, firstTab, ""); err != nil {
				return err
			}
			if err := insertPane(ctx, tx, firstPane, ""); err != nil {
				return err
			}
			out = Created[NewWorkspace]{Object: NewWorkspace{Workspace: ws, FirstTab: firstTab, FirstPane: firstPane}}
			return nil
		})
	})
	if err != nil {
		return Created[NewWorkspace]{}, err
	}
	return out, nil
}

// storedWorkspace reads back what a replayed creation-with-content made. The
// rows are read rather than reconstructed from the request: a replay must
// answer with what the store HOLDS, which is the whole difference between an
// answer and an echo.
func storedWorkspace(ctx context.Context, q rowQuerier, ws Workspace, tabID, paneID string) (NewWorkspace, error) {
	tab, err := tabByID(ctx, q, tabID)
	if err != nil {
		return NewWorkspace{}, err
	}
	pane, err := paneByID(ctx, q, paneID)
	if err != nil {
		return NewWorkspace{}, err
	}
	return NewWorkspace{Workspace: ws, FirstTab: tab.Tab, FirstPane: pane.Pane}, nil
}

// insertWorkspace is a plain INSERT, never an upsert: the id is client-minted
// and UNTRUSTED (§7), so a second use of one FAILS rather than overwriting
// the workspace somebody else is working in.
func insertWorkspace(ctx context.Context, db execer, ws Workspace, digest string) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO workspaces (id, name, colour, position, created_at, digest) VALUES (?, ?, ?, ?, ?, ?)`,
		ws.ID, ws.Name, ws.Colour, ws.Position, time.Now().UnixMilli(), digest)
	return err
}

// Snapshot answers with the whole chain, by asking the three readers that
// already answer each rung (nocx-isoph.4). It writes no SQL of its own on
// purpose: "how are a workspace's tabs ordered" and "which panes are in this
// tab" are questions with an owner each, and a fourth statement answering
// them again is the second implementation AGENTS.md names — the two agree
// until the day one of them learns about a column.
//
// The cost of that choice is 1 + N + N·M statements against a local file for
// a strip a person can see; the cost of the alternative is a third place that
// has to learn what `ORDER BY position, id` means. Consistency is not bought
// by a transaction here but by WHERE this runs: every layout write goes
// through the content domain's single operation lane, and so does the handler
// that calls this, so nothing can land between the collections.
func (s *sqliteContent) Snapshot(ctx context.Context) (LayoutSnapshot, error) {
	if s.closed.Load() {
		return LayoutSnapshot{}, ErrClosed
	}
	out := LayoutSnapshot{
		DefaultWorkspaceID: DefaultWorkspaceID,
		Workspaces:         []Workspace{},
		Tabs:               []Tab{},
		Panes:              []Pane{},
	}
	workspaces, err := s.Workspaces(ctx)
	if err != nil {
		return LayoutSnapshot{}, err
	}
	out.Workspaces = workspaces
	for _, ws := range workspaces {
		tabs, err := s.Tabs(ctx, ws.ID)
		if err != nil {
			return LayoutSnapshot{}, err
		}
		out.Tabs = append(out.Tabs, tabs...)
		for _, tab := range tabs {
			panes, err := s.Panes(ctx, tab.ID)
			if err != nil {
				return LayoutSnapshot{}, err
			}
			out.Panes = append(out.Panes, panes...)
		}
	}
	return out, nil
}

func (s *sqliteContent) Workspaces(ctx context.Context) ([]Workspace, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	return scanWorkspaces(s.db.QueryContext(ctx,
		`SELECT id, name, colour, position FROM workspaces ORDER BY position, id`))
}

// workspacesInOrder reads the same list INSIDE a transaction, so a caller that
// has just written positions answers from the rows it wrote rather than from a
// second read that another writer could have moved under it.
func workspacesInOrder(ctx context.Context, tx *sql.Tx) ([]Workspace, error) {
	return scanWorkspaces(tx.QueryContext(ctx,
		`SELECT id, name, colour, position FROM workspaces ORDER BY position, id`))
}

// scanWorkspaces owns the row shape once. Taking the query's two results
// rather than a *sql.Rows keeps the error path at the call site, where the
// query is.
func scanWorkspaces(rows *sql.Rows, err error) ([]Workspace, error) {
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Workspace{}
	for rows.Next() {
		var (
			ws     Workspace
			colour sql.NullString
		)
		if err := rows.Scan(&ws.ID, &ws.Name, &colour, &ws.Position); err != nil {
			return nil, err
		}
		if colour.Valid {
			ws.Colour = &colour.String
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
	if err := ensureDefaultWorkspace(ctx, tx); err != nil {
		return err
	}
	if err := admitAndInsertTab(ctx, tx, Tab{
		ID:          next.TabID,
		WorkspaceID: DefaultWorkspaceID,
		Layout:      LayoutRow,
	}, ""); err != nil {
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
	}, "")
}

// ensureDefaultWorkspace writes the default workspace's row if it is not
// there. Nothing creates it eagerly: it is PERMANENT in the sense that it is
// never deleted, not in the sense that it exists before anything needs it,
// and three things need it — the replacement mint above, a tab created in it
// (CreateTab), and the ledger's fallback for a session nobody named a
// workspace for.
//
// OR IGNORE rather than a check-then-insert, and one helper rather than a
// copy per caller: the row is identical whoever writes it, and two writers
// racing to create it must not turn into a failed close. The name is not the
// user's and never renders (workspaces-ux §4.2) — a column has to hold
// something, and 'default' is what the ledger's fallback already writes.
func ensureDefaultWorkspace(ctx context.Context, db execer) error {
	_, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO workspaces (id, name, position, created_at) VALUES (?, 'default', 0, ?)`,
		DefaultWorkspaceID, time.Now().UnixMilli())
	return err
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
func (s *sqliteContent) CreateTab(ctx context.Context, tab Tab, firstPane Pane) (Created[NewTab], error) {
	if strings.TrimSpace(firstPane.ID) == "" {
		return Created[NewTab]{}, ErrNoFirstPane
	}
	if firstPane.TabID != "" && firstPane.TabID != tab.ID {
		return Created[NewTab]{}, fmt.Errorf("%w: pane %s names tab %s", ErrMismatchedContainer, firstPane.ID, firstPane.TabID)
	}
	firstPane.TabID = tab.ID
	digest := tabDigest(tab, firstPane)
	var out Created[NewTab]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			switch existing, err := tabByID(ctx, tx, tab.ID); {
			case err == nil:
				if existing.digest != digest {
					return ErrIDConflict
				}
				pane, readErr := paneByID(ctx, tx, firstPane.ID)
				if readErr != nil {
					return readErr
				}
				out = Created[NewTab]{Object: NewTab{Tab: existing.Tab, FirstPane: pane.Pane}, Replayed: true}
				return nil
			case !errors.Is(err, ErrNoSuchTab):
				return err
			}
			// The DEFAULT workspace is minted on demand, and only it. A
			// renderer's first tab has nowhere else to go — the default never
			// renders, so no surface can offer to create it, and
			// workspaces.create refuses any id that is not a UUIDv7, so the
			// renderer cannot make it either. Every OTHER id is resolved
			// before the write so the caller learns WHICH row was missing:
			// the foreign key would refuse it anyway, and a driver's
			// constraint text does not say.
			if tab.WorkspaceID == DefaultWorkspaceID {
				if err := ensureDefaultWorkspace(ctx, tx); err != nil {
					return err
				}
			} else if _, err := workspaceByID(ctx, tx, tab.WorkspaceID); err != nil {
				return err
			}
			if err := admitAndInsertTab(ctx, tx, tab, digest); err != nil {
				return err
			}
			if err := insertPane(ctx, tx, firstPane, ""); err != nil {
				return err
			}
			out = Created[NewTab]{Object: NewTab{Tab: tab, FirstPane: firstPane}}
			return nil
		})
	})
	if err != nil {
		return Created[NewTab]{}, err
	}
	return out, nil
}

// admitAndInsertTab is the tab's write, lineage admission included. It takes
// the transaction rather than opening one because every caller has one open
// already: the walk's ancestry must be the ancestry the insert lands against.
func admitAndInsertTab(ctx context.Context, tx *sql.Tx, tab Tab, digest string) error {
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
		`INSERT INTO tabs (id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at, digest)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tab.ID, tab.WorkspaceID, tab.ParentID, tab.Name, tab.Colour,
		tab.Position, boolToInt(tab.Pinned), string(tab.Layout), tab.SeenAt, digest)
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
func (s *sqliteContent) CreatePane(ctx context.Context, pane Pane) (Created[Pane], error) {
	digest := paneDigest(pane)
	var out Created[Pane]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			switch existing, err := paneByID(ctx, tx, pane.ID); {
			case err == nil:
				if existing.digest != digest {
					return ErrIDConflict
				}
				out = Created[Pane]{Object: existing.Pane, Replayed: true}
				return nil
			case !errors.Is(err, ErrNoSuchPane):
				return err
			}
			if _, err := tabByID(ctx, tx, pane.TabID); err != nil {
				return err
			}
			if err := insertPane(ctx, tx, pane, digest); err != nil {
				return err
			}
			out = Created[Pane]{Object: pane}
			return nil
		})
	})
	if err != nil {
		return Created[Pane]{}, err
	}
	return out, nil
}

func insertPane(ctx context.Context, db execer, pane Pane, digest string) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO panes (id, tab_id, cwd, kind, endpoint, size_share, digest)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		pane.ID, pane.TabID, pane.Cwd, string(pane.Kind), pane.Endpoint, pane.SizeShare, digest)
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
// SetPaneCwd records where the pane's shell is (nocx-zkiv4, design §5). One
// UPDATE and a read-back through paneByID, which is the same reader every
// other pane method answers from — a second SELECT here would be a second
// shape of the same row.
func (s *sqliteContent) SetPaneCwd(ctx context.Context, paneID, cwd string) (Pane, error) {
	var out Pane
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx,
				`UPDATE panes SET cwd = ? WHERE id = ?`, cwd, paneID)
			if err != nil {
				return err
			}
			// RowsAffected is 0 for a pane that is not there AND for one
			// already at this cwd, so it cannot be the existence check: the
			// read below is, and it is the answer either way.
			_ = res
			stored, err := paneByID(ctx, tx, paneID)
			if err != nil {
				return err
			}
			out = stored.Pane
			return nil
		})
	})
	return out, err
}

func (s *sqliteContent) MovePane(ctx context.Context, paneID, tabID string) (Pane, error) {
	var out Pane
	err := s.run(ctx, func(ctx context.Context) error {
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
				// destination tab and it is not empty. It is also the shape a
				// RETRY of a move takes, and it answers with the same pane
				// the first call did rather than an error.
				stayed, err := paneByID(ctx, tx, paneID)
				if err != nil {
					return err
				}
				out = stayed.Pane
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
			if _, execErr := tx.ExecContext(ctx,
				`UPDATE panes SET tab_id = ? WHERE id = ?`, tabID, paneID); execErr != nil {
				return execErr
			}
			moved, err := paneByID(ctx, tx, paneID)
			if err != nil {
				return err
			}
			out = moved.Pane
			// The workspace cannot empty here — the destination tab is in it
			// — but the same rung is asked anyway, because the rule belongs
			// to one implementation and not to whoever remembers to call it.
			return dissolveTabIfEmpty(ctx, tx, from)
		})
	})
	if err != nil {
		return Pane{}, err
	}
	return out, nil
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

// ── decoration and order (nocx-isoph.2) ──────────────────────────────────

func (s *sqliteContent) RenameWorkspace(ctx context.Context, id, name string) (Workspace, error) {
	return s.setWorkspaceColumn(ctx, id, `UPDATE workspaces SET name = ? WHERE id = ?`, name)
}

// RecolourWorkspace writes the colour the user chose, and nil clears it.
//
// NIL IS AN OPERATION, NOT AN OMISSION — the same distinction RecolourTab
// draws, and for the same reason: "make this workspace undecorated" is
// something a person can ask for, and a signature that could not say it would
// make the ask unrepresentable. It is why this takes a *string rather than a
// string with "" standing in for absent.
func (s *sqliteContent) RecolourWorkspace(ctx context.Context, id string, colour *string) (Workspace, error) {
	return s.setWorkspaceColumn(ctx, id, `UPDATE workspaces SET colour = ? WHERE id = ?`, colour)
}

// setWorkspaceColumn writes one column and reads the row back inside the same
// transaction: what the caller is answered with is what the store holds, not
// what the caller asked for.
//
// The workspace's DIGEST is deliberately not recomputed, exactly as
// setTabColumn's is not. It binds the untrusted id to the CREATE; a rename or
// a recolour is a second event on a row that already exists, and recomputing
// it here would turn a later retry of the original create into ErrIDConflict.
func (s *sqliteContent) setWorkspaceColumn(ctx context.Context, id, stmt string, value any) (Workspace, error) {
	var out Workspace
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, stmt, value, id)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if n == 0 {
				return fmt.Errorf("%w: %s", ErrNoSuchWorkspace, id)
			}
			stored, err := workspaceByID(ctx, tx, id)
			if err != nil {
				return err
			}
			out = stored.Workspace
			return nil
		})
	})
	if err != nil {
		return Workspace{}, err
	}
	return out, nil
}

// ReorderWorkspaces writes the user-made order, in ONE transaction: the
// membership it checked must be the membership it writes against, or a
// concurrent create lands a workspace with no position while the caller
// believes it wrote the whole order.
//
// THE DEFAULT IS EXCLUDED FROM THE PERMUTATION AND KEPT AT POSITION 0 — see
// the interface doc for why requiring it made this method impossible to call.
// The user's workspaces are written at 1..n, so the default stays where §4.2
// puts it whatever order arrives.
func (s *sqliteContent) ReorderWorkspaces(ctx context.Context, ids []string) ([]Workspace, error) {
	var out []Workspace
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			members, err := idsOf(ctx, tx,
				`SELECT id FROM workspaces WHERE id != ?`, DefaultWorkspaceID)
			if err != nil {
				return err
			}
			if !isPermutation(ids, members) {
				return ErrNotAPermutation
			}
			if _, err = tx.ExecContext(ctx,
				`UPDATE workspaces SET position = 0 WHERE id = ?`, DefaultWorkspaceID); err != nil {
				return err
			}
			for position, id := range ids {
				if _, err = tx.ExecContext(ctx,
					`UPDATE workspaces SET position = ? WHERE id = ?`, position+1, id); err != nil {
					return err
				}
			}
			// EVERY workspace comes back, not just the ones that moved: the
			// renderer replaces its cache with this answer, and a list with
			// the default missing would delete the row every ungrouped tab
			// belongs to.
			out, err = workspacesInOrder(ctx, tx)
			return err
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RenameTab, RecolourTab and PinTab are three methods over one statement
// shape rather than one UpdateTab taking a sparse patch. The sparse patch is
// what makes "what changed" unanswerable — nil then means both "leave it" and
// "clear it", and clearing is a real operation here: a tab whose name is
// removed goes back to the label derived from its panes (§4.5).
func (s *sqliteContent) RenameTab(ctx context.Context, id string, name *string) (Tab, error) {
	return s.setTabColumn(ctx, id, `UPDATE tabs SET name = ? WHERE id = ?`, name)
}

func (s *sqliteContent) RecolourTab(ctx context.Context, id string, colour *string) (Tab, error) {
	return s.setTabColumn(ctx, id, `UPDATE tabs SET colour = ? WHERE id = ?`, colour)
}

func (s *sqliteContent) PinTab(ctx context.Context, id string, pinned bool) (Tab, error) {
	return s.setTabColumn(ctx, id, `UPDATE tabs SET pinned = ? WHERE id = ?`, boolToInt(pinned))
}

// setTabColumn writes one column and reads the row back inside the same
// transaction: what the caller is answered with is what the store holds, not
// what the caller asked for.
//
// The tab's DIGEST is deliberately not recomputed. It binds the untrusted id
// to the CREATE, and a decoration is a second event on a row that already
// exists — recomputing it here would turn a later retry of the original
// create into ErrIDConflict, which is the same trap ledger_sqlite.go's close
// path names.
func (s *sqliteContent) setTabColumn(ctx context.Context, id, stmt string, value any) (Tab, error) {
	var out Tab
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, stmt, value, id)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if n == 0 {
				return fmt.Errorf("%w: %s", ErrNoSuchTab, id)
			}
			stored, err := tabByID(ctx, tx, id)
			if err != nil {
				return err
			}
			out = stored.Tab
			return nil
		})
	})
	if err != nil {
		return Tab{}, err
	}
	return out, nil
}

func (s *sqliteContent) ReorderTabs(ctx context.Context, workspaceID string, ids []string) ([]Tab, error) {
	var out []Tab
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			if _, err := workspaceByID(ctx, tx, workspaceID); err != nil {
				return err
			}
			members, err := idsOf(ctx, tx, `SELECT id FROM tabs WHERE workspace_id = ?`, workspaceID)
			if err != nil {
				return err
			}
			if !isPermutation(ids, members) {
				return ErrNotAPermutation
			}
			for position, id := range ids {
				if _, err := tx.ExecContext(ctx,
					`UPDATE tabs SET position = ? WHERE id = ?`, position, id); err != nil {
					return err
				}
			}
			out = make([]Tab, 0, len(ids))
			for _, id := range ids {
				stored, err := tabByID(ctx, tx, id)
				if err != nil {
					return err
				}
				out = append(out, stored.Tab)
			}
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// WorkspaceForPane is the derivation §4.5 moved off the session: one join,
// walked on every ask, so the answer follows a pane that is dragged into
// another tab instead of going stale in a copy.
func (s *sqliteContent) WorkspaceForPane(ctx context.Context, paneID string) (string, error) {
	if s.closed.Load() {
		return "", ErrClosed
	}
	var workspaceID string
	err := s.db.QueryRowContext(ctx,
		`SELECT t.workspace_id FROM panes p JOIN tabs t ON t.id = p.tab_id WHERE p.id = ?`,
		paneID,
	).Scan(&workspaceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("%w: %s", ErrNoSuchPane, paneID)
	}
	return workspaceID, err
}

// ── row readers ──────────────────────────────────────────────────────────
//
// Each returns the row PLUS the digest its create was bound to. The digest
// never leaves this package: it is the store's own binding of an untrusted
// id, and a value the client could read is a value the client could send
// back.

type workspaceRow struct {
	Workspace
	digest string
}

func workspaceByID(ctx context.Context, q rowQuerier, id string) (workspaceRow, error) {
	var (
		row    workspaceRow
		colour sql.NullString
	)
	err := q.QueryRowContext(ctx,
		`SELECT id, name, colour, position, digest FROM workspaces WHERE id = ?`, id,
	).Scan(&row.ID, &row.Name, &colour, &row.Position, &row.digest)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceRow{}, fmt.Errorf("%w: %s", ErrNoSuchWorkspace, id)
	}
	if colour.Valid {
		row.Colour = &colour.String
	}
	return row, err
}

type tabRow struct {
	Tab
	digest string
}

func tabByID(ctx context.Context, q rowQuerier, id string) (tabRow, error) {
	var (
		row    tabRow
		parent sql.NullString
		name   sql.NullString
		colour sql.NullString
		pinned int
		layout string
		seenAt sql.NullInt64
	)
	err := q.QueryRowContext(ctx,
		`SELECT id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at, digest
		   FROM tabs WHERE id = ?`, id,
	).Scan(&row.ID, &row.WorkspaceID, &parent, &name, &colour, &row.Position,
		&pinned, &layout, &seenAt, &row.digest)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return tabRow{}, fmt.Errorf("%w: %s", ErrNoSuchTab, id)
	case err != nil:
		return tabRow{}, err
	}
	row.ParentID = nullableString(parent)
	row.Name = nullableString(name)
	row.Colour = nullableString(colour)
	row.Pinned = pinned != 0
	row.Layout = TabLayout(layout)
	if seenAt.Valid {
		v := seenAt.Int64
		row.SeenAt = &v
	}
	return row, nil
}

type paneRow struct {
	Pane
	digest string
}

func paneByID(ctx context.Context, q rowQuerier, id string) (paneRow, error) {
	var (
		row      paneRow
		kind     string
		endpoint sql.NullString
	)
	err := q.QueryRowContext(ctx,
		`SELECT id, tab_id, cwd, kind, endpoint, size_share, digest FROM panes WHERE id = ?`, id,
	).Scan(&row.ID, &row.TabID, &row.Cwd, &kind, &endpoint, &row.SizeShare, &row.digest)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return paneRow{}, fmt.Errorf("%w: %s", ErrNoSuchPane, id)
	case err != nil:
		return paneRow{}, err
	}
	row.Kind = PaneKind(kind)
	row.Endpoint = nullableString(endpoint)
	return row, nil
}

// idsOf reads one column of ids — the membership a reorder is checked
// against.
func idsOf(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// isPermutation reports whether want names every member of have, once each.
// A duplicate is caught by the count plus set membership: a list holding one
// id twice cannot cover a set of the same size.
func isPermutation(want, have []string) bool {
	if len(want) != len(have) {
		return false
	}
	members := make(map[string]struct{}, len(have))
	for _, id := range have {
		members[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(want))
	for _, id := range want {
		if _, ok := members[id]; !ok {
			return false
		}
		if _, dup := seen[id]; dup {
			return false
		}
		seen[id] = struct{}{}
	}
	return true
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
