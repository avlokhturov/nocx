package content

// The SQLite backing for ContentDB (nocx-rtg0.1), built on
// github.com/ncruces/go-sqlite3 v0.35.2 with the adiantum encryption VFS
// (ADR-0018, amended 2026-08-01).
//
// Posture, each from the design or the ADR:
//
//   - One content.db, WAL, foreign_keys=ON, auto_vacuum=INCREMENTAL decided
//     at creation (nocx-rtg0.11: it cannot be changed afterwards without a
//     full vacuum), 0600 file inside a 0700 directory, excluded from any
//     diagnostic bundle.
//   - One writer goroutine with short transactions (§5.3): every mutation
//     goes through a single serialized channel; no handler opens its own
//     write transaction. Concurrent readers are served by the pool directly.
//   - The key is a parameter (ADR-0018 §3, nocx-rtg0.9): the keychain is
//     never called from this package. The key must be 32 bytes.
//   - Every file-creating path goes through the keyed VFS (the canary rule):
//     omitting vfs=adiantum and the key silently defeats encryption — the
//     SQLite backup API, ATTACH and VACUUM INTO write through whatever VFS
//     the destination URI selects.

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum"

	"github.com/shady2k/nocx/internal/log"
)

// Config is the construction parameter set for the SQLite backing.
type Config struct {
	// Path is the content.db file path. Its parent directory is created
	// with 0700 if missing.
	Path string
	// Key is the 32-byte ContentDB key (ADR-0018 §3). A parameter, never
	// fetched here.
	Key []byte
	// Budget is the two-number storage budget (nocx-rtg0.11); a zero budget
	// is refused at Open.
	Budget Budget
	// Policy is the live History policy (keep/enable, retention, output).
	// When nil, the default policy applies (history kept, no age limit).
	Policy *Policy
	// Logger receives operational logging. When nil, the default slog
	// adapter is used.
	Logger log.Logger
}

const (
	// maxOpenConns bounds the pool: one connection serves the writer, the
	// rest serve concurrent readers. WAL lets readers run alongside the
	// single writer without blocking.
	maxOpenConns = 16
	// busyTimeoutMs is the lock-wait budget for cross-process writers
	// (multi-process safety, ADR-0018 amendment).
	busyTimeoutMs = 5000
)

// sqliteContent implements ContentDB.
type sqliteContent struct {
	log log.Logger
	cfg Config

	db     *sql.DB
	keyHex string
	path   string
	policy *Policy
	// sweep removes rows older than cutoff (age retention). A field so the
	// failure path is testable: the default runs the DELETE; tests inject a
	// failing one to prove Add stays nil (the sweep is best-effort by
	// design — the INSERT is already durable, so a sweep failure must not
	// make Add fail or a retry would duplicate the command).
	sweep func(ctx context.Context, cutoff int64) error

	// writeCh serializes every mutation (design §5.3: one writer goroutine,
	// short transactions). It is NEVER closed: Close signals via stop, so a
	// racing Add can select on stop instead of sending into a closed channel.
	writeCh chan writeReq
	stop    chan struct{}
	closed  atomic.Bool
	closeMu sync.Once
	wg      sync.WaitGroup
}

// writeOp is one kind of mutation on the serialized write path.
type writeOp int

const (
	opAdd writeOp = iota
	opRewrite
	opRestore
)

// writeReq is one mutation on the serialized write path. The writer answers
// on done with the outcome: the assigned row id (opAdd) and any error.
type writeReq struct {
	ctx     context.Context
	op      writeOp
	record  CommandRecord  // opAdd
	rew     rewriteRequest // opRewrite
	restore restoreRequest // opRestore
	done    chan writeOutcome
}

// rewriteRequest is the opRewrite payload: address the row by its stable
// id, replace the redaction segment at span with reference, drop the
// segment from the row's redactions.
type rewriteRequest struct {
	id        int64
	span      Redaction
	reference string
}

// restoreRequest is the opRestore payload: one private-content block to
// apply atomically.
type restoreRequest struct {
	conversations []Conversation
	history       []CommandRecord
}

// writeOutcome is the writer's answer to one writeReq.
type writeOutcome struct {
	id  int64
	err error
}

var _ ContentDB = (*sqliteContent)(nil)

// Open creates or opens the encrypted ContentDB at cfg.Path. A wrong key
// fails here, cleanly, before the store is handed out: the first real
// statement touches page 1 and SQLite answers "file is not a database".
func Open(ctx context.Context, cfg Config) (ContentDB, error) {
	if err := cfg.Budget.Validate(); err != nil {
		return nil, err
	}
	if len(cfg.Key) != 32 {
		return nil, fmt.Errorf("content: key must be 32 bytes, got %d", len(cfg.Key))
	}
	if cfg.Path == "" {
		return nil, errors.New("content: empty path")
	}
	if cfg.Logger == nil {
		cfg.Logger = log.NewSlogAdapter(nil)
	}
	if cfg.Policy == nil {
		cfg.Policy = NewPolicy()
	}

	dir := filepath.Dir(cfg.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("content: create %s: %w", dir, err)
	}
	// 0700 on the directory, always — not just at creation. G302's "0600 or
	// less" is for files; a database directory must be traversable.
	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // directory, not file
		return nil, fmt.Errorf("content: chmod %s: %w", dir, err)
	}

	keyHex := hex.EncodeToString(cfg.Key)
	db, err := driver.Open("file:"+cfg.Path+"?vfs=adiantum", func(c *sqlite3.Conn) error {
		// Key first: every pragma below and every statement must come after
		// the codec key is installed (canary rule, ADR-0018 amendment).
		if err := c.Exec("PRAGMA hexkey='" + keyHex + "'"); err != nil {
			return fmt.Errorf("content: key: %w", err)
		}
		if err := c.Exec(fmt.Sprintf("PRAGMA busy_timeout=%d", busyTimeoutMs)); err != nil {
			return err
		}
		if err := c.Exec("PRAGMA foreign_keys=ON"); err != nil {
			return err
		}
		if err := c.Exec("PRAGMA temp_store=memory"); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("content: open %s: %w", cfg.Path, err)
	}
	db.SetMaxOpenConns(maxOpenConns)
	db.SetMaxIdleConns(maxOpenConns)

	// Creation-time pragmas and schema run on one connection, in order, so
	// auto_vacuum is decided before the first table exists (nocx-rtg0.11: it
	// cannot be changed afterwards without a full vacuum).
	createConn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	creationErr := func() error {
		if _, err := createConn.ExecContext(ctx, "PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
			return fmt.Errorf("content: auto_vacuum: %w", err)
		}
		if _, err := createConn.ExecContext(ctx, "PRAGMA journal_mode=WAL"); err != nil {
			return fmt.Errorf("content: journal_mode: %w", err)
		}
		// The wrong-key probe: the first page access refuses a key that does
		// not fit the file. This is what makes Open fail cleanly instead of
		// handing out a store whose every statement errors.
		if _, err := createConn.ExecContext(ctx, "SELECT count(*) FROM sqlite_master"); err != nil {
			return fmt.Errorf("content: open %s: %w (wrong key or corrupt file)", cfg.Path, err)
		}
		if err := resetIfSchemaChanged(ctx, createConn, cfg.Logger); err != nil {
			return err
		}
		if _, err := createConn.ExecContext(ctx, schemaV0); err != nil {
			return fmt.Errorf("content: schema: %w", err)
		}
		if _, err := createConn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", schemaVersion)); err != nil {
			return fmt.Errorf("content: stamp schema version: %w", err)
		}
		return nil
	}()
	_ = createConn.Close()
	if creationErr != nil {
		_ = db.Close()
		return nil, creationErr
	}

	enforceFileModes(cfg.Path)

	s := &sqliteContent{
		log:    cfg.Logger,
		cfg:    cfg,
		db:     db,
		keyHex: keyHex,
		path:   cfg.Path,
		policy: cfg.Policy,
	}
	s.sweep = func(ctx context.Context, cutoff int64) error {
		_, err := s.db.ExecContext(ctx,
			`DELETE FROM command_history WHERE ended_at IS NOT NULL AND ended_at < ?`, cutoff)
		return err
	}
	s.writeCh = make(chan writeReq)
	s.stop = make(chan struct{})
	s.wg.Add(1)
	go s.writer()
	return s, nil
}

// schemaVersion stamps the shape below into the file's user_version. Bump it
// in the same commit as any change to schemaV0 — that is the whole protocol.
//
// We write no migrations (greenfield), and `CREATE TABLE IF NOT EXISTS` is a
// no-op against a table that already exists, so before this check an added
// column produced a database that opened perfectly and then failed every
// INSERT and every SELECT with "no such column". The store went on reporting
// itself healthy while recording nothing; recall quietly fell back to the
// session, which is the only reason it was noticeable at all. A silent
// half-broken store is worse than no store, so the file is rebuilt instead —
// and it says so, because "your history was discarded" is a fact the user is
// entitled to rather than something to infer from an empty panel.
const schemaVersion = 2

// resetIfSchemaChanged rebuilds the file when it was written by a different
// schema. Rows are lost by design: they belong to a shape this build cannot
// read, and inventing a migration to keep them is the backwards compatibility
// this project deliberately does not carry.
func resetIfSchemaChanged(ctx context.Context, conn *sql.Conn, logger log.Logger) error {
	var onDisk int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&onDisk); err != nil {
		return fmt.Errorf("content: read schema version: %w", err)
	}
	if onDisk == schemaVersion {
		return nil
	}
	// A fresh file is version 0 with no tables — that is a creation, not a
	// reset, and must not be announced as data loss.
	var tables int
	if err := conn.QueryRowContext(
		ctx,
		"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='command_history'",
	).Scan(&tables); err != nil {
		return fmt.Errorf("content: probe schema: %w", err)
	}
	if tables == 0 {
		return nil
	}
	// Count first: the number is the only measure of what the user lost, and
	// after the DROP nobody can state it. A count that fails is not a reason
	// to abandon the rebuild — report it as unknown and carry on.
	rows := -1
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM command_history").Scan(&rows); err != nil {
		rows = -1
	}
	if _, err := conn.ExecContext(ctx, "DROP TABLE command_history"); err != nil {
		return fmt.Errorf("content: rebuild for schema %d: %w", schemaVersion, err)
	}
	if logger != nil {
		logger.Warn("content: history discarded — the database was written by an older schema",
			"was", onDisk, "now", schemaVersion, "rowsDiscarded", rows)
	}
	return nil
}

// schemaV0 is the interim command-history table. The full entry/edge/artifact
// schema is the next task (nocx-rtg0.2) and will migrate this table; what is
// fixed here is the engine posture around it (STRICT, auto_vacuum, WAL).
const schemaV0 = `
CREATE TABLE IF NOT EXISTS command_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT, -- backend seq; the only total order
  command      TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  host         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  exit_code    INTEGER,
  started_at   INTEGER,
  ended_at     INTEGER,
  trusted      INTEGER NOT NULL DEFAULT 0,
  masked_count INTEGER NOT NULL DEFAULT 0,
  masked_kinds TEXT    NOT NULL DEFAULT '[]',
  redactions   TEXT    NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS command_history_by_scope ON command_history (cwd, host, id DESC);
CREATE INDEX IF NOT EXISTS command_history_by_host  ON command_history (host, id DESC);
CREATE INDEX IF NOT EXISTS command_history_by_ended ON command_history (ended_at);
`

// keyedURI is the ONE file-creating path (canary rule): every file this
// package creates must be created through the adiantum VFS with the key in
// the URI. Omitting either silently defeats encryption — the SQLite backup
// API, ATTACH and VACUUM INTO write through whatever VFS the destination URI
// selects, and a destination opened without a key is either refused or
// encrypted with a throwaway random key (verified by the canary test).
func keyedURI(path, keyHex string) string {
	return "file:" + path + "?vfs=adiantum&hexkey=" + keyHex
}

// enforceFileModes keeps the at-rest posture (design §5.5, ADR-0018 §4):
// 0600 on every database file inside the 0700 directory. WAL and SHM files
// are created lazily by SQLite, so this runs after every successful write as
// well as at Open.
func enforceFileModes(path string) {
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(p); err == nil {
			_ = os.Chmod(p, 0o600)
		}
	}
}

// ── writer goroutine (design §5.3) ───────────────────────────────────────

// process executes one accepted mutation and answers its caller. A request
// that reached process is owed an answer, whatever happens next: a caller
// waiting for its outcome must never hang, and a committed outcome must
// never be replaced by a proxy error.
func (s *sqliteContent) process(req writeReq) {
	switch req.op {
	case opAdd:
		id, err := s.doAdd(req.ctx, req.record)
		req.done <- writeOutcome{id: id, err: err}
	case opRewrite:
		req.done <- writeOutcome{err: s.doRewrite(req.ctx, req.rew)}
	case opRestore:
		req.done <- writeOutcome{err: s.doRestore(req.ctx, req.restore)}
	}
}

func (s *sqliteContent) writer() {
	defer s.wg.Done()
	for {
		select {
		case req := <-s.writeCh:
			s.process(req)
		case <-s.stop:
			// Answer everything already queued before exiting (see
			// process): a request accepted before Close must learn its
			// outcome, not hang. The final default leaves only the
			// microscopic race of a send landing after this drain, which
			// no ordering in the app can produce — Close is teardown.
			for {
				select {
				case req := <-s.writeCh:
					s.process(req)
				default:
					// One blocking peek: a sender that won the send race
					// against the drain above still gets its answer.
					select {
					case req := <-s.writeCh:
						s.process(req)
					default:
						return
					}
				}
			}
		}
	}
}

func (s *sqliteContent) doAdd(ctx context.Context, r CommandRecord) (int64, error) {
	id, err := insertRecord(ctx, s.db, r)
	if err != nil {
		return 0, err
	}
	enforceFileModes(s.path)

	// Age-based retention, run in the same writer turn: completed commands
	// older than the limit are removed from nocx. Deletion is a short
	// autocommit transaction and uses the ended_at index; a crash between
	// the insert and the sweep only delays the sweep.
	if days := s.policy.RetentionDays(); days > 0 {
		cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
		if sweepErr := s.sweep(ctx, cutoff); sweepErr != nil {
			s.log.Warn("retention sweep failed", "error", sweepErr)
		}
	}
	return id, nil
}

// insertRecord executes one command-history INSERT through the given
// executor — the pool (single-row path) or a restore transaction. Shared so
// the two write paths cannot drift on the row shape.
func insertRecord(ctx context.Context, ex execer, r CommandRecord) (int64, error) {
	kinds := r.MaskedKinds
	if kinds == nil {
		kinds = []string{}
	}
	kindsJSON, err := json.Marshal(kinds)
	if err != nil {
		return 0, err
	}
	redactions := r.Redactions
	if redactions == nil {
		redactions = []Redaction{}
	}
	redactionsJSON, err := json.Marshal(redactions)
	if err != nil {
		return 0, err
	}
	// One INSERT, one autocommit transaction: short, atomic, replay-safe.
	res, err := ex.ExecContext(ctx, `INSERT INTO command_history
		(command, cwd, host, status, exit_code, started_at, ended_at, trusted, masked_count, masked_kinds, redactions)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Command, r.Cwd, r.Host, string(r.Status), r.ExitCode, r.StartedAt, r.EndedAt, r.Trusted, r.MaskedCount, string(kindsJSON), string(redactionsJSON))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// doRestore applies one private-content block in a single transaction:
// either every history row is durable or none is. A caller that restored
// rows one by one could be interrupted between rows, and a partial restore
// cannot be unwound through the repository surface — the store owns the
// atomicity (the export restore operation relies on it).
//
// Conversations are stubbed until agent mode (design §5.1): a block that
// carries them is refused, exactly as ConversationRepository.Save refuses.
func (s *sqliteContent) doRestore(ctx context.Context, r restoreRequest) error {
	if len(r.conversations) > 0 {
		return ErrNotImplemented
	}
	if len(r.history) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("restore private content: %w", err)
	}
	for _, rec := range r.history {
		if _, err := insertRecord(ctx, tx, rec); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("restore private content: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("restore private content: %w", err)
	}
	enforceFileModes(s.path)

	// Retention at the batch level: restored rows older than the limit are
	// removed, matching the per-write path. Best-effort, as in doAdd.
	if days := s.policy.RetentionDays(); days > 0 {
		cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
		if sweepErr := s.sweep(ctx, cutoff); sweepErr != nil {
			s.log.Warn("retention sweep failed", "error", sweepErr)
		}
	}
	return nil
}

// execer is the ExecContext surface shared by *sql.DB and *sql.Tx.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Add serializes the insert through the single writer goroutine and returns
// the backend-assigned row id — the row's stable identity, which a later
// RewriteRedaction addresses. The record's ID field is informational.
func (s *sqliteContent) Add(ctx context.Context, record CommandRecord) (int64, error) {
	if s.closed.Load() {
		return 0, ErrClosed
	}
	// Keep-history-off: a command runs and no row appears. Decided before the
	// writer is invoked, so nothing is serialized for a record nobody wants.
	if !s.policy.Enabled() {
		return 0, nil
	}
	req := writeReq{ctx: ctx, op: opAdd, record: record, done: make(chan writeOutcome, 1)}
	select {
	case s.writeCh <- req:
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-s.stop:
		return 0, ErrClosed
	}
	select {
	case out := <-req.done:
		return out.id, out.err
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-s.stop:
		return 0, ErrClosed
	}
}

// RestorePrivate applies one private-content block atomically through the
// single writer. The caller's context governs the transaction: a
// cancellation before the writer accepts the request does nothing, and a
// cancellation INSIDE the transaction aborts it (the insert path observes
// ctx). A cancellation AFTER the transaction committed must not surface as
// an error — the restore is committed, and reporting failure would send the
// export restore operation into a rollback that splits the stores — so once
// the writer accepts the request the caller waits for its outcome, which is
// authoritative. The writer drains its queue on Close, so an accepted
// request is always answered.
func (s *sqliteContent) RestorePrivate(ctx context.Context, conversations []Conversation, history []CommandRecord) error {
	if s.closed.Load() {
		return ErrClosed
	}
	if len(conversations) > 0 {
		// The SQLite backing has no conversation table yet; the stub is
		// the honest surface (agent mode, design §5.1). Refuse rather
		// than drop.
		return ErrNotImplemented
	}
	if !s.policy.Enabled() {
		// History off: the single-row path's Add stores nothing and
		// succeeds, and the restore matches it exactly.
		return nil
	}
	req := writeReq{
		ctx:     ctx,
		op:      opRestore,
		restore: restoreRequest{history: history},
		done:    make(chan writeOutcome, 1),
	}
	select {
	case s.writeCh <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-s.stop:
		return ErrClosed
	}
	// Accepted: the writer owns the outcome. Deliberately no ctx.Done or
	// stop case here — either could win after the transaction committed and
	// report failure for a committed restore (see the doc comment).
	out := <-req.done
	return out.err
}

// RewriteRedaction replaces the redaction segment at span in the row's
// stored command with reference, dropping the segment from the row's
// redactions. Read-modify-write happens inside one writer turn, so no
// concurrent mutation can interleave. Idempotent for a span already holding
// the same reference.
func (s *sqliteContent) RewriteRedaction(ctx context.Context, id int64, span Redaction, reference string) error {
	if s.closed.Load() {
		return ErrClosed
	}
	req := writeReq{
		ctx:  ctx,
		op:   opRewrite,
		rew:  rewriteRequest{id: id, span: span, reference: reference},
		done: make(chan writeOutcome, 1),
	}
	select {
	case s.writeCh <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-s.stop:
		return ErrClosed
	}
	select {
	case out := <-req.done:
		return out.err
	case <-ctx.Done():
		return ctx.Err()
	case <-s.stop:
		return ErrClosed
	}
}

func (s *sqliteContent) doRewrite(ctx context.Context, rr rewriteRequest) error {
	var command string
	var redactionsJSON string
	err := s.db.QueryRowContext(
		ctx,
		"SELECT command, redactions FROM command_history WHERE id = ?", rr.id,
	).Scan(&command, &redactionsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var redactions []Redaction
	if uerr := json.Unmarshal([]byte(redactionsJSON), &redactions); uerr != nil {
		return uerr
	}
	// The span is byte offsets into the stored command. A span that no
	// longer fits means the row changed shape underneath this caller —
	// refuse rather than corrupt.
	if rr.span.Start < 0 || rr.span.End > len(command) || rr.span.Start > rr.span.End {
		return fmt.Errorf("content: redaction span [%d:%d] out of range for row %d", rr.span.Start, rr.span.End, rr.id)
	}
	// Idempotency: the span must be one of the row's CURRENT redactions.
	// A retried save (a lost response) re-sends the span it captured at
	// record time; the first attempt already removed it, so the retry is a
	// no-op instead of replacing text at stale offsets.
	matched := false
	kept := make([]Redaction, 0, len(redactions))
	for _, r := range redactions {
		if r.Start == rr.span.Start && r.End == rr.span.End && r.Kind == rr.span.Kind {
			matched = true
			continue
		}
		kept = append(kept, r)
	}
	if !matched {
		return nil
	}
	newCommand := command[:rr.span.Start] + rr.reference + command[rr.span.End:]
	keptJSON, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(
		ctx,
		"UPDATE command_history SET command = ?, redactions = ? WHERE id = ?",
		newCommand, string(keptJSON), rr.id,
	); err != nil {
		return err
	}
	enforceFileModes(s.path)
	return nil
}

const recordCols = "id, command, cwd, host, status, exit_code, started_at, ended_at, trusted, masked_count, masked_kinds, redactions"

func scanRecord(row interface{ Scan(...any) error }) (CommandRecord, error) {
	var r CommandRecord
	var kindsJSON string
	var redactionsJSON string
	err := row.Scan(&r.ID, &r.Command, &r.Cwd, &r.Host, &r.Status, &r.ExitCode, &r.StartedAt, &r.EndedAt, &r.Trusted, &r.MaskedCount, &kindsJSON, &redactionsJSON)
	if err != nil {
		return CommandRecord{}, err
	}
	if err := json.Unmarshal([]byte(kindsJSON), &r.MaskedKinds); err != nil {
		return CommandRecord{}, err
	}
	if err := json.Unmarshal([]byte(redactionsJSON), &r.Redactions); err != nil {
		return CommandRecord{}, err
	}
	return r, nil
}

// List returns the limit newest records, newest first.
func (s *sqliteContent) List(ctx context.Context, limit int) ([]CommandRecord, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+recordCols+
		" FROM command_history ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []CommandRecord
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetByID returns one record, or (nil, nil) when no row carries that id.
func (s *sqliteContent) GetByID(ctx context.Context, id int64) (*CommandRecord, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+recordCols+" FROM command_history WHERE id = ?", id)
	r, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// FindByPrefix returns the limit newest records whose command starts with
// prefix. LIKE wildcards in the prefix are escaped: a prefix containing % or
// _ matches them literally.
func (s *sqliteContent) FindByPrefix(ctx context.Context, prefix string, limit int) ([]CommandRecord, error) {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(prefix)
	rows, err := s.db.QueryContext(ctx, "SELECT "+recordCols+
		" FROM command_history WHERE command LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
		escaped+"%", limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []CommandRecord
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Query returns one page of history for the recall-ladder rung, newest first
// (contracts/history.query.schema.json). The directory rung is the exact
// (cwd, host) pair — the overlay's own rung semantics, design §10.6. The page
// and the store-wide row count are read in one read transaction so HasRows
// cannot race a concurrent write.
//
// text is the search filter (nocx-ms7v): a case-insensitive substring over
// command, applied WITHIN the rung — the server never silently widens. Empty
// means no filter. There is deliberately no FTS: a substring match cannot use
// an index, and at command-history sizes a full scan of the rung is cheap —
// measured 100k rows, filter hit, ~260 µs per query (dev machine, WAL warm),
// so the overlay's per-keystroke queries are nowhere near a frame budget.
// FTS arrives with output search, whose indexing unit is still an open
// decision.
//
// Coverage is the store-wide MIN(ended_at) — how far back retention lets this
// answer see, independent of the rung and the filter. It is read in the same
// transaction so the horizon and the page cannot disagree about the store's
// state.
func (s *sqliteContent) Query(ctx context.Context, scope Scope, cwd, host string, limit int, before *int64, text string) (HistoryPage, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return HistoryPage{}, err
	}
	defer func() { _ = tx.Rollback() }()

	cond, args := scopeWhere(scope, cwd, host)
	if before != nil {
		if cond == "" {
			cond = " WHERE id < ?"
		} else {
			cond += " AND id < ?"
		}
		args = append(args, *before)
	}
	// The filter is a parameterized case-folded substring predicate, not
	// LIKE: instr() has no wildcard grammar, so a search for "100%_done"
	// matches that literal command and nothing else. lower(?) is bound once;
	// lower(command) is computed per row (no index — the measurement above).
	if text != "" {
		if cond == "" {
			cond = " WHERE instr(lower(command), lower(?)) > 0"
		} else {
			cond += " AND instr(lower(command), lower(?)) > 0"
		}
		args = append(args, text)
	}
	// Fetch limit+1: one extra row proves the rung is not exhausted.
	// cond and recordCols are package constants — never user input.
	rows, err := tx.QueryContext(ctx, "SELECT "+recordCols+ //nolint:gosec // constant fragments
		" FROM command_history"+cond+" ORDER BY id DESC LIMIT ?",
		append(args, limit+1)...)
	if err != nil {
		return HistoryPage{}, err
	}
	entries := []CommandRecord{}
	extra := false
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			_ = rows.Close()
			return HistoryPage{}, err
		}
		if len(entries) == limit {
			extra = true
			break
		}
		entries = append(entries, r)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return HistoryPage{}, err
	}

	var total int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM command_history").Scan(&total); err != nil {
		return HistoryPage{}, err
	}
	// MIN ignores NULL ended_at (running entries), so a store full of
	// running rows reports no horizon rather than a misleading one.
	var coverage *int64
	if err := tx.QueryRowContext(ctx, "SELECT MIN(ended_at) FROM command_history").Scan(&coverage); err != nil {
		return HistoryPage{}, err
	}
	if err := tx.Commit(); err != nil {
		return HistoryPage{}, err
	}
	return HistoryPage{Entries: entries, Exhausted: !extra, HasRows: total > 0, Coverage: coverage}, nil
}

func scopeWhere(scope Scope, cwd, host string) (string, []any) {
	switch scope {
	case ScopeDirectory:
		return " WHERE cwd = ? AND host = ?", []any{cwd, host}
	case ScopeHost:
		return " WHERE host = ?", []any{host}
	default:
		return "", nil
	}
}

// ── backup (the canary-safe copy path) ───────────────────────────────────

// Backup writes a consistent encrypted snapshot to destPath via the SQLite
// online backup API. The destination URI carries vfs=adiantum and the key:
// the backup API opens the destination itself, so there is no PRAGMA window
// to key it afterwards (verified by the canary test).
func (s *sqliteContent) Backup(ctx context.Context, destPath string) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	err = conn.Raw(func(driverConn any) error {
		dc, ok := driverConn.(driver.Conn)
		if !ok {
			return fmt.Errorf("content: unexpected driver connection %T", driverConn)
		}
		return dc.Raw().Backup("main", keyedURI(destPath, s.keyHex))
	})
	return err
}

// ── ContentDB surface ────────────────────────────────────────────────────

// Conversations stays stubbed until agent mode (design §5.1).
func (s *sqliteContent) Conversations() ConversationRepository {
	return &convStub{log: s.log}
}

func (s *sqliteContent) CommandHistory() CommandHistoryRepository {
	return s
}

// Close stops the writer goroutine and closes the pool. Idempotent; later
// operations return ErrClosed.
func (s *sqliteContent) Close() error {
	var err error
	s.closeMu.Do(func() {
		s.closed.Store(true)
		close(s.stop)
		s.wg.Wait()
		err = s.db.Close()
		enforceFileModes(s.path)
	})
	return err
}
