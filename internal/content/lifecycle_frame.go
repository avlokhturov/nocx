package content

// ONE LIFECYCLE FRAME, ONE TRANSACTION (ADR-0077, the owner's decision of
// 2026-09-30).
//
// A coordinator applies the shell's lifecycle frames one at a time, and each
// one may write several rows — an entry, its execution, the block's artifact,
// the settle of a block the frame ends — before the coordinator's own cursor
// says the frame was applied. Those writes and the cursor commit together or
// not at all: a process that dies anywhere inside the frame leaves the store
// exactly as it was before it, and the next coordinator, resuming from the
// cursor, applies the frame once. There is no window in which the rows are
// stored and the cursor is not.
//
// The frame is carried in the context. Every store method routes its
// statements through conn and beginTx, and a context that carries this
// store's frame runs them on the frame's transaction: the transaction begins
// at the frame's first write — never before, so a frame that reads without
// writing holds nothing — and the connection is held from then until the
// frame ends (maxOpenConns is one, sqlite.go). A method's own transaction
// becomes a savepoint inside it. Any write that fails under the frame fails
// the frame, and a failed frame commits nothing, cursor included.
//
// THE HOLD IS BOUNDED, AND A FAILED FRAME IS TRIED AGAIN (the owner's
// decisions of 2026-09-30). The one connection is every other reader's and
// writer's too, so a frame may hold it for LifecycleFrameMaxHold and no
// longer, counted from its first write. Past it the frame is rolled back where
// it stands — nothing of it stored, and not the cursor — exactly as a frame
// whose write failed is. Either way the same coordinator applies the frame's
// writes again, up to lifecycleFrameRetries more times with a pause before
// each (ApplyLifecycleFrame), and the caller's next frame waits for it, so
// the order the shell spoke in holds. Only when the last attempt fails does
// the frame fail its caller, which then applies nothing more on that leg; the
// next coordinator applies the frame once, from the cursor.
//
// THE CONTRACT THIS PUTS ON A CALLER: every store call a frame makes carries
// the context the frame handed it. A call on the same goroutine with any
// other context waits for the connection the frame holds, and the frame is
// waiting for that call.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

// querier is the statement surface *sql.DB and *sql.Tx share.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// LifecycleFrameMaxHold bounds one frame's hold on the store's connection,
// from its first write to its commit.
//
// 250 ms is the owner's figure (2026-09-30), set against the hold measured on
// the restart and shell-exit acceptances: first write to commit, p50 0.70 ms,
// p99 12.7 ms, max 35.8 ms in a plain run, and p50 0.73 ms, p99 21.9 ms, max
// 52.1 ms under the loaded bar (and one frame of 106.5 ms), almost all of it
// store work — the commit itself up to 11 ms (ADR-0077).
const LifecycleFrameMaxHold = 250 * time.Millisecond

// lifecycleFrameRetryPauses are the pauses before each further attempt at a
// frame that failed: three more attempts, four in all.
var lifecycleFrameRetryPauses = [...]time.Duration{50 * time.Millisecond, 100 * time.Millisecond, 200 * time.Millisecond}

// FrameFailedError is a frame that failed every attempt: nothing of it and
// not the cursor was stored.
type FrameFailedError struct {
	// Attempts is how many times the frame was applied.
	Attempts int
	// Held is how long the last attempt held the connection.
	Held time.Duration
	// Cause is the last attempt's failure.
	Cause error
}

func (e *FrameFailedError) Error() string {
	return fmt.Sprintf("content: the lifecycle frame was not applied after %d attempts (the last held the store %s): %v",
		e.Attempts, e.Held, e.Cause)
}

// Unwrap answers both the sentinel every frame failure carries and the cause.
func (e *FrameFailedError) Unwrap() []error { return []error{ErrLifecycleFrameFailed, e.Cause} }

// FrameExpiredError is the failure of a frame that held the connection past
// LifecycleFrameMaxHold and was rolled back.
type FrameExpiredError struct {
	// Held is how long the frame had held the connection when it was rolled
	// back.
	Held time.Duration
}

func (e *FrameExpiredError) Error() string {
	return fmt.Sprintf("content: the lifecycle frame held the store past its bound (%s, held %s) and was rolled back",
		LifecycleFrameMaxHold, e.Held)
}

// lifecycleFrameKey carries the frame in a context.
type lifecycleFrameKey struct{}

// lifecycleFrame is one frame's unit of work.
type lifecycleFrame struct {
	s *sqliteContent

	mu         sync.Mutex
	tx         *sql.Tx
	savepoints int
	failed     error
	// began is when the frame took the connection; stop disarms its bound.
	began time.Time
	stop  func() bool
	ended bool
	held  time.Duration
	// writes are the store writes the frame made, in order — every one the
	// frame's projection asked for, whether it ran, failed, or was refused
	// because the frame had already failed. A further attempt replays them.
	writes []func(ctx context.Context) error
	// release gives back the frame's goroutine claim (framecheck).
	release func()
}

// frameOf is the frame ctx carries for this store, or nil.
func (s *sqliteContent) frameOf(ctx context.Context) *lifecycleFrame {
	f, _ := ctx.Value(lifecycleFrameKey{}).(*lifecycleFrame)
	if f == nil || f.s != s {
		return nil
	}
	return f
}

// conn is what a statement under ctx runs on: the frame's transaction once
// the frame has one, the pool otherwise. A read a frame makes before its
// first write sees exactly what the transaction would.
//
// A read on a frame's own goroutine WITHOUT the frame's context would wait
// for the connection the frame holds; under nocx_framecheck it panics with
// ErrFrameContextMissing instead, because *sql.Row has no way to carry an
// error of the store's own.
func (s *sqliteContent) conn(ctx context.Context) querier {
	if err := s.checkFrameContext(ctx); err != nil {
		panic(err)
	}
	if f := s.frameOf(ctx); f != nil {
		f.mu.Lock()
		tx := f.tx
		f.mu.Unlock()
		if tx != nil {
			return tx
		}
	}
	return s.db
}

// txEnd ends one method's transaction: the transaction itself, or, inside a
// frame, the savepoint that stands for it.
type txEnd struct {
	tx        *sql.Tx
	frame     *lifecycleFrame
	savepoint string
	done      bool
}

func (e *txEnd) commit() error {
	if e.done {
		return sql.ErrTxDone
	}
	e.done = true
	if e.frame == nil {
		return e.tx.Commit()
	}
	_, err := e.tx.ExecContext(context.Background(), "RELEASE "+e.savepoint)
	if err != nil {
		e.frame.fail(err)
	}
	return err
}

func (e *txEnd) rollback() {
	if e.done {
		return
	}
	e.done = true
	if e.frame == nil {
		_ = e.tx.Rollback()
		return
	}
	if _, err := e.tx.ExecContext(context.Background(), "ROLLBACK TO "+e.savepoint); err != nil {
		e.frame.fail(err)
		return
	}
	if _, err := e.tx.ExecContext(context.Background(), "RELEASE "+e.savepoint); err != nil {
		e.frame.fail(err)
	}
}

// beginTx begins one method's transaction: its own, or a savepoint in the
// frame ctx carries.
func (s *sqliteContent) beginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, *txEnd, error) {
	f := s.frameOf(ctx)
	if f == nil {
		if err := s.checkFrameContext(ctx); err != nil {
			return nil, nil, err
		}
		tx, err := s.db.BeginTx(ctx, opts)
		if err != nil {
			return nil, nil, err
		}
		return tx, &txEnd{tx: tx}, nil
	}
	tx, err := f.open(ctx)
	if err != nil {
		return nil, nil, err
	}
	f.mu.Lock()
	f.savepoints++
	name := fmt.Sprintf("frame_sp_%d", f.savepoints)
	f.mu.Unlock()
	if _, err := tx.ExecContext(ctx, "SAVEPOINT "+name); err != nil {
		f.fail(err)
		return nil, nil, err
	}
	return tx, &txEnd{tx: tx, frame: f, savepoint: name}, nil
}

// open begins the frame's transaction on its first use. The transaction
// outlives the caller's cancellation: only the frame's end closes it.
func (f *lifecycleFrame) open(ctx context.Context) (*sql.Tx, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failed != nil {
		return nil, f.failed
	}
	if f.tx != nil {
		return f.tx, nil
	}
	tx, err := f.s.db.BeginTx(context.WithoutCancel(ctx), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		f.failed = err
		return nil, err
	}
	f.tx = tx
	f.began = time.Now()
	f.stop = f.s.cfg.FrameTimer(LifecycleFrameMaxHold, f.expire)
	return tx, nil
}

// expire is the bound firing: the frame is rolled back where it stands and
// fails, so the connection is free again even while the frame's own
// goroutine is still inside it. Whatever it does next on the store fails.
func (f *lifecycleFrame) expire() {
	f.mu.Lock()
	if f.ended || f.tx == nil {
		f.mu.Unlock()
		return
	}
	held := time.Since(f.began)
	if f.failed == nil {
		f.failed = &FrameExpiredError{Held: held}
	}
	tx := f.tx
	f.mu.Unlock()
	// Waits only for a statement already running on the transaction.
	_ = tx.Rollback()
}

// write runs one store write inside the frame.
func (f *lifecycleFrame) write(ctx context.Context, fn func(ctx context.Context) error) error {
	f.mu.Lock()
	f.writes = append(f.writes, fn)
	f.mu.Unlock()
	if _, err := f.open(ctx); err != nil {
		return err
	}
	if err := fn(ctx); err != nil {
		f.fail(err)
		return err
	}
	return nil
}

func (f *lifecycleFrame) fail(err error) {
	f.mu.Lock()
	if f.failed == nil {
		f.failed = err
	}
	f.mu.Unlock()
}

// ErrFrameContextMissing is a store call made on a lifecycle frame's own
// goroutine without the context the frame handed it — the call that would
// otherwise wait for the connection the frame holds while the frame waits for
// it. Only the nocx_framecheck build detects it (framecheck_on.go); in a
// shipped build the frame's hold bound is what ends that wait.
var ErrFrameContextMissing = errors.New("content: a store call on a lifecycle frame's own goroutine did not carry the frame's context — " +
	"ADR-0077's contract: every store call a frame makes carries the context the frame handed it, " +
	"or it waits for the connection the frame holds")

// ErrLifecycleFrameFailed wraps the first store failure of a frame that
// committed nothing.
var ErrLifecycleFrameFailed = errors.New("content: the lifecycle frame was not applied")

// ApplyLifecycleFrame implements LedgerRepository: apply's store writes and
// the session's lifecycle cursor at offset commit as one transaction, or
// none of them does.
//
// A FRAME THAT FAILS IS APPLIED AGAIN, BY THIS SAME COORDINATOR, BEFORE ITS
// CALLER'S NEXT FRAME. The first attempt runs apply — the kernel's ingest and
// every projection it causes — and records each store write the projection
// makes. If the attempt fails (a write fails, or the hold bound rolls it
// back), the store is exactly as it was before the frame, and each further
// attempt replays the recorded writes, in order, in a fresh transaction with
// the cursor as its last statement, after a pause. apply itself is never run
// twice: the kernel and the projection's own memory already hold the frame,
// and what the store lacks is exactly the writes it rolled back. Replaying
// them is safe because every write a lifecycle frame causes is idempotent,
// keyed by the identity of its block (ADR-0077 decision 7): a write that had
// in fact landed before the failure was rolled back with it, and a write
// that finds its row already there — an entry, an execution, an open block —
// is a no-op. Only when every attempt failed does the frame fail its caller,
// with a FrameFailedError.
func (s *sqliteContent) ApplyLifecycleFrame(ctx context.Context, sessionID string, offset uint64, apply func(ctx context.Context) error) error {
	if s.frameOf(ctx) != nil {
		return errors.New("content: a lifecycle frame cannot nest inside another")
	}
	f := s.newFrame()
	fctx := context.WithValue(ctx, lifecycleFrameKey{}, f)
	if err := apply(fctx); err != nil {
		f.fail(err)
	}
	f.mu.Lock()
	writes := append([]func(ctx context.Context) error(nil), f.writes...)
	f.mu.Unlock()
	err := f.commit(fctx, sessionID, offset)
	attempts := 1
	for _, pause := range lifecycleFrameRetryPauses {
		if err == nil {
			return nil
		}
		log.From(ctx).Warn("lifecycle frame not applied; the same coordinator applies it again",
			"session", sessionID, "attempt", attempts, "held_us", f.held.Microseconds(), "error", err)
		s.pause(pause)
		attempts++
		f = s.newFrame()
		fctx = context.WithValue(ctx, lifecycleFrameKey{}, f)
		for _, w := range writes {
			_ = f.write(fctx, w)
		}
		err = f.commit(fctx, sessionID, offset)
	}
	if err == nil {
		return nil
	}
	cause := err
	if unwrapped := errors.Unwrap(err); unwrapped != nil {
		cause = unwrapped
	}
	var failed *FrameFailedError
	if errors.As(err, &failed) {
		cause = failed.Cause
	}
	return &FrameFailedError{Attempts: attempts, Held: f.held, Cause: cause}
}

// newFrame starts one attempt's unit of work.
func (s *sqliteContent) newFrame() *lifecycleFrame {
	f := &lifecycleFrame{s: s}
	f.release = s.claimGoroutine(f)
	return f
}

// pause waits d on the store's frame timer, so a test drives it.
func (s *sqliteContent) pause(d time.Duration) {
	done := make(chan struct{})
	s.cfg.FrameTimer(d, func() { close(done) })
	<-done
}

// commit writes the cursor as the frame's last statement, unless the frame
// already failed, and ends the attempt.
func (f *lifecycleFrame) commit(ctx context.Context, sessionID string, offset uint64) error {
	f.mu.Lock()
	failed := f.failed
	f.mu.Unlock()
	if failed == nil {
		// Written last, in the same transaction: the cursor never covers
		// a frame whose rows are not stored, and rows are never stored
		// for a frame the cursor does not cover.
		_ = f.s.run(ctx, func(ctx context.Context) error {
			return f.s.recordLifecycleApplied(ctx, sessionID, offset)
		})
	}
	return f.finish(ctx, sessionID)
}

// finish commits the frame, or rolls it back when anything in it failed.
func (f *lifecycleFrame) finish(ctx context.Context, sessionID string) error {
	f.mu.Lock()
	f.ended = true
	if f.stop != nil {
		f.stop()
	}
	tx, failed, began := f.tx, f.failed, f.began
	if tx != nil {
		f.held = time.Since(began)
	}
	f.mu.Unlock()
	if f.release != nil {
		f.release()
	}
	defer enforceFileModes(f.s.path)
	if tx == nil {
		if failed != nil {
			return fmt.Errorf("%w: %w", ErrLifecycleFrameFailed, failed)
		}
		return nil
	}
	if failed != nil {
		_ = tx.Rollback()
		return fmt.Errorf("%w: %w", ErrLifecycleFrameFailed, failed)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: %w", ErrLifecycleFrameFailed, err)
	}
	// The hold, measured: first write to commit. The number the bound is
	// judged against.
	log.From(ctx).Debug("lifecycle frame committed", "session", sessionID, "held_us", time.Since(began).Microseconds())
	return nil
}
