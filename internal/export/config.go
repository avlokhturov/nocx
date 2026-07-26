package export

import (
	"github.com/shady2k/nocx/internal/profile"
)

// ConfigExport is the payload for a configuration export.
// SecretID references travel as-is; no secret material is ever included.
type ConfigExport struct {
	Profiles    []profile.SSHProfile   `json:"profiles"`
	Groups      []profile.ProfileGroup `json:"groups"`
	Credentials []profile.Credential   `json:"credentials"`
	// Settings is populated from the SettingsProvider. nil means no
	// provider was wired; the field is omitted from JSON in that case.
	Settings map[string]any `json:"settings,omitempty"`
}

// ConfigExportDeps are the repositories and providers needed for a
// configuration export. All fields are required except Settings.
type ConfigExportDeps struct {
	Profiles    profile.ProfileRepository
	Groups      profile.GroupRepository
	Credentials profile.CredentialMetadataRepository
	// Settings is an optional provider for the settings registry.
	// When nil, the export carries no settings.
	Settings SettingsProvider
}

// SettingsProvider supplies all public-configuration settings as
// key-value pairs. The settings registry (nocx-9m5) satisfies this;
// secret-class settings are excluded by the provider, not by the
// export package (ADR-0011 §3).
type SettingsProvider interface {
	All() (map[string]any, error)
}

// ExportConfiguration reads all configuration from the provided
// repositories and returns a ConfigExport. SecretID references are
// carried as-is; no secret material is ever resolved.
func ExportConfiguration(deps ConfigExportDeps) (*ConfigExport, error) {
	profiles, err := deps.Profiles.LoadProfiles()
	if err != nil {
		return nil, err
	}

	groups, err := deps.Groups.LoadGroups()
	if err != nil {
		return nil, err
	}

	credentials, err := deps.Credentials.LoadCredentials()
	if err != nil {
		return nil, err
	}

	result := &ConfigExport{
		Profiles:    profiles,
		Groups:      groups,
		Credentials: credentials,
	}

	if deps.Settings != nil {
		settings, err := deps.Settings.All()
		if err != nil {
			return nil, err
		}
		result.Settings = settings
	}

	return result, nil
}
