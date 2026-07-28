package profile

import (
	"errors"
	"fmt"
)

// ---------------------------------------------------------------------------
// Domain-level errors
// ---------------------------------------------------------------------------

// ErrCredentialOverwriteRefused is returned when an import tries to
// overwrite an existing credential. Credentials are never overwritten
// during import — the imported metadata would blank the stored secret
// references the payload does not carry.
var ErrCredentialOverwriteRefused = errors.New("credential overwrite refused: import would blank stored secret references; delete the existing credential first")

// ErrProfileNeedsReview is returned when trying to resolve a profile marked NeedsReview.
// The profile references a credential resolved from local state during import and
// requires human review before it can be used.
var ErrProfileNeedsReview = errors.New("profile requires review before it can be resolved")

// NeedsReviewReason explains why a profile was marked NeedsReview.
const NeedsReviewReason = "profile references a local credential imported from another source; review required"

// ---------------------------------------------------------------------------
// ImportResult
// ---------------------------------------------------------------------------

// ImportResult reports the outcome of an import operation.
type ImportResult struct {
	ProfilesImported     int      `json:"profilesImported"`
	GroupsImported       int      `json:"groupsImported"`
	CredentialsImported  int      `json:"credentialsImported"`
	CredentialsRefused   int      `json:"credentialsRefused,omitempty"`
	ProfilesMarkedReview int      `json:"profilesMarkedReview,omitempty"`
	ImportErrors         []string `json:"importErrors,omitempty"`
}

// ---------------------------------------------------------------------------
// ProfileService — single write path for profiles, groups and credentials
// ---------------------------------------------------------------------------

// ProfileService provides a single write path for profiles, groups, and
// credentials that every writer goes through: ordinary CRUD, the Tabby
// importer, the configuration importer. Validation lives here once, not
// once per caller.
type ProfileService struct {
	store *JSONStore
}

// NewProfileService creates a ProfileService backed by the given store.
func NewProfileService(store *JSONStore) *ProfileService {
	return &ProfileService{store: store}
}

// ---------------------------------------------------------------------------
// CRUD with validation
// ---------------------------------------------------------------------------

// SaveProfile creates or updates a profile. Profiles with a non-blank
// CredentialID that references an existing local credential are NOT marked
// for review during CRUD — that flag is an import-specific safety measure.
// CRUD is deliberate user action, not batch ingestion.
func (s *ProfileService) SaveProfile(p SSHProfile) error {
	if p.ID == "" {
		return ErrProfileIDRequired
	}
	if p.Options.Host == "" {
		return fmt.Errorf("%s: host is required", p.ID)
	}

	// Load current state.
	storeData, err := s.store.LoadAll()
	if err != nil {
		return fmt.Errorf("load store: %w", err)
	}

	// Check if this is a create or update.
	for i, existing := range storeData.Profiles {
		if existing.ID == p.ID {
			storeData.Profiles[i] = p
			return s.store.WriteAll(storeData)
		}
	}

	storeData.Profiles = append(storeData.Profiles, p)
	return s.store.WriteAll(storeData)
}

// SaveGroup creates or updates a group. Validates unknown default keys
// and group tree integrity after the write.
func (s *ProfileService) SaveGroup(g ProfileGroup) error {
	if g.ID == "" {
		return ErrGroupIDRequired
	}

	// Validate group defaults if present.
	if g.Defaults != nil {
		if err := g.Defaults.Validate(); err != nil {
			return fmt.Errorf("%s: %w", g.ID, err)
		}
	}

	storeData, err := s.store.LoadAll()
	if err != nil {
		return fmt.Errorf("load store: %w", err)
	}

	for i, existing := range storeData.Groups {
		if existing.ID == g.ID {
			storeData.Groups[i] = g
			// Validate group tree after the change.
			if err := ValidateGroupTree(storeData.Groups); err != nil {
				return fmt.Errorf("group tree invalid after save: %w", err)
			}
			return s.store.WriteAll(storeData)
		}
	}

	storeData.Groups = append(storeData.Groups, g)
	if err := ValidateGroupTree(storeData.Groups); err != nil {
		return fmt.Errorf("group tree invalid after save: %w", err)
	}
	return s.store.WriteAll(storeData)
}

// SaveCredential creates a credential or returns an error if it already
// exists. The collision policy for CRUD is the same as import: we refuse
// to overwrite, because a create-via-update would blank secret references.
func (s *ProfileService) SaveCredential(c Credential) error {
	if c.ID == "" {
		return ErrCredentialIDRequired
	}
	if err := c.Validate(); err != nil {
		return err
	}

	storeData, err := s.store.LoadAll()
	if err != nil {
		return fmt.Errorf("load store: %w", err)
	}

	for _, existing := range storeData.Credentials {
		if existing.ID == c.ID {
			return fmt.Errorf("%s: %w", c.ID, ErrCredentialExists)
		}
	}

	storeData.Credentials = append(storeData.Credentials, c)
	return s.store.WriteAll(storeData)
}

// ---------------------------------------------------------------------------
// Atomic import — build new document in memory, validate whole, write once
// ---------------------------------------------------------------------------

// AtomicImport merges profiles, groups and credentials into the store
// atomically. On any validation failure the store is unchanged. The import:
//
//  1. Loads current store state.
//  2. Merges profiles (overwrite on duplicate ID).
//  3. Merges groups (overwrite on duplicate ID, validates group tree).
//  4. Merges credentials (REFUSE on duplicate — see ErrCredentialOverwriteRefused).
//  5. Marks any imported profile whose CredentialID references an EXISTING local
//     credential as NeedsReview.
//  6. Validates the full result.
//  7. Writes once.
func (s *ProfileService) AtomicImport(profiles []SSHProfile, groups []ProfileGroup, credentials []Credential) *ImportResult {
	result := &ImportResult{}
	hasFatal := false

	// Step 1: Load current state.
	storeData, err := s.store.LoadAll()
	if err != nil {
		result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("load store: %v", err))
		return result
	}

	// Build a set of existing credential IDs for review detection.
	existingCredIDs := make(map[string]bool, len(storeData.Credentials))
	for _, c := range storeData.Credentials {
		existingCredIDs[c.ID] = true
	}

	// Step 2: Merge profiles — overwrite on duplicate ID.
	for _, p := range profiles {
		if p.ID == "" {
			result.ImportErrors = append(result.ImportErrors, "profile with empty ID skipped")
			continue
		}
		if p.Options.Host == "" {
			result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("%s: host is required", p.ID))
			hasFatal = true
			continue
		}

		found := false
		for i, existing := range storeData.Profiles {
			if existing.ID == p.ID {
				storeData.Profiles[i] = p
				found = true
				break
			}
		}
		if !found {
			storeData.Profiles = append(storeData.Profiles, p)
		}
		result.ProfilesImported++

		// Step 5: if the profile names an existing local credential, mark for review.
		if p.Options.CredentialID != "" && existingCredIDs[p.Options.CredentialID] {
			storeData.Profiles[len(storeData.Profiles)-1].NeedsReview = true
			result.ProfilesMarkedReview++
		}
	}

	// Step 3: Merge groups — overwrite on duplicate ID.
	for _, g := range groups {
		if g.ID == "" {
			result.ImportErrors = append(result.ImportErrors, "group with empty ID skipped")
			continue
		}
		if g.Defaults != nil {
			if err := g.Defaults.Validate(); err != nil {
				result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("%s: %v", g.ID, err))
				hasFatal = true
				continue
			}
		}
		found := false
		for i, existing := range storeData.Groups {
			if existing.ID == g.ID {
				storeData.Groups[i] = g
				found = true
				break
			}
		}
		if !found {
			storeData.Groups = append(storeData.Groups, g)
		}
		result.GroupsImported++
	}

	// Step 4: Merge credentials — REFUSE on duplicate.
	for _, c := range credentials {
		if c.ID == "" {
			result.ImportErrors = append(result.ImportErrors, "credential with empty ID skipped")
			continue
		}
		if err := c.Validate(); err != nil {
			result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("%s: %v", c.ID, err))
			hasFatal = true
			continue
		}
		duplicate := false
		for _, existing := range storeData.Credentials {
			if existing.ID == c.ID {
				duplicate = true
				break
			}
		}
		if duplicate {
			result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("%s: %v", c.ID, ErrCredentialOverwriteRefused))
			result.CredentialsRefused++
			hasFatal = true
			continue
		}
		storeData.Credentials = append(storeData.Credentials, c)
		result.CredentialsImported++
	}

	// Validate group tree.
	if len(storeData.Groups) > 0 {
		if err := ValidateGroupTree(storeData.Groups); err != nil {
			result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("group tree: %v", err))
			hasFatal = true
		}
	}

	if hasFatal {
		// Return the result with errors but do NOT write — store is unchanged.
		return result
	}

	// Step 7: Write once, atomically.
	if err := s.store.WriteAll(storeData); err != nil {
		result.ImportErrors = append(result.ImportErrors, fmt.Sprintf("write store: %v", err))
		return result
	}

	return result
}

// ---------------------------------------------------------------------------
// Review flag management
// ---------------------------------------------------------------------------

// ClearReviewFlag clears the NeedsReview flag on a profile, returning
// the updated profile. Returns ErrProfileNotFound if the profile does
// not exist.
func (s *ProfileService) ClearReviewFlag(profileID string) (SSHProfile, error) {
	if profileID == "" {
		return SSHProfile{}, ErrProfileIDRequired
	}

	storeData, err := s.store.LoadAll()
	if err != nil {
		return SSHProfile{}, fmt.Errorf("load store: %w", err)
	}

	for i, p := range storeData.Profiles {
		if p.ID == profileID {
			storeData.Profiles[i].NeedsReview = false
			if err := s.store.WriteAll(storeData); err != nil {
				return SSHProfile{}, fmt.Errorf("write store: %w", err)
			}
			return storeData.Profiles[i], nil
		}
	}

	return SSHProfile{}, fmt.Errorf("%s: %w", profileID, ErrProfileNotFound)
}
