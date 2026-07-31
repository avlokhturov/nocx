package export

import (
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// ImportResult reports the outcome of an import operation.
type ImportResult struct {
	ProfilesImported int `json:"profilesImported"`
	GroupsImported   int `json:"groupsImported"`
}

// ImportDeps are the repositories to write into during import.
type ImportDeps struct {
	Profiles profile.ProfileRepository
	Groups   profile.GroupRepository
}

// ImportConfiguration imports a ConfigExport into the given repositories.
//
// Import never resolves or invents a secret (ADR-0011 §2, §7). Imported
// profiles carry no secret bindings — the export strips them, and the
// receiving machine's user binds their own secrets afterwards.
func ImportConfiguration(deps ImportDeps, data *ConfigExport) (*ImportResult, error) {
	result := &ImportResult{}

	for _, p := range data.Profiles {
		// Create, falling back to Update on duplicate — preserving the
		// overwrite-on-reimport behaviour today's SaveProfile provided.
		// Wave 3 routes this through the domain service properly.
		if err := deps.Profiles.CreateProfile(p); err != nil {
			if errors.Is(err, profile.ErrProfileExists) {
				if upErr := deps.Profiles.UpdateProfile(p); upErr != nil {
					return nil, fmt.Errorf("import profile %s: %w", p.ID, upErr)
				}
			} else {
				return nil, fmt.Errorf("import profile %s: %w", p.ID, err)
			}
		}
		result.ProfilesImported++
	}

	for _, g := range data.Groups {
		if err := deps.Groups.CreateGroup(g); err != nil {
			if errors.Is(err, profile.ErrGroupExists) {
				if upErr := deps.Groups.UpdateGroup(g); upErr != nil {
					return nil, fmt.Errorf("import group %s: %w", g.ID, upErr)
				}
			} else {
				return nil, fmt.Errorf("import group %s: %w", g.ID, err)
			}
		}
		result.GroupsImported++
	}

	return result, nil
}

// ImportConfigurationWithService imports a ConfigExport through the
// domain service, ensuring atomicity and validation.
func ImportConfigurationWithService(svc *profile.ProfileService, data *ConfigExport) (*ImportResult, error) {
	svcResult := svc.AtomicImport(data.Profiles, data.Groups)

	if len(svcResult.ImportErrors) > 0 {
		return nil, fmt.Errorf("import failed: %s", svcResult.ImportErrors[0])
	}

	return &ImportResult{
		ProfilesImported: svcResult.ProfilesImported,
		GroupsImported:   svcResult.GroupsImported,
	}, nil
}
