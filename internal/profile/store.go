package profile

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/storage"
)

// ProfileRepository is the persistence interface for SSH profile CRUD.
type ProfileRepository interface {
	LoadProfiles() ([]SSHProfile, error)
	CreateProfile(p SSHProfile) error
	UpdateProfile(p SSHProfile) error
	DeleteProfile(id string) error
}

// GroupRepository is the persistence interface for profile group CRUD.
type GroupRepository interface {
	LoadGroups() ([]ProfileGroup, error)
	CreateGroup(g ProfileGroup) error
	UpdateGroup(g ProfileGroup) error
	DeleteGroup(id string) error
}

type CredentialMetadataRepository interface {
	LoadCredentials() ([]Credential, error)
	CreateCredential(c Credential) error
	UpdateCredential(id string, p CredentialPatch) (Credential, error)
	DeleteCredential(id string) error
	// UpdateCurrentVersionRefs sets password/passphrase secret IDs on the
	// credential's current version (or on the record-level fields for a
	// credential with no versions).
	UpdateCurrentVersionRefs(id string, passwordSecretID, passphraseSecretID string) error
	// AppendCredentialVersion appends a new version and makes it current.
	// If the credential has no versions, existing record-level
	// SecretID/PassphraseSecretID are migrated into version "v1" first.
	AppendCredentialVersion(id string, passwordSecretID, passphraseSecretID string) error
	// SetCandidateVersion creates a new version and sets it as the candidate
	// (without affecting CurrentVersionID). Returns ErrCandidateExists when
	// a candidate is already set — one candidate at a time, and only one.
	SetCandidateVersion(id string, passwordSecretID, passphraseSecretID string) error
	// ClearCandidateVersion removes the candidate version and its reference.
	// After this call, CandidateVersionID is empty and the candidate version
	// is removed from the version list. Idempotent: already-absent returns nil.
	ClearCandidateVersion(id string) error
	// PromoteVersion promotes the candidate version to current. It sets
	// CurrentVersionID to CandidateVersionID, then clears CandidateVersionID.
	// Returns ErrCandidateNotFound when no candidate is set.
	PromoteVersion(id string) (Credential, error)
	// UpdateCurrentVersionKeyMaterial sets the key material secret ID and
	// key fingerprint on the credential's current version (or record-level
	// fields for a credential with no versions), and clears KeyPath so
	// path and stored material are never both set.
	UpdateCurrentVersionKeyMaterial(id string, keyMaterialSecretID, keyFingerprint string) error
	// RetireVersion marks a version as retired. RetiredAt is set to the
	// current time. A retired version is not selected by Current() and the
	// resolver refuses to select it. Returns ErrVersionNotFound when the
	// version does not exist.
	RetireVersion(id string, versionID string) error
	// UnretireVersion clears the retirement mark on a version, making it
	// selectable again. Returns ErrVersionNotFound when the version does
	// not exist. Idempotent on an already-active version.
	UnretireVersion(id string, versionID string) error
	// ClearSecretReferences removes every reference to secretID from all
	// credentials — record-level fields and every version's password,
	// passphrase and key-material references — in one write. It is the
	// metadata-first half of deleting a secret (ADR-0011 §4): nothing may
	// keep pointing at a store entry that is about to be gone. A secret
	// nothing references is a no-op.
	ClearSecretReferences(secretID string) error
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

// LoadAll returns the full document state — all profiles, groups, and
// credentials. Used by the domain service for atomic import operations,
// where the caller needs a consistent snapshot of the entire store.
func (s *JSONStore) LoadAll() (*storeData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// WriteAll atomically replaces the entire store document. Used by the
// domain service for transactional import: build the new document in
// memory, validate it whole, write once.
func (s *JSONStore) WriteAll(d *storeData) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeLocked(d)
}

func (s *JSONStore) LoadProfiles() ([]SSHProfile, error) {
	d, err := s.load()
	if err != nil {
		return nil, err
	}
	// Profiles already on disk in the old dense shape (written before the
	// presence-aware format) load with every field implicitly "not set" —
	// zero/false values become nil pointers. This is correct behaviour: the
	// old format could not distinguish "explicitly false" from "absent", so
	// inheriting the group default is the right fallback. No migration shim
	// is needed per AGENTS.md — this is a greenfield project.
	for i := range d.Profiles {
		if d.Profiles[i].Options.BehaviorOnSessionEnd != nil {
			d.Profiles[i].BehaviorOnSessionEnd = *d.Profiles[i].Options.BehaviorOnSessionEnd
		}
	}
	return d.Profiles, nil
}

// ErrProfileIDRequired, ErrProfileExists and ErrProfileNotFound make
// create and update distinguishable — the same pattern as credentials.
var (
	ErrProfileIDRequired = errors.New("profile ID is required")
	ErrProfileExists     = errors.New("profile already exists")
	ErrProfileNotFound   = errors.New("profile not found")
)

// CreateProfile stores a new profile. It refuses an empty ID and refuses
// to overwrite an existing one.
func (s *JSONStore) CreateProfile(p SSHProfile) error {
	if p.ID == "" {
		return ErrProfileIDRequired
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for _, existing := range d.Profiles {
		if existing.ID == p.ID {
			return fmt.Errorf("%s: %w", p.ID, ErrProfileExists)
		}
	}
	// Sync BehaviorOnSessionEnd from Base to Options for storage.
	if p.BehaviorOnSessionEnd != "" {
		v := p.BehaviorOnSessionEnd
		p.Options.BehaviorOnSessionEnd = &v
	} else {
		p.Options.BehaviorOnSessionEnd = nil
	}
	d.Profiles = append(d.Profiles, p)
	return s.writeLocked(d)
}

// UpdateProfile replaces a stored profile. It fails if the profile does not
// exist — unlike the old SaveProfile, which silently created one.
func (s *JSONStore) UpdateProfile(p SSHProfile) error {
	if p.ID == "" {
		return ErrProfileIDRequired
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	// Sync BehaviorOnSessionEnd from Base to Options for storage.
	if p.BehaviorOnSessionEnd != "" {
		v := p.BehaviorOnSessionEnd
		p.Options.BehaviorOnSessionEnd = &v
	} else {
		p.Options.BehaviorOnSessionEnd = nil
	}
	for i, existing := range d.Profiles {
		if existing.ID == p.ID {
			d.Profiles[i] = p
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", p.ID, ErrProfileNotFound)
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

// ErrGroupIDRequired, ErrGroupExists and ErrGroupNotFound make
// create and update distinguishable.
var (
	ErrGroupIDRequired = errors.New("group ID is required")
	ErrGroupExists     = errors.New("group already exists")
	ErrGroupNotFound   = errors.New("group not found")
)

// CreateGroup stores a new group. It refuses an empty ID and refuses
// to overwrite an existing one. It also validates that the group's defaults
// contain no unknown keys.
func (s *JSONStore) CreateGroup(g ProfileGroup) error {
	if g.ID == "" {
		return ErrGroupIDRequired
	}
	if g.Defaults != nil {
		if err := g.Defaults.Validate(); err != nil {
			return fmt.Errorf("%s: %w", g.ID, err)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for _, existing := range d.Groups {
		if existing.ID == g.ID {
			return fmt.Errorf("%s: %w", g.ID, ErrGroupExists)
		}
	}
	d.Groups = append(d.Groups, g)
	// Validate the group tree with the new group included.
	if err := ValidateGroupTree(d.Groups); err != nil {
		return err
	}
	return s.writeLocked(d)
}

// UpdateGroup replaces a stored group. It fails if the group does not exist.
// It also validates that the updated defaults contain no unknown keys.
func (s *JSONStore) UpdateGroup(g ProfileGroup) error {
	if g.ID == "" {
		return ErrGroupIDRequired
	}
	if g.Defaults != nil {
		if err := g.Defaults.Validate(); err != nil {
			return fmt.Errorf("%s: %w", g.ID, err)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Groups {
		if existing.ID == g.ID {
			d.Groups[i] = g
			// Validate the updated group tree.
			if err := ValidateGroupTree(d.Groups); err != nil {
				return err
			}
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", g.ID, ErrGroupNotFound)
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

// DeleteGroupAtomic removes a group and promotes its children to root
// in a single atomic write. Returns ErrGroupNotFound when the group
// does not exist.
func (s *JSONStore) DeleteGroupAtomic(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}

	found := false
	for i, existing := range d.Groups {
		if existing.ID == id {
			d.Groups = append(d.Groups[:i], d.Groups[i+1:]...)
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("%s: %w", id, ErrGroupNotFound)
	}

	// Promote children to root.
	for i := range d.Groups {
		if d.Groups[i].ParentGroupID == id {
			d.Groups[i].ParentGroupID = ""
		}
	}

	// Validate the mutated tree before writing.
	if err := ValidateGroupTree(d.Groups); err != nil {
		return err
	}

	return s.writeLocked(d)
}

// ApplyGroups applies one or more group updates atomically: loads the full
// document, applies every change in memory under a single lock, validates the
// group tree, and writes once. Returns ErrGroupNotFound when any group ID in
// the slice does not exist in the current store.
func (s *JSONStore) ApplyGroups(groups []ProfileGroup) error {
	if len(groups) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}

	// Validate and apply each change. All validation runs under the same lock
	// so the state seen during validation is exactly the state that gets written.
	byID := make(map[string]int, len(d.Groups))
	for i, g := range d.Groups {
		byID[g.ID] = i
	}

	for _, g := range groups {
		if g.ID == "" {
			return ErrGroupIDRequired
		}
		if g.Defaults != nil {
			if err := g.Defaults.Validate(); err != nil {
				return fmt.Errorf("%s: %w", g.ID, err)
			}
		}
		idx, ok := byID[g.ID]
		if !ok {
			return fmt.Errorf("%s: %w", g.ID, ErrGroupNotFound)
		}
		d.Groups[idx] = g
	}

	// Validate the mutated tree before writing.
	if err := ValidateGroupTree(d.Groups); err != nil {
		return err
	}

	return s.writeLocked(d)
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
	// Validate each version against its auth method.
	for _, v := range c.Versions {
		if err := v.ValidateVersion(); err != nil {
			return err
		}
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

// UpdateCurrentVersionRefs sets password/passphrase secret IDs on the
// credential's current version. For a credential with no versions,
// the record-level SecretID/PassphraseSecretID fields are updated instead.
func (s *JSONStore) UpdateCurrentVersionRefs(id string, passwordSecretID, passphraseSecretID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			if len(existing.Versions) == 0 {
				// No versions: update record-level fields.
				d.Credentials[i].SecretID = passwordSecretID
				d.Credentials[i].PassphraseSecretID = passphraseSecretID
			} else {
				// Update current version's fields.
				for j := range d.Credentials[i].Versions {
					if d.Credentials[i].Versions[j].ID == d.Credentials[i].CurrentVersionID {
						d.Credentials[i].Versions[j].PasswordSecretID = passwordSecretID
						d.Credentials[i].Versions[j].PassphraseSecretID = passphraseSecretID
						break
					}
				}
			}
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// UpdateCurrentVersionKeyMaterial sets the key material secret ID and
// fingerprint on the credential's current version, and clears KeyPath.
// For a credential with no versions, existing record-level fields are
// migrated into a v1 version first so the fingerprint is stored on the
// version where callers expect it.
func (s *JSONStore) UpdateCurrentVersionKeyMaterial(id string, keyMaterialSecretID, keyFingerprint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			if len(existing.Versions) == 0 {
				// Migrate record-level fields into a version first
				// so we can store the fingerprint on the version.
				d.Credentials[i].Versions = []CredentialVersion{
					{
						ID:                  initialVersionID,
						PasswordSecretID:    existing.SecretID,
						PassphraseSecretID:  existing.PassphraseSecretID,
						KeyMaterialSecretID: keyMaterialSecretID,
						KeyFingerprint:      keyFingerprint,
					},
				}
				d.Credentials[i].CurrentVersionID = initialVersionID
				d.Credentials[i].SecretID = ""
				d.Credentials[i].PassphraseSecretID = ""
			} else {
				// Update current version's key material fields.
				var updated bool
				for j := range d.Credentials[i].Versions {
					if d.Credentials[i].Versions[j].ID == d.Credentials[i].CurrentVersionID {
						d.Credentials[i].Versions[j].KeyMaterialSecretID = keyMaterialSecretID
						d.Credentials[i].Versions[j].KeyFingerprint = keyFingerprint
						updated = true
						break
					}
				}
				if !updated {
					return fmt.Errorf("credential %s current version %s not found", id, d.Credentials[i].CurrentVersionID)
				}
			}
			// Clear KeyPath — stored key material and a path are
			// mutually exclusive (brief §3).
			d.Credentials[i].KeyPath = ""
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// ClearSecretReferences removes every reference to secretID from all
// credentials: record-level fields AND every version's password, passphrase
// and key-material references, in ONE write. It is the metadata-first half
// of deleting a secret (ADR-0011 §4): nothing may keep pointing at a store
// entry that is about to be gone, and a loop of per-field setters could fail
// halfway, leaving a partial clear. A version whose key material reference
// is cleared loses its fingerprint too — the two describe the same material,
// and deleteKeyMaterialForCredential already clears them together.
//
// Idempotent: a secret nothing references clears nothing and succeeds.
func (s *JSONStore) ClearSecretReferences(secretID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}

	changed := false
	for i := range d.Credentials {
		c := &d.Credentials[i]
		if c.SecretID == secretID {
			c.SecretID = ""
			changed = true
		}
		if c.PassphraseSecretID == secretID {
			c.PassphraseSecretID = ""
			changed = true
		}
		if c.KeyMaterialSecretID == secretID {
			c.KeyMaterialSecretID = ""
			changed = true
		}
		for j := range c.Versions {
			v := &c.Versions[j]
			if v.PasswordSecretID == secretID {
				v.PasswordSecretID = ""
				changed = true
			}
			if v.PassphraseSecretID == secretID {
				v.PassphraseSecretID = ""
				changed = true
			}
			if v.KeyMaterialSecretID == secretID {
				v.KeyMaterialSecretID = ""
				v.KeyFingerprint = ""
				changed = true
			}
		}
	}

	if !changed {
		return nil
	}
	return s.writeLocked(d)
}

// AppendCredentialVersion appends a new version and sets it as the current
// version. If the credential has no versions yet, the existing
// record-level SecretID and PassphraseSecretID are first migrated into
// version "v1".
func (s *JSONStore) AppendCredentialVersion(id string, passwordSecretID, passphraseSecretID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			// Migrate record-level fields into a version if needed.
			if len(existing.Versions) == 0 {
				d.Credentials[i].Versions = []CredentialVersion{
					{
						ID:                  initialVersionID,
						PasswordSecretID:    existing.SecretID,
						PassphraseSecretID:  existing.PassphraseSecretID,
						KeyMaterialSecretID: existing.KeyMaterialSecretID,
					},
				}
				d.Credentials[i].CurrentVersionID = initialVersionID
				d.Credentials[i].SecretID = ""
				d.Credentials[i].PassphraseSecretID = ""
				d.Credentials[i].KeyMaterialSecretID = ""
			}

			// Determine the next version ID.
			nextID := fmt.Sprintf("v%d", len(d.Credentials[i].Versions)+1)

			// Validate the new version against the credential's auth.
			newVersion := CredentialVersion{
				ID:                 nextID,
				Auth:               d.Credentials[i].Auth,
				PasswordSecretID:   passwordSecretID,
				PassphraseSecretID: passphraseSecretID,
			}
			if err := newVersion.ValidateVersion(); err != nil {
				return err
			}

			// Append the new version.
			d.Credentials[i].Versions = append(d.Credentials[i].Versions, newVersion)
			d.Credentials[i].CurrentVersionID = nextID
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// SetCandidateVersion creates a new version and sets it as the candidate
// without affecting CurrentVersionID or changing how connections authenticate.
// Returns ErrCandidateExists when a candidate is already set — one candidate
// at a time, and only one, because a second candidate would need to specify
// which one is being probed or promoted.
func (s *JSONStore) SetCandidateVersion(id string, passwordSecretID, passphraseSecretID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			if existing.CandidateVersionID != "" {
				return fmt.Errorf("%s: %w", id, ErrCandidateExists)
			}
			// Migrate record-level fields into a version if needed.
			if len(existing.Versions) == 0 {
				d.Credentials[i].Versions = []CredentialVersion{
					{
						ID:                  initialVersionID,
						PasswordSecretID:    existing.SecretID,
						PassphraseSecretID:  existing.PassphraseSecretID,
						KeyMaterialSecretID: existing.KeyMaterialSecretID,
					},
				}
				d.Credentials[i].CurrentVersionID = initialVersionID
				d.Credentials[i].SecretID = ""
				d.Credentials[i].PassphraseSecretID = ""
				d.Credentials[i].KeyMaterialSecretID = ""
			}

			// Determine the next version ID.
			nextID := fmt.Sprintf("v%d", len(d.Credentials[i].Versions)+1)

			// Validate the new version against the credential's auth.
			newVersion := CredentialVersion{
				ID:                 nextID,
				Auth:               d.Credentials[i].Auth,
				PasswordSecretID:   passwordSecretID,
				PassphraseSecretID: passphraseSecretID,
			}
			if err := newVersion.ValidateVersion(); err != nil {
				return err
			}

			// Append the new version — no CurrentVersionID change.
			d.Credentials[i].Versions = append(d.Credentials[i].Versions, newVersion)
			d.Credentials[i].CandidateVersionID = nextID
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// ClearCandidateVersion removes the candidate version and its reference.
// The candidate version is removed from the version list so it cannot be
// referenced as a straggler. Idempotent: already-absent returns nil.
func (s *JSONStore) ClearCandidateVersion(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			if existing.CandidateVersionID == "" {
				return nil // idempotent
			}

			// Remove the candidate version from the version list.
			remaining := make([]CredentialVersion, 0, len(existing.Versions)-1)
			for _, v := range d.Credentials[i].Versions {
				if v.ID != existing.CandidateVersionID {
					remaining = append(remaining, v)
				}
			}
			d.Credentials[i].Versions = remaining
			d.Credentials[i].CandidateVersionID = ""
			return s.writeLocked(d)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// PromoteVersion promotes the candidate version to current. It does NOT
// retire the previous current version — that is a separate call (RetireVersion).
// Returns an error when no candidate is set.
func (s *JSONStore) PromoteVersion(id string) (Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return Credential{}, err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			if existing.CandidateVersionID == "" {
				return Credential{}, fmt.Errorf("%s: no candidate to promote", id)
			}

			// No versions list means the credential is in initial state.
			// A candidate cannot exist on a credential with no versions —
			// staging always appends to Versions first. Refuse: this state
			// is unreachable from correct callers and silent data loss from
			// any path that reaches it.
			if len(existing.Versions) == 0 {
				return Credential{}, fmt.Errorf("%s: cannot promote: credential has no version list", id)
			}

			// Standard path: swap candidate to current.
			d.Credentials[i].CurrentVersionID = existing.CandidateVersionID
			d.Credentials[i].CandidateVersionID = ""
			return d.Credentials[i], s.writeLocked(d)
		}
	}
	return Credential{}, fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// RetireVersion marks a version as retired by setting RetiredAt to the current
// time. The version is still in the version list and can be looked up by ID.
func (s *JSONStore) RetireVersion(id string, versionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			for j, v := range d.Credentials[i].Versions {
				if v.ID == versionID {
					now := time.Now()
					d.Credentials[i].Versions[j].RetiredAt = &now
					return s.writeLocked(d)
				}
			}
			// Credential with no versions — refuse retirement.
			return fmt.Errorf("%s version %s: %w", id, versionID, ErrVersionNotFound)
		}
	}
	return fmt.Errorf("%s: %w", id, ErrCredentialNotFound)
}

// UnretireVersion clears the retirement mark on a version. Idempotent on a
// version that is already active (RetiredAt is already nil).
func (s *JSONStore) UnretireVersion(id string, versionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := s.load()
	if err != nil {
		return err
	}
	for i, existing := range d.Credentials {
		if existing.ID == id {
			for j, v := range d.Credentials[i].Versions {
				if v.ID == versionID {
					d.Credentials[i].Versions[j].RetiredAt = nil
					return s.writeLocked(d)
				}
			}
			return fmt.Errorf("%s version %s: %w", id, versionID, ErrVersionNotFound)
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
