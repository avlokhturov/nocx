package content

// Retention's durable watermark and the eviction of ledger entries
// (nocx-rtg0.12), design §5.4.
//
// The design states the constraint this file exists for, and states it as an
// impossibility rather than a preference:
//
//	Search states its coverage — and coverage cannot be computed from the
//	rows that remain. Once eviction has deleted the rows, there is nothing
//	left to count.
//
// So the store keeps a watermark: a durable record of what eviction removed
// and how far its knowledge is now incomplete, written in the SAME
// transaction as the deletion. Without it, `MIN(ended_at)` over the survivors
// answers "how far back can this store see" with the horizon of whatever
// happened to be left — and answers it most confidently when eviction has
// taken the most, because an emptied table reports no horizon at all, which
// reads as "nothing was ever here".
//
// # Why the watermark is one row and not a journal of passes
//
// The spec calls it a journal. A journal of passes would grow one row per
// eviction, and eviction runs on the write path — that is a second history
// beside the one being evicted, which is the opposite of the point. The two
// questions it must answer ("how many entries has this store ever evicted"
// and "what is the oldest moment it can still speak for") are both
// accumulators, so a single accumulating row answers them in O(1) and can
// never itself need eviction. It follows `ledger_sequence`, which is the same
// shape for the same reason: one row, `CHECK (id = 1)`, seeded idempotently.
//
// # Why age-based eviction only, and what is deliberately not here
//
// Retention has two candidate drivers: age (Policy.RetentionDays) and size
// (Budget.RetentionBytes). This lands ONE of them — age — completely, rather
// than half of each.
//
// The reason is that the watermark's horizon is a TIME coordinate, and an age
// cutoff is already one: the two compose without a second derivation. A
// byte-budget eviction would have to derive its horizon from whichever rows
// its byte accounting happened to reach, and that accounting does not exist
// for entries yet — `artifacts.byte_len` is maintained per artifact, but
// nothing sums it per entry, and inventing that sum here would put a second
// owner on "how big is this entry" beside the budget code that already owns
// the file-level numbers. Size-driven eviction is therefore left out on
// purpose; it reuses everything below, needing only a different way to choose
// the victim set.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// evictionPassLimit bounds one pass run from the write path. Eviction shares
// the single writer goroutine with every other mutation (design §5.3), so an
// unbounded DELETE over a large backlog would stall every command behind it;
// the next write continues where this one stopped.
const evictionPassLimit = 256

// EvictionRequest is one bounded retention pass.
type EvictionRequest struct {
	// Before is the retention cutoff in Unix milliseconds: an entry is a
	// candidate when it has COMPLETED and ended strictly before this. An
	// entry that never ended is unfinished, not old, and is never a
	// candidate however long ago it was submitted.
	Before int64
	// Max bounds how many entries this pass may remove. It is what makes the
	// ingest_seq ordering load-bearing: under a cap, WHICH rows go is
	// decided by the ledger's total order.
	Max int
}

// EvictionResult is what one pass did.
type EvictionResult struct {
	// Evicted is how many entries this pass removed.
	Evicted int64
	// TotalEvicted is the store's running total after this pass — the
	// watermark's count, which no query over the surviving rows can produce.
	TotalEvicted int64
	// Horizon is the store-wide horizon after this pass. Nil only when
	// nothing has ever been evicted.
	Horizon *int64
}

// RetentionWatermark is the durable answer to "what has this store lost".
// Both fields are read from the watermark row, never from the entries that
// remain — that independence is the whole reason it exists.
type RetentionWatermark struct {
	// EvictedCount is how many entries this store has EVER evicted. It is
	// monotonic and routinely larger than the number of rows the table
	// holds, which is exactly what makes it underivable from them.
	EvictedCount int64
	// Horizon is the newest instant eviction has removed, in Unix
	// milliseconds: the store's knowledge is complete only AFTER it. Nil
	// until the first eviction commits.
	//
	// It advances and never retreats. A pass whose newest victim is older
	// than the standing horizon has learned nothing — the store was already
	// incomplete that far back — and a horizon that moved backwards would
	// claim the store had recovered history it never regained.
	Horizon *int64
	// LastEvictedAt is the wall clock at the last pass that removed
	// something. Nil until then. Display and diagnosis only: it says when
	// the store last lost something, never what it can answer.
	LastEvictedAt *int64
}

// validateEvictionRequest refuses a pass that cannot mean anything, rather
// than running it and reporting that it evicted nothing — the two outcomes
// look identical to a caller and only one of them is a bug in the caller.
func validateEvictionRequest(req EvictionRequest) error {
	if req.Max < 1 {
		return fmt.Errorf("content: evict: max %d is not a bound — a pass removes at least one row or is not a pass", req.Max)
	}
	if req.Before < 0 {
		return fmt.Errorf("content: evict: before %d is not a wall clock", req.Before)
	}
	return nil
}

// EvictEntries removes the oldest entries that retention no longer covers and
// records what it removed, in ONE transaction. Serialized through the writer
// goroutine like every other mutation.
func (s *sqliteContent) EvictEntries(ctx context.Context, req EvictionRequest) (EvictionResult, error) {
	if err := validateEvictionRequest(req); err != nil {
		return EvictionResult{}, err
	}
	var out EvictionResult
	err := s.run(ctx, func(ctx context.Context) error {
		var err error
		out, err = s.evictEntries(ctx, req)
		return err
	})
	return out, err
}

// evictEntries is the pass itself, on the pool. It runs ON the writer
// goroutine (either through EvictEntries' run, or called directly by a write
// path that is already there) and must never call back into run — that would
// deadlock the writer against itself.
func (s *sqliteContent) evictEntries(ctx context.Context, req EvictionRequest) (EvictionResult, error) {
	// BEGIN IMMEDIATE, for the reason Submit states: the write lock is taken
	// at BEGIN rather than at the first write, so a second process's writer
	// waits instead of failing an upgrade with SQLITE_BUSY_SNAPSHOT.
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return EvictionResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	ids, newest, err := evictionVictims(ctx, tx, req)
	if err != nil {
		return EvictionResult{}, err
	}
	if len(ids) == 0 {
		// Nothing to remove: the store lost nothing, so the watermark must
		// not move. A pass that recorded a horizon here would narrow the
		// store's stated coverage without any row having gone.
		if commitErr := tx.Commit(); commitErr != nil {
			return EvictionResult{}, commitErr
		}
		wm, wmErr := s.watermark(ctx, s.db)
		if wmErr != nil {
			return EvictionResult{}, wmErr
		}
		return EvictionResult{TotalEvicted: wm.EvictedCount, Horizon: wm.Horizon}, nil
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	// Edges, executions, artifacts, chunks and grants cascade from the
	// entry (schema question 5) — the DELETE is the whole removal.
	//
	// placeholders is "?,?,…" derived from len(ids) alone: no value reaches
	// the statement text, every id is bound.
	del := `DELETE FROM entries WHERE id IN (` + placeholders + `)` //nolint:gosec // see above
	res, err := tx.ExecContext(ctx, del, args...)
	if err != nil {
		return EvictionResult{}, err
	}
	removed, err := res.RowsAffected()
	if err != nil {
		return EvictionResult{}, err
	}

	// The watermark moves in the SAME transaction. max() keeps the horizon
	// monotonic; COALESCE makes the first pass, where the column is still
	// NULL, take this pass's value rather than propagating NULL through the
	// comparison.
	var total int64
	var horizon *int64
	if err := tx.QueryRowContext(ctx,
		`UPDATE retention_watermark
		    SET evicted_count   = evicted_count + ?,
		        horizon         = max(COALESCE(horizon, ?), ?),
		        last_evicted_at = ?
		  WHERE id = 1
		RETURNING evicted_count, horizon`,
		removed, newest, newest, time.Now().UnixMilli(),
	).Scan(&total, &horizon); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EvictionResult{}, errors.New("content: evict: the retention watermark row is missing")
		}
		return EvictionResult{}, fmt.Errorf("content: evict: record watermark: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return EvictionResult{}, err
	}
	return EvictionResult{Evicted: removed, TotalEvicted: total, Horizon: horizon}, nil
}

// evictionVictims chooses this pass's rows and reports the newest instant
// among them.
//
// The order is ingest_seq — the ledger's only total order (ADR-0019 §2) —
// and never ended_at. Two entries can carry the same wall clock, and the
// clock can move backwards; commit order cannot. Under a cap this is what
// decides which rows go, so it is load-bearing rather than decorative.
//
// The horizon is the newest ended_at actually SELECTED, not the requested
// cutoff. When a cap stops the pass early the store remains complete from
// somewhere before the cutoff, and claiming the cutoff would assert coverage
// it does not have. It is computed here, over the rows about to be deleted,
// because a moment later they are gone — which is the whole difficulty this
// file addresses, in miniature.
func evictionVictims(ctx context.Context, tx *sql.Tx, req EvictionRequest) ([]string, int64, error) {
	// A pinned artifact exempts its entry from BACKGROUND eviction (schema
	// question 4): a capsule whose content can be evicted underneath it is a
	// broken promise. A pin protects against this, never against an explicit
	// DeleteEntry.
	rows, err := tx.QueryContext(ctx,
		`SELECT e.id, e.ended_at
		   FROM entries e
		  WHERE e.ended_at IS NOT NULL
		    AND e.ended_at < ?
		    AND NOT EXISTS (
		          SELECT 1
		            FROM artifacts a
		           WHERE a.entry_id = e.id AND a.pinned = 1)
		  ORDER BY e.ingest_seq
		  LIMIT ?`, req.Before, req.Max)
	if err != nil {
		return nil, 0, fmt.Errorf("content: evict: select victims: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var ids []string
	var newest int64
	for rows.Next() {
		var id string
		var endedAt int64
		if err := rows.Scan(&id, &endedAt); err != nil {
			return nil, 0, fmt.Errorf("content: evict: select victims: %w", err)
		}
		if len(ids) == 0 || endedAt > newest {
			newest = endedAt
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("content: evict: select victims: %w", err)
	}
	return ids, newest, nil
}

// Watermark reports what this store has lost. It is a plain read — no writer
// turn — because it answers from the watermark row alone.
func (s *sqliteContent) Watermark(ctx context.Context) (RetentionWatermark, error) {
	return s.watermark(ctx, s.db)
}

// watermark reads the one row through rowQuerier — the seam this package
// already has for "something rows can be read through" — so the query path
// can read it inside its own transaction and see a horizon consistent with
// the page it is answering.
func (s *sqliteContent) watermark(ctx context.Context, q rowQuerier) (RetentionWatermark, error) {
	var wm RetentionWatermark
	if err := q.QueryRowContext(ctx,
		`SELECT evicted_count, horizon, last_evicted_at FROM retention_watermark WHERE id = 1`,
	).Scan(&wm.EvictedCount, &wm.Horizon, &wm.LastEvictedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RetentionWatermark{}, errors.New("content: watermark: the retention watermark row is missing")
		}
		return RetentionWatermark{}, fmt.Errorf("content: watermark: %w", err)
	}
	return wm, nil
}

// evictOnWrite runs one bounded pass from a write path that is already on the
// writer goroutine.
//
// Best-effort, exactly like the command-history sweep beside it and for the
// same reason: the entry it follows is already committed and durable, so an
// eviction failure must not turn a successful write into an error a caller
// would retry — the retry would be a second submit of the same intent. The
// degrade is a warning, and it is safe to be quiet about because the
// watermark is only ever written WITH a deletion: a pass that failed left the
// store's stated coverage exactly as truthful as it was before.
func (s *sqliteContent) evictOnWrite(ctx context.Context) {
	days := s.policy.RetentionDays()
	if days <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	if cutoff < 0 {
		return
	}
	if _, err := s.evictEntries(ctx, EvictionRequest{Before: cutoff, Max: evictionPassLimit}); err != nil {
		s.log.Warn("ledger retention eviction failed", "error", err)
	}
}
