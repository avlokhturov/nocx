package transport

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/shady2k/nocx/internal/profile"
)

// ---------------------------------------------------------------------------
// groups.impact — compute the effect of a proposed group change
// ---------------------------------------------------------------------------

// groupImpactParams is the request for groups.impact.
// For an update preview, set Group. For a delete preview, set DeleteGroupID.
type groupImpactParams struct {
	Group         *profile.ProfileGroup `json:"group,omitempty"`
	DeleteGroupID string                `json:"deleteGroupId,omitempty"`
}

func (p groupImpactParams) validate() error {
	if p.Group != nil && p.DeleteGroupID != "" {
		return errors.New("only one of group or deleteGroupId may be set")
	}
	if p.Group == nil && p.DeleteGroupID == "" {
		return errors.New("either group or deleteGroupId is required")
	}
	if p.Group != nil && p.Group.ID == "" {
		return errors.New("group.id is required")
	}
	return nil
}

// fieldDiff describes one effective-field change.
type fieldDiff struct {
	Field     string      `json:"field"`
	OldValue  interface{} `json:"oldValue,omitempty"`
	NewValue  interface{} `json:"newValue,omitempty"`
	Dangerous bool        `json:"dangerous"`
}

// profileImpact describes the effective-field diff for one profile.
type profileImpact struct {
	ProfileID   string      `json:"profileId"`
	ProfileName string      `json:"profileName"`
	Diffs       []fieldDiff `json:"diffs"`
}

// deleteImpact describes what happens to children on group deletion.
type deleteImpact struct {
	Action           string   `json:"action"`                     // "promote_to_root", "refuse"
	Reason           string   `json:"reason"`                     // human-readable explanation
	AffectedGroupIDs []string `json:"affectedGroupIds,omitempty"` // child groups that would be reparented
}

// groupImpactResponse is the response for groups.impact.
type groupImpactResponse struct {
	Dangerous        bool            `json:"dangerous"`
	AffectedProfiles []profileImpact `json:"affectedProfiles,omitempty"`
	DeleteImpact     *deleteImpact   `json:"deleteImpact,omitempty"`
}

// dangerousFields is the set of field names whose change is auth-affecting.
var dangerousFields = map[string]bool{
	"credentialId": true,
	"user":         true,
	"auth":         true,
	"jumpHost":     true,
	"port":         true,
}

func isDangerousField(field string) bool {
	return dangerousFields[field]
}

func (s *WSServer) handleGroupImpact(wconn *wsConn, req jsonrpcRequest) {
	if s.groups == nil || s.profiles == nil || s.credMeta == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "groups not available"))
		return
	}

	var params groupImpactParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := params.validate(); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, err.Error()))
		return
	}

	allProfiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	allGroups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	// Load credentials for credential-layer resolution.
	allCreds, err := s.credMeta.LoadCredentials()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	if params.Group != nil {
		resp := computeGroupUpdateImpact(*params.Group, allProfiles, allGroups, allCreds)
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
	} else {
		resp := computeGroupDeleteImpact(params.DeleteGroupID, allProfiles, allGroups, allCreds)
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
	}
}

// computeGroupUpdateImpact computes the impact of updating a group's
// ParentGroupID or Defaults. Returns the impact response.
func computeGroupUpdateImpact(
	proposed profile.ProfileGroup,
	allProfiles []profile.SSHProfile,
	allGroups []profile.ProfileGroup,
	allCreds []profile.Credential,
) groupImpactResponse {
	// Find the current group position.
	curIdx := -1
	for i, g := range allGroups {
		if g.ID == proposed.ID {
			curIdx = i
			break
		}
	}
	if curIdx < 0 {
		return groupImpactResponse{
			Dangerous: false,
			DeleteImpact: &deleteImpact{
				Action: "refuse",
				Reason: fmt.Sprintf("group %q not found", proposed.ID),
			},
		}
	}

	// Build modified group list: replace the current group with the proposed one.
	modifiedGroups := make([]profile.ProfileGroup, len(allGroups))
	copy(modifiedGroups, allGroups)
	modifiedGroups[curIdx] = proposed

	// Validate the modified group tree.
	if err := profile.ValidateGroupTree(modifiedGroups); err != nil {
		return groupImpactResponse{
			Dangerous: false,
			DeleteImpact: &deleteImpact{
				Action: "refuse",
				Reason: err.Error(),
			},
		}
	}

	// Build credential lookup.
	credByID := make(map[string]profile.Credential, len(allCreds))
	for _, c := range allCreds {
		credByID[c.ID] = c
	}

	// Resolve every profile with current groups and with modified groups.
	// Collect only profiles whose effective options actually change.
	var impacts []profileImpact
	anyDangerous := false

	for _, p := range allProfiles {
		oldEff, oldErr := profile.ResolveEffectiveProfile(p, allGroups, profile.SparseSSHOptions{})
		newEff, newErr := profile.ResolveEffectiveProfile(p, modifiedGroups, profile.SparseSSHOptions{})

		// If both fail resolution the same way, nothing changed.
		if oldErr != nil && newErr != nil && oldErr.Error() == newErr.Error() {
			continue
		}

		// Apply credential layer to both.
		if oldErr == nil && oldEff.ResolvedOptions.CredentialID != "" {
			if cred, ok := credByID[oldEff.ResolvedOptions.CredentialID]; ok {
				oldEff = profile.ApplyCredentialLayer(oldEff, &cred)
			}
		}
		if newErr == nil && newEff.ResolvedOptions.CredentialID != "" {
			if cred, ok := credByID[newEff.ResolvedOptions.CredentialID]; ok {
				newEff = profile.ApplyCredentialLayer(newEff, &cred)
			}
		}

		// Compute diffs between old and new resolved options.
		diffs := diffResolvedOptions(oldEff, newEff, oldErr, newErr)
		if len(diffs) == 0 {
			continue
		}

		for _, d := range diffs {
			if d.Dangerous {
				anyDangerous = true
			}
		}

		impacts = append(impacts, profileImpact{
			ProfileID:   p.ID,
			ProfileName: p.Name,
			Diffs:       diffs,
		})
	}

	if len(impacts) == 0 {
		return groupImpactResponse{Dangerous: false}
	}

	sort.Slice(impacts, func(i, j int) bool {
		return impacts[i].ProfileID < impacts[j].ProfileID
	})

	return groupImpactResponse{
		Dangerous:        anyDangerous,
		AffectedProfiles: impacts,
	}
}

// computeGroupDeleteImpact computes the impact of deleting a group.
func computeGroupDeleteImpact(
	deleteGroupID string,
	allProfiles []profile.SSHProfile,
	allGroups []profile.ProfileGroup,
	allCreds []profile.Credential,
) groupImpactResponse {
	// Find the group to delete.
	found := false
	for _, g := range allGroups {
		if g.ID == deleteGroupID {
			found = true
			break
		}
	}
	if !found {
		return groupImpactResponse{
			DeleteImpact: &deleteImpact{
				Action: "refuse",
				Reason: fmt.Sprintf("group %q not found", deleteGroupID),
			},
		}
	}

	// Find children — groups with this group as parent.
	var childGroups []profile.ProfileGroup
	for _, g := range allGroups {
		if g.ParentGroupID == deleteGroupID {
			childGroups = append(childGroups, g)
		}
	}

	childIDs := make([]string, len(childGroups))
	for i, g := range childGroups {
		childIDs[i] = g.ID
	}

	// Build modified groups: remove the deleted group, promote children to root.
	modifiedGroups := make([]profile.ProfileGroup, 0, len(allGroups))
	for _, g := range allGroups {
		if g.ID == deleteGroupID {
			continue
		}
		if g.ParentGroupID == deleteGroupID {
			g.ParentGroupID = ""
		}
		modifiedGroups = append(modifiedGroups, g)
	}

	// Validate the modified tree.
	if err := profile.ValidateGroupTree(modifiedGroups); err != nil {
		return groupImpactResponse{
			DeleteImpact: &deleteImpact{
				Action: "refuse",
				Reason: err.Error(),
			},
		}
	}

	di := &deleteImpact{
		Action:           "promote_to_root",
		AffectedGroupIDs: childIDs,
	}
	if len(childGroups) == 0 {
		di.Reason = "group has no children"
	} else if len(childGroups) == 1 {
		di.Reason = fmt.Sprintf("1 child group (%s) will be promoted to root", childGroups[0].Name)
	} else {
		di.Reason = fmt.Sprintf("%d child groups will be promoted to root", len(childGroups))
	}

	// Build credential lookup.
	credByID := make(map[string]profile.Credential, len(allCreds))
	for _, c := range allCreds {
		credByID[c.ID] = c
	}

	// Compute profile impact.
	var impacts []profileImpact
	anyDangerous := false

	for _, p := range allProfiles {
		oldEff, oldErr := profile.ResolveEffectiveProfile(p, allGroups, profile.SparseSSHOptions{})
		newEff, newErr := profile.ResolveEffectiveProfile(p, modifiedGroups, profile.SparseSSHOptions{})

		if oldErr != nil && newErr != nil && oldErr.Error() == newErr.Error() {
			continue
		}

		if oldErr == nil && oldEff.ResolvedOptions.CredentialID != "" {
			if cred, ok := credByID[oldEff.ResolvedOptions.CredentialID]; ok {
				oldEff = profile.ApplyCredentialLayer(oldEff, &cred)
			}
		}
		if newErr == nil && newEff.ResolvedOptions.CredentialID != "" {
			if cred, ok := credByID[newEff.ResolvedOptions.CredentialID]; ok {
				newEff = profile.ApplyCredentialLayer(newEff, &cred)
			}
		}

		diffs := diffResolvedOptions(oldEff, newEff, oldErr, newErr)
		if len(diffs) == 0 {
			continue
		}

		for _, d := range diffs {
			if d.Dangerous {
				anyDangerous = true
			}
		}

		impacts = append(impacts, profileImpact{
			ProfileID:   p.ID,
			ProfileName: p.Name,
			Diffs:       diffs,
		})
	}

	sort.Slice(impacts, func(i, j int) bool {
		return impacts[i].ProfileID < impacts[j].ProfileID
	})

	return groupImpactResponse{
		Dangerous:        anyDangerous,
		AffectedProfiles: impacts,
		DeleteImpact:     di,
	}
}

// diffResolvedOptions computes the field-by-field diff between two resolved
// effective profiles. Either or both sides may be resolving with errors.
func diffResolvedOptions(oldEff, newEff profile.EffectiveProfile, oldErr, newErr error) []fieldDiff {
	var diffs []fieldDiff

	// Handle resolution changes.
	if (oldErr == nil) != (newErr == nil) {
		if oldErr == nil && newErr != nil {
			diffs = append(diffs, fieldDiff{
				Field:     "_error",
				OldValue:  "resolvable",
				NewValue:  newErr.Error(),
				Dangerous: true,
			})
		} else {
			diffs = append(diffs, fieldDiff{
				Field:     "_error",
				OldValue:  oldErr.Error(),
				NewValue:  "resolvable",
				Dangerous: true,
			})
		}
		return diffs
	}

	// Both sides have errors — no meaningful diff.
	if oldErr != nil {
		return nil
	}

	// Both sides resolved: compare individual fields.
	oldOpts := oldEff.ResolvedOptions
	newOpts := newEff.ResolvedOptions

	addDiff := func(field string, oldVal, newVal interface{}) {
		// Only report actual changes.
		if oldVal == newVal {
			return
		}
		// For string/int zero values, compare more carefully.
		diffs = append(diffs, fieldDiff{
			Field:     field,
			OldValue:  oldVal,
			NewValue:  newVal,
			Dangerous: isDangerousField(field),
		})
	}

	addDiff("credentialId", oldOpts.CredentialID, newOpts.CredentialID)
	addDiff("port", oldOpts.Port, newOpts.Port)
	addDiff("user", oldOpts.User, newOpts.User)
	addDiff("auth", oldOpts.Auth, newOpts.Auth)
	addDiff("jumpHost", oldOpts.JumpHost, newOpts.JumpHost)
	addDiff("keepaliveInterval", oldOpts.KeepaliveInterval, newOpts.KeepaliveInterval)
	addDiff("keepaliveCountMax", oldOpts.KeepaliveCountMax, newOpts.KeepaliveCountMax)
	addDiff("readyTimeout", oldOpts.ReadyTimeout, newOpts.ReadyTimeout)
	addDiff("agentForward", oldOpts.AgentForward, newOpts.AgentForward)
	return diffs
}

// ---------------------------------------------------------------------------
// groups.apply —  apply one or more group changes atomically
// ---------------------------------------------------------------------------

// handleGroupApply applies one or more full group updates atomically. The
// renderer MUST have called groups.impact first and shown the result to the
// user. This is the write path for ParentGroupID and Defaults changes.
//
// Unlike the old handler which called LoadGroups() → validate → UpdateGroup(g)
// in three separate lock acquisitions, this handler delegates to the store's
// ApplyGroups which loads, validates, and writes under a single lock.
func (s *WSServer) handleGroupApply(wconn *wsConn, req jsonrpcRequest) {
	if s.groups == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "groups not available"))
		return
	}

	var groups []profile.ProfileGroup
	if err := json.Unmarshal(req.Params, &groups); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if len(groups) == 0 {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "groups required"))
		return
	}

	ag, ok := s.groups.(interface {
		ApplyGroups([]profile.ProfileGroup) error
	})
	if !ok {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "group store does not support atomic apply"))
		return
	}
	if err := ag.ApplyGroups(groups); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, profileMethodErrorCode(err), err.Error()))
		return
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(groups)))
}
