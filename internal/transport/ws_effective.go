package transport

import (
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// profiles.effective — batched effective profile resolution with provenance
// ---------------------------------------------------------------------------

type effectiveParams struct {
	IDs []string `json:"ids"`
}

// profileErrorEntry is a typed per-profile error in the batch response.
type profileErrorEntry struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type effectiveResponse struct {
	Profiles []profile.EffectiveProfileDTO `json:"profiles"`
	Errors   []profileErrorEntry           `json:"errors,omitempty"`
}

// ---------------------------------------------------------------------------
// profiles.patch — explicit set and unset of specific fields
// ---------------------------------------------------------------------------

type patchParams struct {
	ID    string         `json:"id"`
	Set   map[string]any `json:"set,omitempty"`
	Unset []string       `json:"unset,omitempty"`
}

func validatePatch(p patchParams) error {
	if p.ID == "" {
		return fmt.Errorf("id required")
	}
	for path := range p.Set {
		if !profile.PatchPathAllowed(path) {
			return fmt.Errorf("unknown set path: %s", path)
		}
	}
	for _, path := range p.Unset {
		if !profile.PatchPathAllowed(path) {
			return fmt.Errorf("unknown unset path: %s", path)
		}
	}
	// Disjoint: no path in both set and unset.
	for path := range p.Set {
		for _, upath := range p.Unset {
			if path == upath {
				return fmt.Errorf("path %q is in both set and unset", path)
			}
		}
	}
	return nil
}
