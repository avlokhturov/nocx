package content_test

import (
	"context"
	"errors"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/log"
)

// Compile-time: Stub implements ContentDB.
var _ content.ContentDB = (*content.Stub)(nil)

type testLogger struct{}

func (l *testLogger) Debug(msg string, args ...any)              {}
func (l *testLogger) Info(msg string, args ...any)               {}
func (l *testLogger) Warn(msg string, args ...any)               {}
func (l *testLogger) Error(msg string, args ...any)              {}
func (l *testLogger) With(args ...any) log.Logger                { return l }
func (l *testLogger) WithContext(ctx context.Context) log.Logger { return l }

func TestNewStub(t *testing.T) {
	s := content.NewStub(&testLogger{})
	if s == nil {
		t.Fatal("NewStub returned nil")
	}
}

func TestStubConversationsReturnsNonNil(t *testing.T) {
	cr := content.NewStub(&testLogger{}).Conversations()
	if cr == nil {
		t.Fatal("Conversations() returned nil")
	}
}

func TestStubCommandHistoryReturnsNonNil(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	if chr == nil {
		t.Fatal("CommandHistory() returned nil")
	}
}

func TestStubCloseReturnsNil(t *testing.T) {
	s := content.NewStub(&testLogger{})
	if err := s.Close(); err != nil {
		t.Errorf("Close() returned error: %v", err)
	}
}

// ── ConversationRepository stub method tests ──

func TestConversationSaveReturnsSentinel(t *testing.T) {
	cr := content.NewStub(&testLogger{}).Conversations()
	err := cr.Save(context.Background(), content.Conversation{ID: "c1"})
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestConversationGetByIDReturnsSentinel(t *testing.T) {
	cr := content.NewStub(&testLogger{}).Conversations()
	_, err := cr.GetByID(context.Background(), "c1")
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestConversationListReturnsSentinel(t *testing.T) {
	cr := content.NewStub(&testLogger{}).Conversations()
	_, err := cr.List(context.Background(), 10)
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

// ── CommandHistoryRepository stub method tests ──

func TestCommandHistoryAddReturnsSentinel(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	err := chr.Add(context.Background(), content.CommandRecord{Command: "ls"})
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestCommandHistoryListReturnsSentinel(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	_, err := chr.List(context.Background(), 10)
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestCommandHistoryGetByIDReturnsSentinel(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	_, err := chr.GetByID(context.Background(), 1)
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestCommandHistoryFindByPrefixReturnsSentinel(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	_, err := chr.FindByPrefix(context.Background(), "git", 5)
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}

func TestCommandHistoryQueryReturnsSentinel(t *testing.T) {
	chr := content.NewStub(&testLogger{}).CommandHistory()
	_, err := chr.Query(context.Background(), content.ScopeDirectory, "/repo", "", 10, nil)
	if !errors.Is(err, content.ErrNotImplemented) {
		t.Errorf("expected ErrNotImplemented, got %v", err)
	}
}
