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
