package note_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/note"
)

// memStore is the Store seam in memory. Every method has a failure switch,
// because every external call this service makes needs a test where it
// fails (AGENTS.md rule 3).
type memStore struct {
	notes   []note.Note
	listErr error
	saveErr error
}

func (m *memStore) List(context.Context) ([]note.Row, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	out := []note.Row{}
	for _, n := range m.notes {
		out = append(out, note.Row{ID: n.ID, Title: note.DeriveTitle(n.Body), UpdatedAt: n.UpdatedAt})
	}
	return out, nil
}

func (m *memStore) Get(_ context.Context, id string) (note.Note, error) {
	for _, n := range m.notes {
		if n.ID == id {
			return n, nil
		}
	}
	return note.Note{}, note.ErrNotFound
}

func (m *memStore) Create(_ context.Context, n note.Note) (note.Note, error) {
	if m.saveErr != nil {
		return note.Note{}, m.saveErr
	}
	m.notes = append(m.notes, n)
	return n, nil
}

func (m *memStore) Update(_ context.Context, n note.Note) (note.Note, error) {
	if m.saveErr != nil {
		return note.Note{}, m.saveErr
	}
	for i, existing := range m.notes {
		if existing.ID != n.ID {
			continue
		}
		m.notes[i].Body = n.Body
		m.notes[i].UpdatedAt = n.UpdatedAt
		return m.notes[i], nil
	}
	return note.Note{}, note.ErrNotFound
}

func (m *memStore) Delete(_ context.Context, id string) error {
	for i, n := range m.notes {
		if n.ID == id {
			m.notes = append(m.notes[:i], m.notes[i+1:]...)
			return nil
		}
	}
	return note.ErrNotFound
}

func (m *memStore) Search(_ context.Context, query string) ([]note.Row, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	_ = query
	return []note.Row{}, nil
}

// LoadAll and ReplaceAll are the BACKUP's pair (spec §10). The fake carries
// them so the seam is one interface rather than two, and so a backup test
// that reaches for this store gets the same failure switches.
func (m *memStore) LoadAll(context.Context) ([]note.Note, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	return append([]note.Note(nil), m.notes...), nil
}

func (m *memStore) ReplaceAll(_ context.Context, notes []note.Note) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	m.notes = append([]note.Note(nil), notes...)
	return nil
}

func (m *memStore) Close() error { return nil }

func counter() func() string {
	n := 0
	return func() string { n++; return fmt.Sprintf("id-%d", n) }
}

func fixedClock(ms int64) func() time.Time {
	return func() time.Time { return time.UnixMilli(ms) }
}

func TestCreateMintsTheIdAndBothStamps(t *testing.T) {
	m := &memStore{}
	svc := note.NewService(m, counter(), fixedClock(1_700_000_000_000))
	created, err := svc.Create(context.Background(), "hello")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID != "id-1" {
		t.Fatalf("the backend mints the id: got %q", created.ID)
	}
	if created.CreatedAt != 1_700_000_000_000 || created.UpdatedAt != 1_700_000_000_000 {
		t.Fatalf("both stamps come from the clock: %+v", created)
	}
}

func TestAnEmptyNoteIsLegal(t *testing.T) {
	// The chord creates a note and the person types into it — refusing an
	// empty body would refuse the feature's whole point (spec §6.3).
	m := &memStore{}
	svc := note.NewService(m, counter(), fixedClock(1))
	created, err := svc.Create(context.Background(), "")
	if err != nil {
		t.Fatalf("an empty note must be creatable: %v", err)
	}
	if note.DeriveTitle(created.Body) != "" {
		t.Fatal("an empty body has no derived title; the surface names it with a date")
	}
}

func TestUpdateStampsTheEditAndNotTheCreation(t *testing.T) {
	m := &memStore{notes: []note.Note{{ID: "a", Body: "one", CreatedAt: 5, UpdatedAt: 5}}}
	svc := note.NewService(m, counter(), fixedClock(99))
	updated, err := svc.Update(context.Background(), "a", "two")
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.UpdatedAt != 99 {
		t.Fatalf("the edit is stamped: %+v", updated)
	}
	if updated.CreatedAt != 5 {
		t.Fatalf("an edit is not a new note: %+v", updated)
	}
}

func TestUpdateOfAMissingNoteIsNotFound(t *testing.T) {
	svc := note.NewService(&memStore{}, counter(), fixedClock(1))
	if _, err := svc.Update(context.Background(), "gone", "x"); !errors.Is(err, note.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestAFailingStoreIsReportedAndNotSwallowed(t *testing.T) {
	// The paired failure for every call the service makes: what the store
	// says goes to the caller, so the surface can say it too.
	boom := errors.New("disk is gone")
	svc := note.NewService(&memStore{saveErr: boom, listErr: boom}, counter(), fixedClock(1))
	ctx := context.Background()
	if _, err := svc.Create(ctx, "x"); !errors.Is(err, boom) {
		t.Fatalf("create: want the store's error, got %v", err)
	}
	if _, err := svc.Update(ctx, "a", "x"); !errors.Is(err, boom) {
		t.Fatalf("update: want the store's error, got %v", err)
	}
	if _, err := svc.List(ctx); !errors.Is(err, boom) {
		t.Fatalf("list: want the store's error, got %v", err)
	}
	if _, err := svc.Search(ctx, "q"); !errors.Is(err, boom) {
		t.Fatalf("search: want the store's error, got %v", err)
	}
}

func TestDeriveTitle(t *testing.T) {
	cases := map[string]struct{ body, want string }{
		"first line":            {"deploy the thing\nand then some", "deploy the thing"},
		"markdown heading":      {"# Deploy\n\nbody", "Deploy"},
		"deeper heading":        {"### Deploy notes", "Deploy notes"},
		"leading blank lines":   {"\n\n  spaced out  \nmore", "spaced out"},
		"empty body":            {"", ""},
		"whitespace only":       {"\n   \n\t\n", ""},
		"hashes only, keeps on": {"###\n\nthe real first line", "the real first line"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := note.DeriveTitle(c.body); got != c.want {
				t.Fatalf("DeriveTitle(%q) = %q, want %q", c.body, got, c.want)
			}
		})
	}
}

func TestDeriveTitleIsBounded(t *testing.T) {
	long := ""
	for range 200 {
		long += "ы"
	}
	got := note.DeriveTitle(long)
	if len([]rune(got)) > 81 { // 80 runes plus the ellipsis that says it was cut
		t.Fatalf("title is unbounded: %d runes", len([]rune(got)))
	}
	if !hasSuffixRune(got, '…') {
		t.Fatalf("a cut title says it was cut: %q", got)
	}
}

func hasSuffixRune(s string, r rune) bool {
	runes := []rune(s)
	return len(runes) > 0 && runes[len(runes)-1] == r
}
