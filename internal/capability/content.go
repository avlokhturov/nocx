package capability

import (
	"context"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/transport/control"
)

// ContentService is the content domain surface: the durable command-history
// store (ADR-0011 §5). It is what a ContentOperation hands its callback.
// Read policy: reads participate in the content gate — the store is one
// database and history.record writes rows the query reads.
type ContentService interface {
	// QueryHistory serves history.query: one page of the recall ladder.
	QueryHistory(ctx context.Context, scope content.Scope, cwd, host string, limit int, before *int64, text string) (content.HistoryPage, error)
	// RecordCommand stores one completed command's facts (history.record)
	// and returns the backend-assigned row id. When the live History
	// policy is off, Add succeeds and returns (0, nil) — a command runs
	// and no row appears, never an error.
	RecordCommand(ctx context.Context, rec content.CommandRecord) (int64, error)
	// The capture-save link rewrite is NOT here. It is one behaviour with
	// one seam — CaptureSaveService.RewriteRedaction, which is the only
	// thing secrets.captureSave ever reached — and the copy that used to sit
	// on this interface had no caller at all (AD-8: a second surface for one
	// behaviour goes out of step with the first the moment either changes).
}

// ContentOperation is the typed operation for the content domain. Its gate
// is [content].
type ContentOperation interface {
	Run(context.Context, func(context.Context, ContentService) error) error
}

// NewContentOperation builds a ContentOperation that acquires the content
// gate before the execution lane.
func NewContentOperation(contentGate, lane control.Admission, db content.ContentDB) ContentOperation {
	g := &guard{}
	return newOperation[ContentService](control.NewComposite(contentGate, lane), g, newContentService(g, db))
}

// newContentService builds the concrete content service bound to guard g.
func newContentService(g *guard, db content.ContentDB) *contentService {
	return &contentService{guard: g, db: db}
}

type contentService struct {
	guard *guard
	db    content.ContentDB
}

func (s *contentService) QueryHistory(ctx context.Context, scope content.Scope, cwd, host string, limit int, before *int64, text string) (content.HistoryPage, error) {
	if err := s.guard.check(); err != nil {
		return content.HistoryPage{}, err
	}
	return s.db.CommandHistory().Query(ctx, scope, cwd, host, limit, before, text)
}

func (s *contentService) RecordCommand(ctx context.Context, rec content.CommandRecord) (int64, error) {
	if err := s.guard.check(); err != nil {
		return 0, err
	}
	return s.db.CommandHistory().Add(ctx, rec)
}
