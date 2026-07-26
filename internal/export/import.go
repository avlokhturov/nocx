package export

import (
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// ImportResult reports the outcome of an import operation.
type ImportResult struct {
	ProfilesImported    int `json:"profilesImported"`
	GroupsImported      int `json:"groupsImported"`
	CredentialsImported int `json:"credentialsImported"`
	// UnresolvedCredentials are credentials whose SecretID references
	// were present in the import payload; the user must map existing
	// credentials or supply missing secrets (ADR-0011 §7).
	UnresolvedCredentials []profile.Credential `json:"unresolvedCredentials,omitempty"`
}

// ImportDeps are the repositories to write into during import.
type ImportDeps struct {
	Profiles    profile.ProfileRepository
	Groups      profile.GroupRepository
	Credentials profile.CredentialMetadataRepository
}

// ImportConfiguration imports a ConfigExport into the given repositories.
//
// Import never resolves or invents a secret (ADR-0011 §2, §7). Credentials
// are imported with their SecretID references intact. Every credential in
// the import payload is reported in UnresolvedCredentials so the UI can
// prompt the user to map existing credentials or supply missing secrets.
func ImportConfiguration(deps ImportDeps, data *ConfigExport) (*ImportResult, error) {
	result := &ImportResult{}

	for _, p := range data.Profiles {
		if err := deps.Profiles.SaveProfile(p); err != nil {
			return nil, fmt.Errorf("import profile %s: %w", p.ID, err)
		}
		result.ProfilesImported++
	}

	for _, g := range data.Groups {
		if err := deps.Groups.SaveGroup(g); err != nil {
			return nil, fmt.Errorf("import group %s: %w", g.ID, err)
		}
		result.GroupsImported++
	}

	for _, c := range data.Credentials {
		if err := deps.Credentials.SaveCredential(c); err != nil {
			return nil, fmt.Errorf("import credential %s: %w", c.ID, err)
		}
		result.CredentialsImported++
		// Every credential is unresolved — the user must map secrets.
		result.UnresolvedCredentials = append(result.UnresolvedCredentials, c)
	}

	return result, nil
}
