package note

import (
	"context"
	"time"
)

// Service is what the transport talks to: ids and clocks are the backend's,
// exactly as they are for snippets (the client mints neither).
type Service struct {
	store Store
	newID func() string
	now   func() time.Time
}

// NewService wires the service. `newID` and `now` are injected because a
// test that cannot control them tests the clock instead of the behaviour.
func NewService(store Store, newID func() string, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{store: store, newID: newID, now: now}
}

func (s *Service) List(ctx context.Context) ([]Row, error) { return s.store.List(ctx) }

func (s *Service) Get(ctx context.Context, id string) (Note, error) { return s.store.Get(ctx, id) }

func (s *Service) Search(ctx context.Context, query string) ([]Row, error) {
	return s.store.Search(ctx, query)
}

// Create makes a note. An EMPTY body is legal and is the common case: the
// chord opens a note and the person types into it, so refusing an empty one
// would refuse the feature's whole point.
func (s *Service) Create(ctx context.Context, body string) (Note, error) {
	at := s.now().UnixMilli()
	return s.store.Create(ctx, Note{
		ID:        s.newID(),
		Body:      body,
		CreatedAt: at,
		UpdatedAt: at,
	})
}

// Update replaces the body and stamps the edit. created_at is the store's
// to keep — an edit is not a new note.
func (s *Service) Update(ctx context.Context, id, body string) (Note, error) {
	return s.store.Update(ctx, Note{ID: id, Body: body, UpdatedAt: s.now().UnixMilli()})
}

func (s *Service) Delete(ctx context.Context, id string) error { return s.store.Delete(ctx, id) }
