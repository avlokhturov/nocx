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

// ContentDB is the capability for unbounded, query-oriented private content
// (ADR-0011 §5). It owns a single SQLite database and exposes typed repository
// interfaces for each entity class.
type ContentDB interface {
	Conversations() ConversationRepository
	CommandHistory() CommandHistoryRepository
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
}
