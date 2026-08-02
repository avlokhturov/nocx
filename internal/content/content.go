// Package content declares the ContentDB capability and the typed repository
// seams for AI agent conversations and command history.
//
// # SQLite implementation conditions
//
// The real implementation is deferred until the first feature needs it (agent-mode
// epic nocx-dw3 or command history nocx-4ff.6, whichever lands first). When it
// arrives, these rules apply:
//
//   - One database: content.db (not one per entity).
//   - WAL journal mode, because surviving a force-quit is the whole reason a
//     desktop application takes a database at all.
//   - foreign_keys=ON at connection open.
//   - Short transactions through a single controlled write path; no long-lived
//     or concurrent write transactions.
//   - Honesty constraint: ordinary DELETE leaves data in WAL pages, freelists
//     and FTS shadow tables. The UI says "removed from nocx", not "securely
//     erased", unless and until checkpointing and vacuum are implemented
//     deliberately.
//
// No generic Repository[T] — each entity declares its own typed repository
// interface (ADR-0011 §1).
package content

import (
	"context"
	"errors"
)

// ErrNotImplemented is the sentinel error returned by every Stub method.
var ErrNotImplemented = errors.New("content stub: not implemented")

// ErrClosed is returned by operations on a ContentDB that has been Closed.
var ErrClosed = errors.New("content: store is closed")

// ContentDB is the capability for unbounded, query-oriented private content
// (ADR-0011 §5). It owns a single SQLite database and exposes typed repository
// interfaces for each entity class.
type ContentDB interface {
	Conversations() ConversationRepository
	CommandHistory() CommandHistoryRepository
	// Backup writes a consistent, encrypted snapshot of the whole database
	// to destPath. The destination is created through the same keyed VFS as
	// the live database (ADR-0018 amendment — the plaintext-canary rule), so
	// a restore is: replace content.db with the snapshot and open with the
	// same key. This is the only supported way to copy the database: WAL
	// mode means the live store is content.db plus -wal plus -shm, and
	// copying the single file while running produces a torn backup.
	Backup(ctx context.Context, destPath string) error
	Close() error
}

// CommandStatus is the execution status of a command. It mirrors the closed
// set in frontend/src/command-ledger.ts:10.
type CommandStatus string

const (
	StatusRunning     CommandStatus = "running"
	StatusSuccess     CommandStatus = "success"
	StatusFailure     CommandStatus = "failure"
	StatusInterrupted CommandStatus = "interrupted"
	StatusUnknown     CommandStatus = "unknown"
)

// CommandRecord mirrors frontend/src/command-ledger.ts:12-25.
// Nullable TS fields (exitCode, startedAt, endedAt) use pointers:
// nil means "not set," matching TypeScript null without a sentinel value.
// Output bytes are never retained here (ADR-0008); that is nocx-de7's job.
type CommandRecord struct {
	ID        int64
	Command   string
	Cwd       string
	Host      string
	Status    CommandStatus
	ExitCode  *int
	StartedAt *int64
	EndedAt   *int64
	Trusted   bool
}

// Scope is the recall-ladder rung a history query is answered from (design
// §10.6). The server answers from the rung it was asked for and never
// silently widens: a ladder whose rung you cannot see is a filter.
type Scope string

const (
	ScopeDirectory  Scope = "directory"  // the exact working directory
	ScopeHost       Scope = "host"       // the exact host; "" is the local machine
	ScopeEverywhere Scope = "everywhere" // no rung filter
)

// HistoryPage is one page of command history, newest first.
type HistoryPage struct {
	// Entries is the page. Never nil: no matches is an empty slice
	// (contracts/history.query.schema.json: "Never null: no matches is []").
	Entries []CommandRecord
	// Exhausted is true when no further entries exist beyond this page.
	Exhausted bool
	// HasRows reports whether the store holds any rows at all, read in the
	// same transaction as the page. The transport uses it to tell "the
	// store answered and had nothing" (source=store, entries=[]) from "the
	// store has nothing to answer from" (source=session): an empty answer
	// and an unanswerable question must not look alike.
	HasRows bool
	// Coverage is the store-wide horizon the answer can see: the oldest
	// retained entry's ended_at, in Unix milliseconds, regardless of the
	// rung or the text filter (retention is store-wide, so the horizon is
	// too). The overlay renders it so a search under retention does not
	// present a partial history as the whole one. Nil when the store holds
	// no completed rows — nothing to state a horizon for.
	Coverage *int64
}

// Conversation is a conversation with an AI agent.
type Conversation struct {
	ID        string
	Title     string
	CreatedAt int64
	Messages  []Message
}

// Message is a single message within a conversation.
type Message struct {
	Role      string
	Content   string
	Timestamp int64
}

// ConversationRepository is the typed repository for AI agent conversations.
type ConversationRepository interface {
	Save(ctx context.Context, conv Conversation) error
	GetByID(ctx context.Context, id string) (*Conversation, error)
	List(ctx context.Context, limit int) ([]Conversation, error)
}

// CommandHistoryRepository is the typed repository for command history.
type CommandHistoryRepository interface {
	Add(ctx context.Context, record CommandRecord) error
	List(ctx context.Context, limit int) ([]CommandRecord, error)
	GetByID(ctx context.Context, id int64) (*CommandRecord, error)
	FindByPrefix(ctx context.Context, prefix string, limit int) ([]CommandRecord, error)
	// Query returns one page of command history for the given recall-ladder
	// rung, newest first. cwd is required for ScopeDirectory, host for
	// ScopeHost (both ignored for ScopeEverywhere). before, when non-nil, is
	// the opaque row id (the string form of a CommandRecord.ID) the previous
	// page ended at; the page contains only rows strictly older than it.
	// limit must be >= 1. text is the search filter (nocx-ms7v): a
	// case-insensitive substring over command, applied WITHIN the rung the
	// caller asked for — the server never silently widens. Empty or absent
	// means no filter. The page's Coverage is store-wide and independent of
	// both the rung and the filter.
	Query(ctx context.Context, scope Scope, cwd, host string, limit int, before *int64, text string) (HistoryPage, error)
}
