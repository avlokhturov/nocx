package snippet_test

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/snippet"
	"github.com/shady2k/nocx/internal/storage"
)

// fakeDocStore implements storage.DocumentStore — all THREE methods. Every
// external call this store makes has a failing case here (AGENTS.md rule 3).
type fakeDocStore struct {
	mu       sync.Mutex
	doc      []byte
	found    bool
	readErr  error
	writeErr error
	writes   int
}

func (f *fakeDocStore) Read(_ string, into any) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return false, f.readErr
	}
	if !f.found {
		return false, nil
	}
	return true, json.Unmarshal(f.doc, into)
}

func (f *fakeDocStore) Write(_ string, doc any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return f.writeErr
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	f.writes++
	f.doc = b
	f.found = true
	return nil
}

func (f *fakeDocStore) Delete(_ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.found, f.doc = false, nil
	return nil
}

func TestLoadAllOnMissingDocumentIsEmpty(t *testing.T) {
	s := snippet.NewJSONStore(&fakeDocStore{}, snippet.DocumentName)
	got, err := s.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty, got %d", len(got))
	}
}

func TestSaveAllThenLoadAllPreservesOrder(t *testing.T) {
	s := snippet.NewJSONStore(&fakeDocStore{}, snippet.DocumentName)
	if err := s.SaveAll([]snippet.Snippet{
		{ID: "b", Title: "second", Body: "two"},
		{ID: "a", Title: "first", Body: "one"},
	}); err != nil {
		t.Fatalf("SaveAll: %v", err)
	}
	got, err := s.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(got) != 2 || got[0].ID != "b" || got[1].ID != "a" {
		t.Fatalf("order lost: %+v", got)
	}
}

func TestLoadAllPropagatesReadError(t *testing.T) {
	boom := errors.New("disk gone")
	s := snippet.NewJSONStore(&fakeDocStore{readErr: boom}, snippet.DocumentName)
	if _, err := s.LoadAll(); !errors.Is(err, boom) {
		t.Fatalf("want the read error, got %v", err)
	}
}

func TestSaveAllPropagatesWriteError(t *testing.T) {
	boom := errors.New("read-only fs")
	s := snippet.NewJSONStore(&fakeDocStore{writeErr: boom}, snippet.DocumentName)
	if err := s.SaveAll([]snippet.Snippet{{ID: "a"}}); !errors.Is(err, boom) {
		t.Fatalf("want the write error, got %v", err)
	}
}

// A document from a FUTURE version is refused, not read: reading it would
// silently drop fields this build does not know about and then write them away.
func TestLoadAllRejectsANewerDocument(t *testing.T) {
	f := &fakeDocStore{found: true, doc: []byte(`{"schemaVersion":99,"snippets":[]}`)}
	s := snippet.NewJSONStore(f, snippet.DocumentName)
	if _, err := s.LoadAll(); !errors.Is(err, storage.ErrVersionTooNew) {
		t.Fatalf("want ErrVersionTooNew, got %v", err)
	}
}

func TestSaveAllIsSafeUnderConcurrentCallers(t *testing.T) {
	s := snippet.NewJSONStore(&fakeDocStore{}, snippet.DocumentName)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.SaveAll([]snippet.Snippet{{ID: "a"}})
			_, _ = s.LoadAll()
		}()
	}
	wg.Wait()
}
