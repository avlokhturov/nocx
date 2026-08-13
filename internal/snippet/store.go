package snippet

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/shady2k/nocx/internal/storage"
)

const DocumentName = "snippets.json"

// Module declares this document's own monotonic schema version (ADR-0011 §6).
// One version, no migrations: the format is new, and a chain grows when a
// format changes rather than in anticipation.
var Module = storage.Module{Name: "snippets", Current: 1}

type Store interface {
	LoadAll() ([]Snippet, error)
	SaveAll(snippets []Snippet) error
	// Exists reports whether the document is on disk. Seeding keys off
	// creation, not emptiness (design §5.3).
	Exists() (bool, error)
}

type JSONStore struct {
	docStore storage.DocumentStore
	fileName string
	mu       sync.Mutex
}

func NewJSONStore(docStore storage.DocumentStore, fileName string) *JSONStore {
	return &JSONStore{docStore: docStore, fileName: fileName}
}

type storeData struct {
	SchemaVersion storage.SchemaVersion `json:"schemaVersion"`
	Snippets      []Snippet             `json:"snippets"`
}

// readLocked reads the raw document, runs it through the module's version
// protocol, then decodes. Caller holds s.mu.
func (s *JSONStore) readLocked() (storeData, bool, error) {
	var raw json.RawMessage
	found, err := s.docStore.Read(s.fileName, &raw)
	if err != nil {
		return storeData{}, false, fmt.Errorf("read snippet store: %w", err)
	}
	if !found {
		return storeData{}, false, nil
	}
	var probe struct {
		SchemaVersion storage.SchemaVersion `json:"schemaVersion"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return storeData{}, false, fmt.Errorf("read snippet store: %w", err)
	}
	migrated, err := Module.Migrate(raw, probe.SchemaVersion)
	if err != nil {
		return storeData{}, false, err
	}
	var d storeData
	if err := json.Unmarshal(migrated, &d); err != nil {
		return storeData{}, false, fmt.Errorf("read snippet store: %w", err)
	}
	return d, true, nil
}

func (s *JSONStore) LoadAll() ([]Snippet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, found, err := s.readLocked()
	if err != nil {
		return nil, err
	}
	if !found || d.Snippets == nil {
		return []Snippet{}, nil
	}
	return d.Snippets, nil
}

func (s *JSONStore) SaveAll(snippets []Snippet) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if snippets == nil {
		snippets = []Snippet{}
	}
	if err := s.docStore.Write(s.fileName, storeData{
		SchemaVersion: Module.Current,
		Snippets:      snippets,
	}); err != nil {
		return fmt.Errorf("write snippet store: %w", err)
	}
	return nil
}

func (s *JSONStore) Exists() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, found, err := s.readLocked()
	return found, err
}
