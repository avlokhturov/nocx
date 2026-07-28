package profile

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/shady2k/nocx/internal/storage"
)

// ProfileRepository is the persistence interface for SSH profile CRUD.
type ProfileRepository interface {
	LoadProfiles() ([]SSHProfile, error)
	SaveProfile(p SSHProfile) error
	DeleteProfile(id string) error
}

// GroupRepository is the persistence interface for profile group CRUD.
type GroupRepository interface {
	LoadGroups() ([]ProfileGroup, error)
	SaveGroup(g ProfileGroup) error
	DeleteGroup(id string) error
}

// CredentialMetadataRepository is the persistence interface for credential
// metadata CRUD. Secrets referenced by SecretID fields are managed by the
// credential.SecretStore, not by this repository (ADR-0011 §2).
type CredentialMetadataRepository interface {
	LoadCredentials() ([]Credential, error)
	CreateCredential(c Credential) error
	UpdateCredential(id string, p CredentialPatch) (Credential, error)
	DeleteCredential(id string) error
	SetSecretRefs(id string, secretID, passphraseSecretID string) error
}

// JSONStore persists profiles and groups to a single JSON file on disk.
// The file format is:
//
//	{ "profiles": [...], "groups": [...] }
type JSONStore struct {
	docStore storage.DocumentStore
	fileName string
	mu       sync.Mutex
}

// NewJSONStore creates a JSONStore rooted at path (convenience constructor
// used by tests and simple wiring). The path's directory component becomes
// the DocumentStore root; the file component is the document name.
func NewJSONStore(path string) *JSONStore {
	return &JSONStore{
		docStore: storage.NewDocumentStore(filepath.Dir(path)),
		fileName: filepath.Base(path),
	}
}

// NewJSONStoreWithDocStore creates a JSONStore that reads and writes the
// named document through the given DocumentStore. Prefer this constructor
// when the DocumentStore is shared across multiple modules (composition-root
// wiring per AD-8).
func NewJSONStoreWithDocStore(docStore storage.DocumentStore, fileName string) *JSONStore {
	return &JSONStore{docStore: docStore, fileName: fileName}
}

type storeData struct {
	Profiles    []SSHProfile   `json:"profiles,omitempty"`
	Groups      []ProfileGroup `json:"groups,omitempty"`
	Credentials []Credential   `json:"credentials,omitempty"`
}

func (s *JSONStore) load() (*storeData, error) {
	var d storeData
	found, err := s.docStore.Read(s.fileName, &d)
	if err != nil {
		return nil, fmt.Errorf("read profile store: %w", err)
	}
	if !found {
		return &storeData{}, nil
	}
	return &d, nil
}

// writeLocked marshals d to JSON and writes it through the DocumentStore.
// The caller MUST hold s.mu.
func (s *JSONStore) writeLocked(d *storeData) error {
	return s.docStore.Write(s.fileName, d)
}

func (s *JSONStore) LoadProfiles() ([]SSHProfile, error) {
	d, err := s.load()
	if err != nil {
		return nil, err
	}
	return d.Profiles, nil
}

func (s *JSONStore) SaveProfile(p SSHProfile) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Profiles {
		if existing.ID == p.ID {
			d.Profiles[i] = p
			return s.writeLocked(d)
		}
	}
	d.Profiles = append(d.Profiles, p)
	return s.writeLocked(d)
}

func (s *JSONStore) DeleteProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Profiles {
		if existing.ID == id {
			d.Profiles = append(d.Profiles[:i], d.Profiles[i+1:]...)
			return s.writeLocked(d)
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
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Groups {
		if existing.ID == g.ID {
			d.Groups[i] = g
			return s.writeLocked(d)
		}
	}
	d.Groups = append(d.Groups, g)
	return s.writeLocked(d)
}

func (s *JSONStore) DeleteGroup(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Groups {
		if existing.ID == id {
			d.Groups = append(d.Groups[:i], d.Groups[i+1:]...)
			return s.writeLocked(d)
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

// ErrCredentialIDRequired, ErrCredentialExists and ErrCredentialNotFound make
// create and update distinguishable. The single SaveCredential upsert they
// replace accepted an empty ID and silently overwrote an existing record, so a
// create could destroy data it never read (nocx-u5ai).
var (
	ErrCredentialIDRequired = errors.New("credential ID is required")
	ErrCredentialExists     = errors.New("credential already exists")
	ErrCredentialNotFound   = errors.New("credential not found")
)

// CreateCredential stores a new credential. It refuses an empty ID and refuses
// to overwrite an existing one.
func (s *JSONStore) CreateCredential(c Credential) error {
	if c.ID == "" {
		return ErrCredentialIDRequired
	}
	if err := c.Validate(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for _, existing := range d.Credentials {
		if existing.ID == c.ID {
			return fmt.Errorf("%s: %w", c.ID, ErrCredentialExists)
		}
	}
	d.Credentials = append(d.Credentials, c)
	return s.writeLocked(d)
}

// UpdateCredential merges a sparse patch onto the stored record and returns the
// result. The read-merge-write runs under the mutex: doing it in the caller
// would let a concurrent savePassword land between the read and the write and
// be silently discarded.
func (s *JSONStore) UpdateCredential(id string, p CredentialPatch) (Credential, error) {
	if id == "" {
		return Credential{}, ErrCredentialIDRequired
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return Credential{}, err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			merged := existing.WithPatch(p)
			if err := merged.Validate(); err != nil {
				return Credential{}, err
			}
			d.Credentials[i] = merged
			if err := s.writeLocked(d); err != nil {
				return Credential{}, err
			}
			return merged, nil
		}
	}
	return Credential{}, fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// SetSecretRefs repoints a credential's backend-owned secret references. It is
// the only way those fields ever change, and it is deliberately not reachable
// through CredentialPatch — the renderer must never name a SecretID.
func (s *JSONStore) SetSecretRefs(id string, secretID, passphraseSecretID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			d.Credentials[i].SecretID = secretID
			d.Credentials[i].PassphraseSecretID = passphraseSecretID
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

func (s *JSONStore) DeleteCredential(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			d.Credentials = append(d.Credentials[:i], d.Credentials[i+1:]...)
			return s.writeLocked(d)
		}
	}
	return nil
}
