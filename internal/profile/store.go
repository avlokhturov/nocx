package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ProfileStore is the persistence interface for profiles, groups, and credentials.
// The single owner of profile/group/credential CRUD (mirrors Tabby's ProfilesService).
type ProfileStore interface {
	LoadProfiles() ([]SSHProfile, error)
	SaveProfile(p SSHProfile) error
	DeleteProfile(id string) error
	LoadGroups() ([]ProfileGroup, error)
	SaveGroup(g ProfileGroup) error
	DeleteGroup(id string) error
	LoadCredentials() ([]Credential, error)
	SaveCredential(c Credential) error
	DeleteCredential(id string) error
}

// JSONStore persists profiles and groups to a single JSON file on disk.
// The file format is:
//
//	{ "profiles": [...], "groups": [...] }
//
// Writes are atomic (temp file + rename) to prevent corruption on crash.
type JSONStore struct {
	path string
	mu   sync.Mutex
}

// NewJSONStore creates a JSONStore rooted at path.
func NewJSONStore(path string) *JSONStore {
	return &JSONStore{path: path}
}

// storeData is the on-disk JSON shape.
type storeData struct {
	Profiles    []SSHProfile   `json:"profiles,omitempty"`
	Groups      []ProfileGroup `json:"groups,omitempty"`
	Credentials []Credential   `json:"credentials,omitempty"`
}

func (s *JSONStore) load() (*storeData, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &storeData{}, nil
		}
		return nil, fmt.Errorf("read profile store %s: %w", s.path, err)
	}
	if len(raw) == 0 {
		return &storeData{}, nil
	}
	var d storeData
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("parse profile store %s: %w", s.path, err)
	}
	return &d, nil
}

func (s *JSONStore) save(d *storeData) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("mkdir for profile store: %w", err)
	}

	raw, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal profile store: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".profiles-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("rename temp to %s: %w", s.path, err)
	}
	return nil
}

func (s *JSONStore) LoadProfiles() ([]SSHProfile, error) {
	d, err := s.load()
	if err != nil {
		return nil, err
	}
	return d.Profiles, nil
}

func (s *JSONStore) SaveProfile(p SSHProfile) error {
	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Profiles {
		if existing.ID == p.ID {
			d.Profiles[i] = p
			return s.save(d)
		}
	}
	d.Profiles = append(d.Profiles, p)
	return s.save(d)
}

func (s *JSONStore) DeleteProfile(id string) error {
	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Profiles {
		if existing.ID == id {
			d.Profiles = append(d.Profiles[:i], d.Profiles[i+1:]...)
			return s.save(d)
		}
	}
	return nil
}

func (s *JSONStore) LoadGroups() ([]ProfileGroup, error) {
	d, err := s.load()
	if err != nil {
		return nil, err
	}
	return d.Groups, nil
}

func (s *JSONStore) SaveGroup(g ProfileGroup) error {
	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Groups {
		if existing.ID == g.ID {
			d.Groups[i] = g
			return s.save(d)
		}
	}
	d.Groups = append(d.Groups, g)
	return s.save(d)
}

func (s *JSONStore) DeleteGroup(id string) error {
	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Groups {
		if existing.ID == id {
			d.Groups = append(d.Groups[:i], d.Groups[i+1:]...)
			return s.save(d)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Credential CRUD
// ---------------------------------------------------------------------------

func (s *JSONStore) LoadCredentials() ([]Credential, error) {
	d, err := s.load()
	if err != nil {
		return nil, err
	}
	return d.Credentials, nil
}

func (s *JSONStore) SaveCredential(c Credential) error {
	if c.ID == "" {
		return errors.New("credential ID is required")
	}
	if c.Name == "" {
		return errors.New("credential name is required")
	}
	if c.Username == "" {
		return errors.New("credential username is required")
	}

	d, err := s.load()
	if err != nil {
		return err
	}

	// Update existing or append new.
	for i, existing := range d.Credentials {
		if existing.ID == c.ID {
			d.Credentials[i] = c
			return s.save(d)
		}
	}
	d.Credentials = append(d.Credentials, c)
	return s.save(d)
}

func (s *JSONStore) DeleteCredential(id string) error {
	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			d.Credentials = append(d.Credentials[:i], d.Credentials[i+1:]...)
			return s.save(d)
		}
	}
	return nil
}
