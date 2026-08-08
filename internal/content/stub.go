package content

import (
	"context"

	"github.com/shady2k/nocx/internal/log"
)

// Stub is the no-op implementation of ContentDB. Every repository method logs
// the call and returns ErrNotImplemented. It exists so the seam compiles and
// can be injected before the SQLite implementation lands.
type Stub struct {
	log log.Logger
}

// NewStub creates a Stub that logs calls through logger.
func NewStub(logger log.Logger) *Stub {
	return &Stub{log: logger}
}

// convStub implements ConversationRepository for the stub.
type convStub struct {
	log log.Logger
}

func (s *convStub) Save(_ context.Context, conv Conversation) error {
	s.log.Info("content stub: ConversationRepository.Save", "id", conv.ID)
	return ErrNotImplemented
}

func (s *convStub) GetByID(_ context.Context, id string) (*Conversation, error) {
	s.log.Info("content stub: ConversationRepository.GetByID", "id", id)
	return nil, ErrNotImplemented
}

func (s *convStub) List(_ context.Context, limit int) ([]Conversation, error) {
	s.log.Info("content stub: ConversationRepository.List", "limit", limit)
	return nil, ErrNotImplemented
}

// histStub implements CommandHistoryRepository for the stub.
type histStub struct {
	log log.Logger
}

func (s *histStub) Add(_ context.Context, record CommandRecord) (int64, error) {
	s.log.Info("content stub: CommandHistoryRepository.Add", "command", record.Command)
	return 0, ErrNotImplemented
}

func (s *histStub) List(_ context.Context, limit int) ([]CommandRecord, error) {
	s.log.Info("content stub: CommandHistoryRepository.List", "limit", limit)
	return nil, ErrNotImplemented
}

func (s *histStub) GetByID(_ context.Context, id int64) (*CommandRecord, error) {
	s.log.Info("content stub: CommandHistoryRepository.GetByID", "id", id)
	return nil, ErrNotImplemented
}

func (s *histStub) FindByPrefix(_ context.Context, prefix string, limit int) ([]CommandRecord, error) {
	s.log.Info("content stub: CommandHistoryRepository.FindByPrefix", "prefix", prefix, "limit", limit)
	return nil, ErrNotImplemented
}

func (s *histStub) RewriteRedaction(_ context.Context, id int64, span Redaction, reference string) error {
	s.log.Info("content stub: CommandHistoryRepository.RewriteRedaction", "id", id, "span", span, "reference", reference)
	return ErrNotImplemented
}

func (s *histStub) Query(_ context.Context, scope Scope, cwd, host string, limit int, _ *int64, text string) (HistoryPage, error) {
	s.log.Info("content stub: CommandHistoryRepository.Query", "scope", scope, "cwd", cwd, "host", host, "limit", limit, "text", text)
	return HistoryPage{}, ErrNotImplemented
}

// Conversations returns a stub ConversationRepository.
func (s *Stub) Conversations() ConversationRepository {
	s.log.Info("content stub: Conversations called (no-op)")
	return &convStub{log: s.log}
}

// CommandHistory returns a stub CommandHistoryRepository.
func (s *Stub) CommandHistory() CommandHistoryRepository {
	s.log.Info("content stub: CommandHistory called (no-op)")
	return &histStub{log: s.log}
}

// Backup returns ErrNotImplemented: the stub has nothing to snapshot.
func (s *Stub) Backup(_ context.Context, destPath string) error {
	s.log.Info("content stub: Backup called (no-op)", "dest", destPath)
	return ErrNotImplemented
}

// RestorePrivate returns ErrNotImplemented: the stub stores nothing.
func (s *Stub) RestorePrivate(_ context.Context, conversations []Conversation, history []CommandRecord) error {
	s.log.Info("content stub: RestorePrivate called (no-op)", "conversations", len(conversations), "history", len(history))
	return ErrNotImplemented
}

// Close is a no-op.
func (s *Stub) Close() error {
	s.log.Info("content stub: Close called (no-op)")
	return nil
}
