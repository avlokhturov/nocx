package export

import (
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// SettingsSink applies exported settings back into a registry. It is the
// write-side counterpart of SettingsProvider: the transport wires the
// settings registry, and the export package never imports it (ADR-0011 §3).
// Implementations reject unknown or secret-class keys — a value the receiving
// build cannot restore is not silently dropped (nocx-ojxa).
type SettingsSink interface {
	Apply(values map[string]any) error
}

// ImportResult reports the outcome of an import operation.
type ImportResult struct {
	ProfilesImported int `json:"profilesImported"`
	GroupsImported   int `json:"groupsImported"`
}

// ImportDeps are the repositories to write into during import.
type ImportDeps struct {
	Profiles profile.ProfileRepository
	Groups   profile.GroupRepository
	// Settings is the sink for the settings the export carried. When nil and
	// the import carries settings, the import fails: a value import cannot
	// restore must never be silently dropped.
	Settings SettingsSink
}

// ImportConfiguration imports a ConfigExport into the given repositories.
//
// Import never resolves or invents a secret (ADR-0011 §2, §7). Imported
// profiles carry no secret bindings — the export strips them, and any
// reference that still reaches import (a forged payload) is stripped here
// rather than persisted for the resolver to honour later (nocx-jb20.1). The
// receiving machine's user binds their own secrets afterwards.
//
// Settings carried by the export are restored through deps.Settings; an
// export that carries settings is an error to import without a sink.
func ImportConfiguration(deps ImportDeps, data *ConfigExport) (*ImportResult, error) {
	result := &ImportResult{}

	profiles := stripSecretBindings(data.Profiles)
	for _, p := range profiles {
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

	if err := restoreSettings(deps.Settings, data.Settings); err != nil {
		return nil, err
	}

	return result, nil
}

// restoreSettings applies exported settings through the sink. An export that
// carries settings but is imported without a sink fails: silently dropping
// what export promised to carry is the defect this fixes (nocx-ojxa).
func restoreSettings(sink SettingsSink, values map[string]any) error {
	if len(values) == 0 {
		return nil
	}
	if sink == nil {
		return fmt.Errorf("import failed: the export carries settings but no settings registry is available to restore them")
	}
	if err := sink.Apply(values); err != nil {
		return fmt.Errorf("import settings: %w", err)
	}
	return nil
}

// stripSecretBindings removes machine-local secret references from imported
// profiles. The export strips them (config.go) and the receiving machine
// binds its own afterwards (ADR-0011 §2, ADR-0017): a reference that reaches
// import — from a forged payload or a future export that forgot — is never
// persisted (nocx-jb20.1).
func stripSecretBindings(profiles []profile.SSHProfile) []profile.SSHProfile {
	stripped := make([]profile.SSHProfile, len(profiles))
	for i, p := range profiles {
		p.Options.PasswordSecret = ""
		p.Options.KeySecret = ""
		p.Options.KeyPassphraseSecret = ""
		stripped[i] = p
	}
	return stripped
}
