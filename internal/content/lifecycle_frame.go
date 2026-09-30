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
)

// querier is the statement surface *sql.DB and *sql.Tx share.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
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
func (s *sqliteContent) conn(ctx context.Context) querier {
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
	return tx, nil
}

// write runs one store write inside the frame.
func (f *lifecycleFrame) write(ctx context.Context, fn func(ctx context.Context) error) error {
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

// ErrLifecycleFrameFailed wraps the first store failure of a frame that
// committed nothing.
var ErrLifecycleFrameFailed = errors.New("content: the lifecycle frame was not applied")

// ApplyLifecycleFrame implements LedgerRepository: apply's store writes and
// the session's lifecycle cursor at offset commit as one transaction, or
// none of them does.
func (s *sqliteContent) ApplyLifecycleFrame(ctx context.Context, sessionID string, offset uint64, apply func(ctx context.Context) error) error {
	if s.frameOf(ctx) != nil {
		return errors.New("content: a lifecycle frame cannot nest inside another")
	}
	f := &lifecycleFrame{s: s}
	fctx := context.WithValue(ctx, lifecycleFrameKey{}, f)
	if err := apply(fctx); err != nil {
		f.fail(err)
	}
	f.mu.Lock()
	failed := f.failed
	f.mu.Unlock()
	if failed == nil {
		// Written last, in the same transaction: the cursor never covers
		// a frame whose rows are not stored, and rows are never stored
		// for a frame the cursor does not cover.
		_ = s.run(fctx, func(ctx context.Context) error {
			return s.recordLifecycleApplied(ctx, sessionID, offset)
		})
	}
	return f.finish()
}

// finish commits the frame, or rolls it back when anything in it failed.
func (f *lifecycleFrame) finish() error {
	f.mu.Lock()
	tx, failed := f.tx, f.failed
	f.tx = nil
	f.mu.Unlock()
	defer enforceFileModes(f.s.path)
	if failed != nil {
		if tx != nil {
			_ = tx.Rollback()
		}
		return fmt.Errorf("%w: %w", ErrLifecycleFrameFailed, failed)
	}
	if tx == nil {
		return nil
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: %w", ErrLifecycleFrameFailed, err)
	}
	return nil
}
