package profile

import (
	"sort"
	"strings"
)

// CredentialUsage maps a credential to the profiles that resolve to it.
type CredentialUsage struct {
	CredentialID string       `json:"credentialId"`
	Profiles     []ProfileRef `json:"profiles"`
}

// ProfileRef identifies a profile that uses a credential and how it obtained it.
type ProfileRef struct {
	ProfileID   string `json:"profileId"`
	ProfileName string `json:"profileName"`
	Source      string `json:"source"`              // "profile" or "group"
	GroupID     string `json:"groupId,omitempty"`   // set when source == "group"
	GroupName   string `json:"groupName,omitempty"` // set when source == "group"
}

// ProfileRefSource constants — the closed set of values Source may carry. The
// renderer switches on these, so adding one is a wire-contract change.
const (
	ProfileRefSourceProfile = "profile"
	ProfileRefSourceGroup   = "group"
	ProfileRefSourceGlobal  = "global"
)

// ComputeCredentialUsage returns, for every credential, the profiles that
// resolve to it via the effective-profile inheritance engine. A credential
// with no referencing profiles appears with an empty profiles slice — it is
// not omitted.
//
// Resolution goes through ResolveEffectiveProfile, not a field scan. A
// profile that names its own credential does NOT also count against its
// group's credential — precedence is already decided by the engine.
func ComputeCredentialUsage(
	credentials []Credential,
	profiles []SSHProfile,
	groups []ProfileGroup,
	globalDefaults SparseSSHOptions,
) []CredentialUsage {
	// Build group lookup by ID for name resolution.
	groupByID := make(map[string]ProfileGroup, len(groups))
	for _, g := range groups {
		groupByID[g.ID] = g
	}

	// usage maps credential ID -> list of ProfileRefs.
	// Pre-populate with every credential so unused ones appear with empty slices.
	//
	// The empty slice is deliberate and load-bearing: a nil slice marshals to
	// `"profiles": null`, and the renderer's field is typed as an array. A Go
	// test asserting len(refs) == 0 passes either way, which is exactly how the
	// wrong wire format stays green.
	usage := make(map[string][]ProfileRef, len(credentials))
	for _, c := range credentials {
		usage[c.ID] = []ProfileRef{}
	}

	// Resolve every profile and find which credential it resolves to.
	for _, p := range profiles {
		eff, err := ResolveEffectiveProfile(p, groups, globalDefaults)
		if err != nil {
			continue // skip unresolvable profiles
		}

		src, hasCred := eff.Source["credentialId"]
		if !hasCred {
			continue
		}

		credID := eff.ResolvedOptions.CredentialID
		if credID == "" {
			continue
		}

		ref := ProfileRef{
			ProfileID:   p.ID,
			ProfileName: p.Name,
		}

		if string(src) == string(FieldSourceProfile) {
			ref.Source = ProfileRefSourceProfile
		} else if strings.HasPrefix(string(src), "group:") {
			ref.Source = ProfileRefSourceGroup
			gid := strings.TrimPrefix(string(src), "group:")
			ref.GroupID = gid
			if g, ok := groupByID[gid]; ok {
				ref.GroupName = g.Name
			}
		} else if string(src) == string(FieldSourceGlobal) {
			// Global defaults have no store yet (profile.go:245) and the
			// transport passes an empty layer, so this cannot occur in the
			// running product — but the engine supports it and this function
			// takes the layer as a parameter, so dropping it would be a silent
			// undercount the day a store appears. It is a named third source,
			// not an undocumented string leaking into the field the renderer
			// switches on. See nocx-p15s.
			ref.Source = ProfileRefSourceGlobal
		} else {
			// FieldSourceDefault is the only source left, and the hardcoded
			// defaults are port, user and behaviorOnSessionEnd — none of them
			// can supply a credentialId.
			continue
		}

		usage[credID] = append(usage[credID], ref)
	}

	// Convert to sorted slice for deterministic output.
	result := make([]CredentialUsage, 0, len(usage))
	for credID, refs := range usage {
		result = append(result, CredentialUsage{
			CredentialID: credID,
			Profiles:     refs,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].CredentialID < result[j].CredentialID
	})

	return result
}
