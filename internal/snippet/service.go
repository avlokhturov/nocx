package snippet

import (
	"errors"
	"sync"
)

var (
	ErrNotFound        = errors.New("snippet not found")
	ErrNotAPermutation = errors.New("reorder ids are not a permutation of the stored list")
)

// Service owns the policy over the store: ids are minted here, a reorder must
// be a permutation, and seeding happens exactly once.
type Service struct {
	store Store
	newID func() string
	mu    sync.Mutex
}

// NewService takes its id source rather than calling crypto/rand directly:
// an injected generator gives the collision case a test, and gives a
// generation failure somewhere to go other than a panic.
func NewService(store Store, newID func() string) *Service {
	return &Service{store: store, newID: newID}
}

// seeds are two ordinary records written when the document is first created.
// They are not built-ins: no override layer, no restore, no reset. Their only
// job is to teach the placeholder syntax at the moment the library would
// otherwise be empty (design §5.3).
func (s *Service) seeds() []Snippet {
	return []Snippet{
		{
			ID:    s.newID(),
			Title: "Explain this branch",
			Body:  "Explain what changed in {{env:branch}} under {{env:cwd}}.",
		},
		{
			ID:    s.newID(),
			Title: "Forward a port",
			Body:  "ssh -L {{ask:local=8080}}:localhost:{{ask:remote=8080}} {{env:host}}",
		},
	}
}

// ensureSeededLocked writes the seed records if the document has never
// existed. Caller holds s.mu.
func (s *Service) ensureSeededLocked() error {
	exists, err := s.store.Exists()
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return s.store.SaveAll(s.seeds())
}

func (s *Service) List() ([]Snippet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureSeededLocked(); err != nil {
		return nil, err
	}
	return s.store.LoadAll()
}

func (s *Service) Create(title, body string) (Snippet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureSeededLocked(); err != nil {
		return Snippet{}, err
	}
	list, err := s.store.LoadAll()
	if err != nil {
		return Snippet{}, err
	}
	created := Snippet{ID: s.newID(), Title: title, Body: body}
	if err := s.store.SaveAll(append(list, created)); err != nil {
		return Snippet{}, err
	}
	return created, nil
}

func (s *Service) Update(id, title, body string) (Snippet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.store.LoadAll()
	if err != nil {
		return Snippet{}, err
	}
	for i := range list {
		if list[i].ID != id {
			continue
		}
		list[i].Title, list[i].Body = title, body
		if err := s.store.SaveAll(list); err != nil {
			return Snippet{}, err
		}
		return list[i], nil
	}
	return Snippet{}, ErrNotFound
}

func (s *Service) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.store.LoadAll()
	if err != nil {
		return err
	}
	out := make([]Snippet, 0, len(list))
	found := false
	for _, sn := range list {
		if sn.ID == id {
			found = true
			continue
		}
		out = append(out, sn)
	}
	if !found {
		return ErrNotFound
	}
	return s.store.SaveAll(out)
}

// Reorder takes the FULL id list and rejects anything that is not a
// permutation of what is stored. The whole check runs before any write, so a
// rejected reorder leaves the document byte-identical rather than
// half-applied — a partial reorder is how two clients silently drop a record.
func (s *Service) Reorder(ids []string) ([]Snippet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.store.LoadAll()
	if err != nil {
		return nil, err
	}
	if len(ids) != len(list) {
		return nil, ErrNotAPermutation
	}
	byID := make(map[string]Snippet, len(list))
	for _, sn := range list {
		byID[sn.ID] = sn
	}
	out := make([]Snippet, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		sn, ok := byID[id]
		if !ok {
			return nil, ErrNotAPermutation
		}
		if _, dup := seen[id]; dup {
			return nil, ErrNotAPermutation
		}
		seen[id] = struct{}{}
		out = append(out, sn)
	}
	if err := s.store.SaveAll(out); err != nil {
		return nil, err
	}
	return out, nil
}
