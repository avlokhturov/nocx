package content

// The SQLite implementation of LayoutRepository (nocx-isoph.1, extended with
// the mutations by nocx-isoph.2). Every mutation goes through the single
// writer goroutine (run, in sqlite.go — design §5.3); every read goes through
// the pool directly.
//
// The methods hang off *sqliteContent and are returned as the seam by
// Layout(); there is no wrapper type because, unlike the ledger, nothing here
// collides with a command_history method name.
//
// THE IDEMPOTENCY OF A CREATE (§7). Every id in this chain is minted by the
// frontend and is therefore UNTRUSTED, so a create has exactly three answers:
// the id is free and a row is written; the id is taken by the SAME request
// and the row already there is returned (Replayed); the id is taken by a
// DIFFERENT request and it is ErrIDConflict, with nothing changed. The second
// answer is what AD-9 buys — the socket drops, the answer to a create is
// lost, the renderer asks again, and without this that retry is a second
// workspace.
//
// The mechanism is the ledger's, and the deviation from it is deliberate and
// is here rather than in a commit message. `entries` binds its untrusted id
// to TWO things, entries.client and entries.digest — "who sent it and what
// they asked". These rows keep the second and drop the first, because:
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
// What the digest gives is the whole of the property that matters: one id
// never stands for two different objects.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/shady2k/nocx/internal/lineage"
)

var _ LayoutRepository = (*sqliteContent)(nil)

// ErrNoSuchTab is returned when a tab id names no tab: a lineage parent, the
// destination of a pane move, or the tab a decoration addresses. It is the
// STORE's own statement — internal/lineage refuses shapes and deliberately
// knows nothing about nodes — and it is reported before the write rather than
// left to the foreign key, because the caller needs to know WHICH row was
// missing and a driver's constraint text does not say.
var ErrNoSuchTab = errors.New("content: no such tab")

// ErrNoSuchWorkspace is the same statement one level up.
var ErrNoSuchWorkspace = errors.New("content: no such workspace")

// ErrNoSuchPane is the same statement one level down.
var ErrNoSuchPane = errors.New("content: no such pane")

// ErrNotAPermutation is returned when a reorder does not name exactly the
// members of the container it reorders, once each. A reorder takes the WHOLE
// order on purpose: a partial list would need a second rule for where
// everything else goes, and two rules for one order disagree eventually.
var ErrNotAPermutation = errors.New("content: reorder is not a permutation of the container's members")

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

func workspaceDigest(ws Workspace) string {
	return createDigest("workspace", ws.Name, ws.Position)
}

func tabDigest(t Tab) string {
	return createDigest("tab", t.WorkspaceID, t.ParentID, t.Name, t.Colour,
		t.Position, t.Pinned, string(t.Layout), t.SeenAt)
}

func paneDigest(p Pane) string {
	return createDigest("pane", p.TabID, p.Cwd, string(p.Kind), p.Endpoint, p.SizeShare)
}

// ── workspaces ───────────────────────────────────────────────────────────

func (s *sqliteContent) CreateWorkspace(ctx context.Context, ws Workspace) (Created[Workspace], error) {
	var out Created[Workspace]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			digest := workspaceDigest(ws)
			switch existing, err := workspaceByID(ctx, tx, ws.ID); {
			case err == nil:
				// A row is already there. The default workspace lands here
				// too: it is minted by the backend with no digest, so a
				// create naming it can never be a replay — which is right,
				// because the default never renders and the renderer has no
				// name for it to ask with.
				if existing.digest != digest {
					return ErrIDConflict
				}
				out = Created[Workspace]{Object: existing.Workspace, Replayed: true}
				return nil
			case !errors.Is(err, ErrNoSuchWorkspace):
				return err
			}
			// A plain INSERT, never an upsert: a second use of an id FAILS
			// rather than overwriting the workspace somebody is working in.
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO workspaces (id, name, position, created_at, digest) VALUES (?, ?, ?, ?, ?)`,
				ws.ID, ws.Name, ws.Position, time.Now().UnixMilli(), digest); err != nil {
				return err
			}
			out = Created[Workspace]{Object: ws}
			return nil
		})
	})
	if err != nil {
		return Created[Workspace]{}, err
	}
	return out, nil
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

func (s *sqliteContent) RenameWorkspace(ctx context.Context, id, name string) (Workspace, error) {
	var out Workspace
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, `UPDATE workspaces SET name = ? WHERE id = ?`, name, id)
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

// ReorderWorkspaces writes positions 0..n-1 from the order it is given, in
// ONE transaction: the membership it checked must be the membership it writes
// against, or a concurrent create lands a workspace with no position while
// the caller believes it wrote the whole order.
func (s *sqliteContent) ReorderWorkspaces(ctx context.Context, ids []string) ([]Workspace, error) {
	var out []Workspace
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			members, err := idsOf(ctx, tx, `SELECT id FROM workspaces`)
			if err != nil {
				return err
			}
			if !isPermutation(ids, members) {
				return ErrNotAPermutation
			}
			for position, id := range ids {
				if _, err := tx.ExecContext(ctx,
					`UPDATE workspaces SET position = ? WHERE id = ?`, position, id); err != nil {
					return err
				}
			}
			out = make([]Workspace, 0, len(ids))
			for _, id := range ids {
				stored, err := workspaceByID(ctx, tx, id)
				if err != nil {
					return err
				}
				out = append(out, stored.Workspace)
			}
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
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

// workspaceRow is a workspace plus the digest its create was bound to. The
// digest never leaves this package: it is the store's own binding of an
// untrusted id, and a value the client could read is a value the client could
// send back.
type workspaceRow struct {
	Workspace
	digest string
}

func workspaceByID(ctx context.Context, q rowQuerier, id string) (workspaceRow, error) {
	var row workspaceRow
	err := q.QueryRowContext(ctx,
		`SELECT id, name, position, digest FROM workspaces WHERE id = ?`, id,
	).Scan(&row.ID, &row.Name, &row.Position, &row.digest)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceRow{}, fmt.Errorf("%w: %s", ErrNoSuchWorkspace, id)
	}
	return row, err
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
func (s *sqliteContent) CreateTab(ctx context.Context, tab Tab) (Created[Tab], error) {
	var out Created[Tab]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			digest := tabDigest(tab)
			switch existing, err := tabByID(ctx, tx, tab.ID); {
			case err == nil:
				if existing.digest != digest {
					return ErrIDConflict
				}
				out = Created[Tab]{Object: existing.Tab, Replayed: true}
				return nil
			case !errors.Is(err, ErrNoSuchTab):
				return err
			}
			if _, err := workspaceByID(ctx, tx, tab.WorkspaceID); err != nil {
				return err
			}
			if tab.ParentID != nil {
				if err := lineage.Validate(*tab.ParentID,
					func(at string) bool { return at == tab.ID },
					func(at string) (string, bool, error) {
						parent, err := tabByID(ctx, tx, at)
						if err != nil {
							return "", false, err
						}
						if parent.ParentID == nil {
							return "", false, nil
						}
						return *parent.ParentID, true, nil
					}); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO tabs (id, workspace_id, parent_id, name, colour, position, pinned, layout, seen_at, digest)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				tab.ID, tab.WorkspaceID, tab.ParentID, tab.Name, tab.Colour,
				tab.Position, boolToInt(tab.Pinned), string(tab.Layout), tab.SeenAt, digest); err != nil {
				return err
			}
			out = Created[Tab]{Object: tab}
			return nil
		})
	})
	if err != nil {
		return Created[Tab]{}, err
	}
	return out, nil
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

// RenameTab, RecolourTab and PinTab are three methods over one statement
// shape rather than one `UpdateTab` taking a sparse patch. The sparse patch
// is what makes "what changed" unanswerable — nil then means both "leave it"
// and "clear it", and clearing is a real operation here: a tab whose name is
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

// ── panes ────────────────────────────────────────────────────────────────

func (s *sqliteContent) CreatePane(ctx context.Context, pane Pane) (Created[Pane], error) {
	var out Created[Pane]
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			digest := paneDigest(pane)
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
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO panes (id, tab_id, cwd, kind, endpoint, size_share, digest)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				pane.ID, pane.TabID, pane.Cwd, string(pane.Kind), pane.Endpoint,
				pane.SizeShare, digest); err != nil {
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

// MovePane changes ONE column, and that is the whole of §4.4's promise: the
// pane's identity, its cwd, its blocks and its live pipe are untouched
// because only a reference moved. Both ends are resolved first so the caller
// learns which one was missing — and so a move into a tab that does not exist
// leaves the pane where it was rather than in neither place.
func (s *sqliteContent) MovePane(ctx context.Context, id, tabID string) (Pane, error) {
	var out Pane
	err := s.run(ctx, func(ctx context.Context) error {
		return s.inTx(ctx, func(tx *sql.Tx) error {
			if _, err := paneByID(ctx, tx, id); err != nil {
				return err
			}
			if _, err := tabByID(ctx, tx, tabID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE panes SET tab_id = ? WHERE id = ?`, tabID, id); err != nil {
				return err
			}
			moved, err := paneByID(ctx, tx, id)
			if err != nil {
				return err
			}
			out = moved.Pane
			return nil
		})
	})
	if err != nil {
		return Pane{}, err
	}
	return out, nil
}

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

func (s *sqliteContent) DeletePane(ctx context.Context, id string) error {
	return s.run(ctx, func(ctx context.Context) error {
		_, err := s.db.ExecContext(ctx, `DELETE FROM panes WHERE id = ?`, id)
		return err
	})
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

// ── helpers ──────────────────────────────────────────────────────────────

// inTx runs fn in one serializable transaction and commits it, rolling back
// on any error. BEGIN IMMEDIATE (the ncruces driver maps LevelSerializable to
// it) takes the write lock at BEGIN rather than at the first write: with a
// deferred BEGIN two processes can read the same snapshot and the loser's
// upgrade fails with SQLITE_BUSY_SNAPSHOT, which busy_timeout does not repair
// (nocx-rtg0.18). Every create here reads before it writes, so this is
// exactly that shape.
func (s *sqliteContent) inTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
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
// Duplicates are caught by the count check plus set equality: a list holding
// one id twice cannot cover a set of the same size.
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
