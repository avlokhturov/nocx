package transport

// The config-domain control handlers as constructed types (migration map,
// "profiles.* / groups.* / settings.* — the config domain"): each handler
// holds a ConfigOperation (gates [config, vault] — the row-resolving write
// paths and the secret-class settings are vault-backed) or a
// TabbyImportOperation, plus the Responder. Never the *WSServer: a handler
// constructed with the operation cannot reach a store it was not given.
//
// The pure wire helpers (wireProfile, wireGroup, wireEffectiveSecretFields,
// vault.RowFor, optionsToWire) stay here — they map stored references to
// renderer row handles and touch no store. Row-handle RESOLUTION now lives
// in ConfigService (migration map delete-list: optionsFromWire, groupFromWire,
// sparseFromWire, secretRowInputs, rowToSecretRef are gone).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/importer"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/settings"
	"github.com/shady2k/nocx/internal/transport/control"
	"github.com/shady2k/nocx/internal/vault"
)

// settingsSetParams carries the key and the untyped value.
type settingsSetParams struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// settingsResetParams carries the key to reset.
type settingsResetParams struct {
	Key string `json:"key"`
}

// settingsSecretSetParams carries the key and the secret value.
type settingsSecretSetParams struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// settingsSecretDeleteParams carries the key to delete.
type settingsSecretDeleteParams struct {
	Key string `json:"key"`
}

// settingsSecretExistsParams carries the key to check.
type settingsSecretExistsParams struct {
	Key string `json:"key"`
}

// profileHandlers answers the profiles.* methods. wired is true when the
// profile repository is wired; the old handler answered -32601 "profiles not
// available" without it, and the tests assert that.
type profileHandlers struct {
	op    capability.ConfigOperation // nil → config domain not wired
	wired bool                       // profile repository wired
	r     Responder
}

func (h profileHandlers) handleMethod(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		switch req.Method {
		case "profiles.list":
			profs, err := svc.ListProfiles()
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
				return nil
			}
			// Secret references stay backend-owned: hand the renderer row handles.
			for i := range profs {
				profs[i] = wireProfile(profs[i])
			}
			_ = h.r.TryResult(req.ID, mustMarshal(profs))
		case "profiles.create":
			var p profile.SSHProfile
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			// Mint an ID when the renderer sends none.
			if p.ID == "" {
				p.ID = profile.NewProfileID("ssh", p.Name)
			}
			// The renderer names secrets by row handle; the service resolves
			// them to references before storage (migration map).
			if err := svc.CreateProfile(p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireProfile(p)))
		case "profiles.update":
			var p profile.SSHProfile
			if err := json.Unmarshal(req.Params, &p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if p.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			if err := svc.UpdateProfile(p); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireProfile(p)))
		case "profiles.delete":
			var params struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if err := svc.DeleteProfile(params.ID); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(true))
		case "profiles.effective":
			h.handleEffective(ctx, svc, req)
		case "profiles.patch":
			h.handlePatch(ctx, svc, req)
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleEffective is the batched effective-profile resolution (profiles.effective).
func (h profileHandlers) handleEffective(ctx context.Context, svc capability.ConfigService, req jsonrpcRequest) {
	var params effectiveParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	if len(params.IDs) == 0 {
		_ = h.r.TryResult(req.ID, mustMarshal(effectiveResponse{}))
		return
	}

	allProfiles, err := svc.ListProfiles()
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("load profiles: %v", err)})
		return
	}
	allGroups, err := svc.ListGroups()
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("load groups: %v", err)})
		return
	}
	// Build lookups first.
	profByID := make(map[string]profile.SSHProfile, len(allProfiles))
	for _, p := range allProfiles {
		profByID[p.ID] = p
	}
	groupByID := make(map[string]profile.ProfileGroup, len(allGroups))
	for _, g := range allGroups {
		groupByID[g.ID] = g
	}

	var dtos []profile.EffectiveProfileDTO
	var errs []profileErrorEntry

	for _, id := range params.IDs {
		p, ok := profByID[id]
		if !ok {
			errs = append(errs, profileErrorEntry{ID: id, Error: "profile not found"})
			continue
		}

		// Identity lives inline on the profile (ADR-0017): the effective
		// options are the resolved options.
		eff, err := profile.ResolveEffectiveProfile(p, allGroups, profile.SparseSSHOptions{})
		if err != nil {
			errs = append(errs, profileErrorEntry{ID: id, Error: err.Error()})
			continue
		}

		// Secret references stay backend-owned: hand the renderer row handles.
		dto := profile.ToEffectiveDTO(eff, groupByID)
		wireEffectiveSecretFields(&dto)
		dtos = append(dtos, dto)
	}

	_ = h.r.TryResult(req.ID, mustMarshal(effectiveResponse{
		Profiles: dtos,
		Errors:   errs,
	}))
}

// handlePatch applies explicit set/unset operations (profiles.patch). The
// mutation and the follow-up read run inside ONE operation, so the read
// observes the awaited mutation under the same gate (the transport never
// promises FIFO between separately-admitted requests).
func (h profileHandlers) handlePatch(ctx context.Context, svc capability.ConfigService, req jsonrpcRequest) {
	var params patchParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	if err := validatePatch(params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
		return
	}

	allProfiles, listErr := svc.ListProfiles()
	if listErr != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("load profiles: %v", listErr)})
		return
	}
	var target *profile.SSHProfile
	for i := range allProfiles {
		if allProfiles[i].ID == params.ID {
			target = &allProfiles[i]
			break
		}
	}
	if target == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: fmt.Sprintf("profile %q not found", params.ID)})
		return
	}
	_ = target

	// PatchProfile resolves the three secret paths' row handles, applies the
	// set/unset operations, validates, and persists — one store write, the
	// same validation the old handler performed in line. Its failures are the
	// service's fixed vocabulary: the row-resolution and type validations
	// (client errors) and the store failures.
	if err := svc.PatchProfile(params.ID, params.Set, params.Unset); err != nil {
		code := profileMethodErrorCode(err)
		if patchValidationError(err) {
			code = -32602
		}
		_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error()})
		return
	}

	// The effective profile for the response is derived from the STORED
	// state after the patch, so the response never shows a half-applied set.
	after, err := svc.ListProfiles()
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("load profiles: %v", err)})
		return
	}
	var patched *profile.SSHProfile
	for i := range after {
		if after[i].ID == params.ID {
			patched = &after[i]
			break
		}
	}
	if patched == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("resolve after patch: profile %q not found", params.ID)})
		return
	}
	allGroups, err := svc.ListGroups()
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("load groups: %v", err)})
		return
	}
	groupByID := make(map[string]profile.ProfileGroup, len(allGroups))
	for _, g := range allGroups {
		groupByID[g.ID] = g
	}

	// Resolve effective profile from the patched stored options directly.
	eff, err := profile.ResolveEffectiveProfile(*patched, allGroups, profile.SparseSSHOptions{})
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("resolve after patch: %v", err)})
		return
	}

	dto := profile.ToEffectiveDTO(eff, groupByID)
	wireEffectiveSecretFields(&dto)
	_ = h.r.TryResult(req.ID, mustMarshal(dto))
}

// patchValidationError reports whether a PatchProfile error is one of the
// service's fixed validation failures (a client error, -32602) rather than a
// store failure. The capability service collapses validation and store
// failures into one error value, and its vocabulary is closed — these
// literals are the service's own texts (config.go), never request data, so
// matching them is not matching user input.
func patchValidationError(err error) bool {
	for _, lit := range []string{
		"must be a string",
		"host is required and cannot be unset",
		"no vault: cannot resolve a secret row",
		"unknown secret row",
	} {
		if strings.Contains(err.Error(), lit) {
			return true
		}
	}
	return false
}

// groupHandlers answers the groups.* methods. wired is true when the group
// repository is wired (-32601 "groups not available" without it).
type groupHandlers struct {
	op    capability.ConfigOperation
	wired bool // group repository wired
	r     Responder
}

func (h groupHandlers) handleMethod(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "groups not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		switch req.Method {
		case "groups.list":
			groups, err := svc.ListGroups()
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
				return nil
			}
			// The renderer addresses secret bindings by row handle (ADR-0011 §2):
			// convert every stored reference in the defaults before marshaling.
			for i := range groups {
				groups[i] = wireGroup(groups[i])
			}
			_ = h.r.TryResult(req.ID, mustMarshal(groups))
		case "groups.create":
			var g profile.ProfileGroup
			if err := json.Unmarshal(req.Params, &g); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			// Mint an ID when the renderer sends none, as profiles.create does.
			if g.ID == "" {
				g.ID = profile.NewGroupID(g.Name)
			}
			// The service resolves the defaults' row handles to stored
			// references before storage (migration map).
			if err := svc.CreateGroup(g); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireGroup(g)))
		case "groups.update":
			var g profile.ProfileGroup
			if err := json.Unmarshal(req.Params, &g); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if g.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			// Resolve the defaults' row handles before comparing against
			// storage, or the guard below would see every secret binding as
			// a change (nocx: the defaults guard compares resolved
			// references, never a row against a ref).
			resolved, werr := svc.ResolveGroup(g)
			if werr != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: werr.Error()})
				return nil
			}
			// Guard: ParentGroupID and Defaults cannot be changed through
			// generic CRUD — the renderer MUST use groups.impact +
			// groups.apply (migration map: the guard stays in the handler,
			// reading via ListGroups).
			allGroups, loadErr := svc.ListGroups()
			if loadErr != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: loadErr.Error()})
				return nil
			}
			var stored *profile.ProfileGroup
			for i := range allGroups {
				if allGroups[i].ID == g.ID {
					stored = &allGroups[i]
					break
				}
			}
			if stored == nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "group not found"})
				return nil
			}
			if g.ParentGroupID != stored.ParentGroupID {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "ParentGroupId can only be changed through groups.apply, not groups.update"})
				return nil
			}
			if defaultsChanged(stored.Defaults, resolved.Defaults) {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Defaults can only be changed through groups.apply, not groups.update"})
				return nil
			}
			if err := svc.UpdateGroup(resolved); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(wireGroup(g)))
		case "groups.delete":
			var params struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if params.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			// Use atomic delete (promotes children to root).
			if err := svc.DeleteGroupAtomic(params.ID); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(true))
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleGroupImpact computes the effect of a proposed group change.
func (h groupHandlers) handleGroupImpact(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "groups not available"})
		return
	}
	var params groupImpactParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := params.validate(); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		allProfiles, err := svc.ListProfiles()
		if err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
			return nil
		}
		allGroups, err := svc.ListGroups()
		if err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
			return nil
		}

		if params.Group != nil {
			// The renderer proposes bindings by row handle: resolve them to
			// stored references before computing impact, or the resolution
			// of the proposed defaults would carry row handles into the
			// diff (and the response must never leak references — the
			// diff layer re-derives rows from the resolved values).
			proposed, werr := svc.ResolveGroup(*params.Group)
			if werr != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: werr.Error()})
				return nil
			}
			resp := computeGroupUpdateImpact(proposed, allProfiles, allGroups)
			_ = h.r.TryResult(req.ID, mustMarshal(resp))
		} else {
			resp := computeGroupDeleteImpact(params.DeleteGroupID, allProfiles, allGroups)
			_ = h.r.TryResult(req.ID, mustMarshal(resp))
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleProfileMoveImpact computes the effect of moving profiles to a group.
func (h groupHandlers) handleProfileMoveImpact(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params profileMoveImpactParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := params.validate(); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		allProfiles, err := svc.ListProfiles()
		if err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
			return nil
		}
		allGroups, err := svc.ListGroups()
		if err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
			return nil
		}

		resp := computeProfileMoveImpact(params.ProfileIDs, params.TargetGroupID, allProfiles, allGroups)
		_ = h.r.TryResult(req.ID, mustMarshal(resp))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleGroupApply applies one or more group changes atomically.
func (h groupHandlers) handleGroupApply(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "groups not available"})
		return
	}
	var groups []profile.ProfileGroup
	if err := json.Unmarshal(req.Params, &groups); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if len(groups) == 0 {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "groups required"})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		// The service resolves the renderer's row handles and applies the
		// groups under one store write (migration map: ApplyGroups, atomic;
		// row-resolving).
		if err := svc.ApplyGroups(groups); err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: profileMethodErrorCode(err), Message: err.Error()})
			return nil
		}
		// The echo carries the row handles the renderer addressed, never the
		// stored references (ADR-0011 §2).
		for i := range groups {
			groups[i] = wireGroup(groups[i])
		}
		_ = h.r.TryResult(req.ID, mustMarshal(groups))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// settingsHandlers answers the settings.* methods. The settings surface is a
// sub-surface of the config domain (ConfigService.Settings()); wired is true
// when the settings registry is wired — the old handler answered the odd
// -32601 "Method not found" without it, and the tests assert that.
type settingsHandlers struct {
	op    capability.ConfigOperation
	wired bool // settings registry wired
	r     Responder
}

func (h settingsHandlers) handleMethod(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "Method not found"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		ss := svc.Settings()
		switch req.Method {
		case "settings.describe":
			_ = h.r.TryResult(req.ID, mustMarshal(map[string]any{
				"declarations": ss.Declarations(),
			}))
		case "settings.getSnapshot":
			snap, err := ss.GetSnapshot()
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "settings.getSnapshot: " + err.Error()})
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(map[string]any{
				"values":     snap.Values,
				"overridden": snap.Overridden,
				"revision":   snap.Revision,
			}))
		case "settings.set":
			h.handleSet(ss, req)
		case "settings.reset":
			h.handleReset(ss, req)
		case "settings.secretSet":
			h.handleSecretSet(ss, req)
		case "settings.secretDelete":
			h.handleSecretDelete(ss, req)
		case "settings.secretExists":
			h.handleSecretExists(ss, req)
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// findDescriptorByKey looks up a setting declaration by key.
func findDescriptorByKey(ss capability.SettingsService, key string) settings.Descriptor {
	for _, d := range ss.Descriptors() {
		if d.Key() == key {
			return d
		}
	}
	return nil
}

func (h settingsHandlers) handleSet(ss capability.SettingsService, req jsonrpcRequest) {
	var p settingsSetParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	desc := findDescriptorByKey(ss, p.Key)
	if desc == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Unknown setting: " + p.Key})
		return
	}
	if desc.Control() == settings.ControlSecret {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Secret settings must use settings.secretSet"})
		return
	}

	var setErr error
	switch desc.Control() {
	case settings.ControlToggle:
		var b bool
		if err := json.Unmarshal(p.Value, &b); err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid value: expected boolean"})
			return
		}
		bk, ok := desc.(*settings.Bool)
		if !ok {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as a toggle but is not a Bool key"})
			return
		}
		setErr = ss.SetBool(bk, b)
	case settings.ControlText:
		var str string
		if err := json.Unmarshal(p.Value, &str); err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid value: expected string"})
			return
		}
		sk, ok := desc.(*settings.String)
		if !ok {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as text but is not a String key"})
			return
		}
		setErr = ss.SetString(sk, str)
	case settings.ControlNumber:
		var n float64
		if err := json.Unmarshal(p.Value, &n); err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid value: expected number"})
			return
		}
		nk, ok := desc.(*settings.Number)
		if !ok {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as a number but is not a Number key"})
			return
		}
		setErr = ss.SetNumber(nk, n)
	case settings.ControlSelect:
		var str string
		if err := json.Unmarshal(p.Value, &str); err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid value: expected string"})
			return
		}
		sk, ok := desc.(*settings.Select)
		if !ok {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as a select but is not a Select key"})
			return
		}
		setErr = ss.SetSelect(sk, str)
	}

	if setErr != nil {
		if errors.Is(setErr, settings.ErrValidation) {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: setErr.Error()})
			return
		}
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: setErr.Error()})
		return
	}

	_ = h.r.TryResult(req.ID, mustMarshal(map[string]bool{"ok": true}))
}

// tabbyHandlers answers the Tabby import methods. The parse/plan logic stays
// in the handler (it owns the Tabby YAML grammar); the TabbyImportService is
// the only store access (migration map). configWired controls the
// "profiles not available" refusal; executeWired the "import not available"
// refusal; storeWired the "credential store not available" refusal — all
// three are the old handler's nil-checks, preserved as construction facts.
type tabbyHandlers struct {
	op           capability.TabbyImportOperation
	configWired  bool // profiles + groups wired
	executeWired bool // + credential store + profile service wired
	storeWired   bool // credential store wired (secrets can be minted)
	plans        tabbyPlanStore
	providerName func(context.Context) string // transport-owned answer to "which store would hold imported secrets"
	log          log.Logger
	r            Responder
}

func (h settingsHandlers) handleReset(ss capability.SettingsService, req jsonrpcRequest) {
	var p settingsResetParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	desc := findDescriptorByKey(ss, p.Key)
	if desc == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Unknown setting: " + p.Key})
		return
	}

	if err := ss.Reset(desc); err != nil {
		if errors.Is(err, settings.ErrValidation) {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
			return
		}
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "settings.reset: " + err.Error()})
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(map[string]bool{"ok": true}))
}

func (h settingsHandlers) handleSecretSet(ss capability.SettingsService, req jsonrpcRequest) {
	var p settingsSecretSetParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	desc := findDescriptorByKey(ss, p.Key)
	if desc == nil || desc.Control() != settings.ControlSecret {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Not a secret setting: " + p.Key})
		return
	}

	sk, ok := desc.(*settings.Secret)
	if !ok {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as secret but is not a Secret key"})
		return
	}
	if err := ss.SecretSet(sk, p.Value); err != nil {
		_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "settings.secretSet: ", err))
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(map[string]bool{"ok": true}))
}

func (h settingsHandlers) handleSecretDelete(ss capability.SettingsService, req jsonrpcRequest) {
	var p settingsSecretDeleteParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	desc := findDescriptorByKey(ss, p.Key)
	if desc == nil || desc.Control() != settings.ControlSecret {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Not a secret setting: " + p.Key})
		return
	}

	sk, ok := desc.(*settings.Secret)
	if !ok {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as secret but is not a Secret key"})
		return
	}
	if err := ss.SecretDelete(sk); err != nil {
		_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "settings.secretDelete: ", err))
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(map[string]bool{"ok": true}))
}

func (h settingsHandlers) handleSecretExists(ss capability.SettingsService, req jsonrpcRequest) {
	var p settingsSecretExistsParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	desc := findDescriptorByKey(ss, p.Key)
	if desc == nil || desc.Control() != settings.ControlSecret {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Not a secret setting: " + p.Key})
		return
	}

	sk, ok := desc.(*settings.Secret)
	if !ok {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Setting " + p.Key + " is declared as secret but is not a Secret key"})
		return
	}
	exists, err := ss.SecretExists(sk)
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "settings.secretExists: " + err.Error()})
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(map[string]bool{"exists": exists}))
}

// tabbyPlanStore is the transport-owned one-time import plan store: plans
// are decrypted server-side and never reach the renderer; the handler gets
// exactly the four plan-lifecycle operations, nothing else.
type tabbyPlanStore interface {
	storePlan(plan *importPlan) (string, error)
	claimPlan(token string) *importPlan
	releasePlan(token string)
	finishPlan(token string)
}

// handleTabbyPreview parses a Tabby config and returns a preview of what
// would be imported, without writing anything. Uses planTabbyImport for the
// shared planning logic.
func (h tabbyHandlers) handleTabbyPreview(ctx context.Context, req jsonrpcRequest) {
	if !h.configWired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params struct {
		Config     string `json:"config"`
		Passphrase string `json:"passphrase,omitempty"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Config == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: config (YAML string) required"})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.TabbyImportService) error {
		plan, preview, err := h.planTabbyImport(ctx, svc, params.Config, params.Passphrase)
		if err != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "Tabby preview: ", err))
			return nil
		}
		_ = plan // stored server-side by preview.PlanToken
		_ = h.r.TryResult(req.ID, mustMarshal(preview))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleTabbyExecute executes a previously previewed Tabby import plan.
// Takes the plan token from the preview response.
func (h tabbyHandlers) handleTabbyExecute(ctx context.Context, req jsonrpcRequest) {
	if !h.executeWired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "import not available"})
		return
	}
	var params tabbyExecuteParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.PlanToken == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: planToken required"})
		return
	}

	// Claim the plan so concurrent calls for the same token are rejected.
	plan := h.plans.claimPlan(params.PlanToken)
	if plan == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Plan not found, expired, or already in progress. Please preview again."})
		return
	}

	// On any failure, release the plan for retry (vault setup/unlock flow).
	var succeeded bool
	defer func() {
		if !succeeded {
			h.plans.releasePlan(params.PlanToken)
		}
	}()

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.TabbyImportService) error {
		// Mint every secret, binding each password onto the profile whose
		// options match the target the tabby vault keyed it to (ADR-0017 §1).
		// Passphrases are minted as unbound rows: a passphrase belongs to a
		// private key the import cannot fingerprint, and the connection
		// editor binds it.
		for _, cp := range plan.creds {
			kind := vault.KindPassword
			if cp.isPassphrase {
				kind = vault.KindKeyPassphrase
			}
			secretID, err := svc.CreateSecret(ctx, credential.NewSecret(cp.secret),
				vault.SecretMeta{Name: cp.name, Kind: kind})
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "Store secret: ", err))
				return nil
			}
			if cp.isPassphrase {
				continue
			}
			for i := range plan.profiles {
				o := &plan.profiles[i].Options
				port := 0
				if o.Port != nil {
					port = *o.Port
				}
				user := ""
				if o.User != nil {
					user = *o.User
				}
				if user == cp.targetUser && o.Host == cp.targetHost && port == cp.targetPort {
					o.PasswordSecret = string(secretID)
					break
				}
			}
		}

		// No credential records are imported: the bindings live on the profiles.
		result := svc.AtomicImport(plan.profiles, plan.groups)
		if len(result.ImportErrors) > 0 {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Import failed: " + result.ImportErrors[0]})
			return nil
		}

		// All writes succeeded — remove the plan permanently.
		h.plans.finishPlan(params.PlanToken)
		succeeded = true
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// handleImportTabby is the one-shot import: parse, decrypt, mint every
// secret, then atomically import the profiles and groups.
func (h tabbyHandlers) handleImportTabby(ctx context.Context, req jsonrpcRequest) {
	if !h.configWired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "profiles not available"})
		return
	}
	var params struct {
		Config     string `json:"config"`
		Passphrase string `json:"passphrase,omitempty"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Config == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: config (YAML string) required"})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.TabbyImportService) error {
		h.doImportTabby(ctx, svc, params, req)
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// doImportTabby is the shared import body; it responds to req on every path.
func (h tabbyHandlers) doImportTabby(ctx context.Context, svc capability.TabbyImportService, params struct {
	Config     string `json:"config"`
	Passphrase string `json:"passphrase,omitempty"`
}, req jsonrpcRequest,
) {
	cfg, err := importer.ParseTabbyConfig([]byte(params.Config))
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Parse Tabby config: " + err.Error()})
		return
	}

	// Decrypt vault and build credentials + profile matching.
	// Profiles carry their secret bindings directly (ADR-0017): the minted
	// password reference goes into the profile's own options, matched by the
	// connection target the tabby vault keyed it to.
	type pwKey struct {
		user, host string
		port       int
	}
	pwLookup := make(map[pwKey]credential.SecretID)

	if cfg.Vault != nil && cfg.Vault.Encrypted {
		if !h.storeWired {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "Store secret: ", errors.New("credential store not available")))
			return
		}
		if params.Passphrase == "" {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Vault is encrypted: passphrase required"})
			return
		}
		vaultContents, err := importer.DecryptTabbyVault(cfg.Vault, params.Passphrase)
		if err != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "Decrypt vault: ", err))
			return
		}

		// Plan every secret before creating any, so a shape we cannot read
		// never leaves an orphaned secret behind.
		//
		// A secret we cannot interpret is SKIPPED, never fatal. Tabby's vault
		// is shared by every plugin the user has installed, so an unknown type
		// is normal rather than exceptional — and aborting on one would throw
		// away the profiles and groups that imported fine. The shapes below are
		// verified against tabby-ssh/src/services/passwordStorage.service.ts.
		type secretPlan struct {
			ts        importer.TabbySecret
			val       string
			keyName   string // private-key identifier (key-passphrase)
			keyTarget *pwKey // connection target (password)
		}
		plans := make([]secretPlan, 0, len(vaultContents.DecodedSecrets()))
		skipped := 0
		for _, sec := range vaultContents.DecodedSecrets() {
			var val string
			if err := json.Unmarshal(sec.Value, &val); err != nil || val == "" {
				h.log.Warn("tabby import: skipping secret with unreadable value", "type", sec.Type)
				skipped++
				continue
			}
			switch sec.Type {
			case "ssh:password":
				// getVaultKeyForConnection → {user, host, port}
				var t struct {
					User string `json:"user"`
					Host string `json:"host"`
					Port int    `json:"port"`
				}
				if err := json.Unmarshal(sec.Key, &t); err != nil || t.Host == "" {
					h.log.Warn("tabby import: skipping password secret with unreadable key")
					skipped++
					continue
				}
				plans = append(plans, secretPlan{
					ts:        sec,
					val:       val,
					keyTarget: &pwKey{user: t.User, host: t.Host, port: t.Port},
				})
			case "ssh:key-passphrase":
				// getVaultKeyForPrivateKey → {hash: id}. It is an object, not a
				// string: reading it as a string failed for every real Tabby
				// vault and, before this, aborted the whole import.
				var k struct {
					Hash string `json:"hash"`
				}
				if err := json.Unmarshal(sec.Key, &k); err != nil || k.Hash == "" {
					h.log.Warn("tabby import: skipping key-passphrase secret with unreadable key")
					skipped++
					continue
				}
				plans = append(plans, secretPlan{ts: sec, val: val, keyName: privateKeyLabel(k.Hash)})
			default:
				// Everything else, including Tabby's "file" secrets. Those hold
				// base64 file CONTENT — usually a private key — which is not a
				// credential secret and does not belong in a password slot.
				// Importing key material is its own feature, not a side effect
				// of this one.
				h.log.Info("tabby import: skipping secret of unhandled type", "type", sec.Type)
				skipped++
			}
		}
		if skipped > 0 {
			h.log.Info("tabby import: some vault secrets were not imported", "skipped", skipped, "imported", len(plans))
		}

		// All secrets validated. Create each one in the SecretStore, carrying
		// the name the credential will bear (ADR-0016: the secret owns its
		// name, and an import mints both together).
		for _, p := range plans {
			name := p.keyName
			kind := vault.KindKeyPassphrase
			if p.ts.Type == "ssh:password" {
				name = p.keyTarget.user + "@" + p.keyTarget.host
				kind = vault.KindPassword
			}
			secretID, err := svc.CreateSecret(ctx, credential.NewSecret(p.val),
				vault.SecretMeta{Name: name, Kind: kind})
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "Store secret: ", err))
				return
			}
			switch p.ts.Type {
			case "ssh:password":
				// The secret is bound to the connection it belongs to; no
				// credential record is minted (ADR-0017 §1).
				pwLookup[*p.keyTarget] = secretID
			case "ssh:key-passphrase":
				// Passphrases stay unbound rows: a passphrase belongs to a
				// private key, and the imported key is a path whose
				// fingerprint is not readable at import time. The connection
				// editor's secret picker binds it where the user chooses.
				_ = p.keyName
			}
		}
	}

	// Domain service path: atomic import.
	var profiles []profile.SSHProfile
	for _, tp := range cfg.Profiles {
		if tp.Type != "ssh" {
			continue
		}
		p := importer.ConvertProfile(tp)
		if p.Options.User != nil && p.Options.Host != "" {
			port := 0
			if p.Options.Port != nil {
				port = *p.Options.Port
			}
			user := ""
			if p.Options.User != nil {
				user = *p.Options.User
			}
			if secretID, ok := pwLookup[pwKey{user: user, host: p.Options.Host, port: port}]; ok {
				p.Options.PasswordSecret = string(secretID)
			}
		}
		profiles = append(profiles, p)
	}

	var groups []profile.ProfileGroup
	for _, tg := range cfg.Groups {
		var defaults *profile.ProfileDefaults
		if tg.Defaults != nil {
			d, err := profile.DecodeDefaults(tg.Defaults)
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: fmt.Sprintf("Import failed: group %q defaults: %v", tg.Name, err)})
				return
			}
			defaults = &d
		}
		groups = append(groups, profile.ProfileGroup{
			ID:            tg.ID,
			ParentGroupID: tg.ParentGroupID,
			Name:          tg.Name,
			Icon:          tg.Icon,
			Color:         tg.Color,
			Defaults:      defaults,
			Editable:      true,
		})
	}

	result := svc.AtomicImport(profiles, groups)
	if len(result.ImportErrors) > 0 {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: "Import failed: " + result.ImportErrors[0]})
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(result.ProfilesImported))
}

// planTabbyImport parses a Tabby config, decrypts its vault (if passphrase
// supplied), and plans every profile, group, and secret WITHOUT writing
// anything. Returns the full importPlan for execution and a preview response
// for the renderer. The plan is stored server-side by the returned token.
// The only store access is through the TabbyImportService (the collision
// reads); everything else is pure parsing.
func (h tabbyHandlers) planTabbyImport(ctx context.Context, svc capability.TabbyImportService, configYAML, passphrase string) (*importPlan, *TabbyPreviewResponse, error) {
	cfg, err := importer.ParseTabbyConfig([]byte(configYAML))
	if err != nil {
		return nil, nil, err
	}

	// Decrypt vault and build secret plans. Each password plan carries
	// the connection target the tabby vault keyed it to, so execution can
	// bind the minted secret onto the right profile (ADR-0017 §1).
	var credentials []credentialPlan
	skipped := make([]SkippedInfo, 0)

	if cfg.Vault != nil && cfg.Vault.Encrypted {
		if passphrase == "" {
			return nil, nil, errors.New("vault is encrypted: passphrase required")
		}
		vaultContents, decryptErr := importer.DecryptTabbyVault(cfg.Vault, passphrase)
		if decryptErr != nil {
			return nil, nil, decryptErr
		}

		for _, sec := range vaultContents.DecodedSecrets() {
			var val string
			umErr := json.Unmarshal(sec.Value, &val)
			if umErr != nil || val == "" {
				skipped = append(skipped, SkippedInfo{
					SecretType: sec.Type,
					Reason:     "unreadable value",
				})
				continue
			}
			switch sec.Type {
			case "ssh:password":
				var t struct {
					User string `json:"user"`
					Host string `json:"host"`
					Port int    `json:"port"`
				}
				umErr = json.Unmarshal(sec.Key, &t)
				if umErr != nil || t.Host == "" {
					skipped = append(skipped, SkippedInfo{
						SecretType: sec.Type,
						Reason:     "unreadable key (missing host)",
					})
					continue
				}
				name := t.User + "@" + t.Host
				credentials = append(credentials, credentialPlan{
					name:       name,
					secret:     val,
					targetUser: t.User,
					targetHost: t.Host,
					targetPort: t.Port,
				})

			case "ssh:key-passphrase":
				var k struct {
					Hash string `json:"hash"`
				}
				umErr = json.Unmarshal(sec.Key, &k)
				if umErr != nil || k.Hash == "" {
					skipped = append(skipped, SkippedInfo{
						SecretType: sec.Type,
						Reason:     "unreadable key (missing hash)",
					})
					continue
				}
				keyName := privateKeyLabel(k.Hash)
				credentials = append(credentials, credentialPlan{
					name:         keyName,
					secret:       val,
					isPassphrase: true,
				})

			default:
				skipped = append(skipped, SkippedInfo{
					SecretType: sec.Type,
					Reason:     "unhandled secret type",
				})
			}
		}
	}

	// Convert profiles.
	var profiles []profile.SSHProfile
	for _, tp := range cfg.Profiles {
		if tp.Type != "ssh" {
			continue
		}
		p := importer.ConvertProfile(tp)
		// Profiles no longer link to credentials (ADR-0017): a profile's
		// secret references are backend-owned, and an import brings none.
		profiles = append(profiles, p)
	}

	// Convert groups.
	var groups []profile.ProfileGroup
	for _, tg := range cfg.Groups {
		var defaults *profile.ProfileDefaults
		if tg.Defaults != nil {
			d, decodeErr := profile.DecodeDefaults(tg.Defaults)
			if decodeErr != nil {
				return nil, nil, fmt.Errorf("group %q defaults: %w", tg.Name, decodeErr)
			}
			defaults = &d
		}
		groups = append(groups, profile.ProfileGroup{
			ID:            tg.ID,
			ParentGroupID: tg.ParentGroupID,
			Name:          tg.Name,
			Icon:          tg.Icon,
			Color:         tg.Color,
			Defaults:      defaults,
			Editable:      true,
		})
	}

	// Build per-entry preview lists.
	profileEntries := make([]ProfileEntry, 0, len(profiles))
	groupNames := make([]string, 0, len(groups))
	secretEntries := make([]SecretEntry, 0, len(credentials))

	// Determine which profiles collide (for setting their action).
	existingProfileIDs := make(map[string]bool)
	existingProfs, _ := svc.ListProfiles()
	for _, p := range existingProfs {
		existingProfileIDs[p.ID] = true
	}
	for _, p := range profiles {
		action := "new"
		if p.ID != "" && existingProfileIDs[p.ID] {
			action = "overwrite"
		}
		// No import-time credential linking remains (ADR-0017): a profile's
		// secret references are backend-owned and imports carry none.
		profileEntries = append(profileEntries, ProfileEntry{Name: p.Name, Action: action})
	}
	for _, g := range groups {
		groupNames = append(groupNames, g.Name)
	}
	for _, cp := range credentials {
		typ := "password"
		if cp.isPassphrase {
			typ = "passphrase"
		}
		secretEntries = append(secretEntries, SecretEntry{Name: cp.name, Type: typ})
	}

	// Build preview response with collision info.
	preview := &TabbyPreviewResponse{
		ProfilesToImport: len(profiles),
		GroupsToImport:   len(groups),
		SecretsToImport:  len(credentials),
		ProfileEntries:   profileEntries,
		GroupNames:       groupNames,
		SecretEntries:    secretEntries,
		SkippedSecrets:   skipped,
	}

	// Detect collisions by checking against current store state.
	existingIDs := make(map[string]bool, len(existingProfs))
	for _, p := range existingProfs {
		existingIDs[p.ID] = true
	}
	for _, p := range profiles {
		if p.ID != "" && existingIDs[p.ID] {
			preview.Collisions = append(preview.Collisions, CollisionInfo{
				Kind:   "profile",
				Name:   p.Name,
				Policy: "overwrite",
			})
		}
	}

	existingGroups, _ := svc.ListGroups()
	existingGIDs := make(map[string]bool, len(existingGroups))
	for _, g := range existingGroups {
		existingGIDs[g.ID] = true
	}
	for _, g := range groups {
		if g.ID != "" && existingGIDs[g.ID] {
			preview.Collisions = append(preview.Collisions, CollisionInfo{
				Kind:   "group",
				Name:   g.Name,
				Policy: "overwrite",
			})
		}
	}

	// Determine secret provider.
	preview.SecretProvider = h.providerName(ctx)

	// Build the plan and store it.
	plan := &importPlan{
		profiles: profiles,
		groups:   groups,
		creds:    credentials,
	}
	token, err := h.plans.storePlan(plan)
	if err != nil {
		return nil, nil, fmt.Errorf("store plan: %w", err)
	}
	preview.PlanToken = token

	return plan, preview, nil
}

// configSpecs declares the config-domain control methods. The ConfigOperation
// and TabbyImportOperation are built here from the wired stores; the handler
// families share them.
func (s *WSServer) configSpecs(lane control.Admission, configGate, vaultGate control.Admission) []methodSpec {
	profilesWired := s.profiles != nil
	groupsWired := s.groups != nil
	settingsWired := s.settings != nil
	executeWired := profilesWired && groupsWired && s.credentials != nil && s.profileSvc != nil

	// Endpoints ride the profile store (ADR-0030): the same JSON document,
	// so the profile store satisfies the endpoint repository. endpointWired
	// is the "endpoints not available" gate the handlers check first. The
	// nil guard is real: the type assertion below panics on a nil
	// interface, and profiles may simply not be wired.
	var endpointsRepo profile.EndpointRepository
	if profilesWired {
		if er, ok := s.profiles.(profile.EndpointRepository); ok {
			endpointsRepo = er
		}
	}
	endpointWired := endpointsRepo != nil

	configOp := capability.NewConfigOperation(
		configGate, vaultGate, lane,
		s.profiles, s.groups, endpointsRepo, s.profileSvc, s.settings,
		s.vaultRowResolver(), s.vaultEndpointSecrets(),
	)
	var tabbyOp capability.TabbyImportOperation
	if profilesWired || groupsWired || s.credentials != nil {
		tabbyOp = capability.NewTabbyImportOperation(
			configGate, vaultGate, lane,
			s.profiles, s.groups, s.profileSvc,
			s.vaultSecretSeam(), s.credentials,
		)
	}
	configSub := s.operationQueue("config")
	tabbySub := s.operationQueue("tabby")

	specs := []methodSpec{
		regResponder(configSub, "profiles.list", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "profiles.create", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "profiles.update", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "profiles.delete", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "profiles.effective", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "profiles.patch", func(r Responder) handlerFunc {
			h := profileHandlers{op: configOp, wired: profilesWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "endpoints.list", func(r Responder) handlerFunc {
			h := endpointHandlers{op: configOp, wired: endpointWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "endpoints.create", func(r Responder) handlerFunc {
			h := endpointHandlers{op: configOp, wired: endpointWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "endpoints.update", func(r Responder) handlerFunc {
			h := endpointHandlers{op: configOp, wired: endpointWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "endpoints.delete", func(r Responder) handlerFunc {
			h := endpointHandlers{op: configOp, wired: endpointWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "groups.list", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "groups.create", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "groups.update", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "groups.delete", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "groups.impact", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleGroupImpact(ctx, req) }
		}),
		regResponder(configSub, "profiles.moveImpact", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleProfileMoveImpact(ctx, req) }
		}),
		regResponder(configSub, "groups.apply", func(r Responder) handlerFunc {
			h := groupHandlers{op: configOp, wired: groupsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleGroupApply(ctx, req) }
		}),
		regResponder(configSub, "settings.describe", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.getSnapshot", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.set", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.reset", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.secretSet", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.secretDelete", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(configSub, "settings.secretExists", func(r Responder) handlerFunc {
			h := settingsHandlers{op: configOp, wired: settingsWired, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMethod(ctx, req) }
		}),
		regResponder(tabbySub, "profiles.importTabby", func(r Responder) handlerFunc {
			h := tabbyHandlers{op: tabbyOp, configWired: profilesWired && groupsWired, executeWired: executeWired, storeWired: s.credentials != nil, plans: s, providerName: s.secretProviderName, log: s.log, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleImportTabby(ctx, req) }
		}),
		regResponder(tabbySub, "profiles.tabbyPreview", func(r Responder) handlerFunc {
			h := tabbyHandlers{op: tabbyOp, configWired: profilesWired && groupsWired, executeWired: executeWired, storeWired: s.credentials != nil, plans: s, providerName: s.secretProviderName, log: s.log, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleTabbyPreview(ctx, req) }
		}),
		regResponder(tabbySub, "profiles.tabbyExecute", func(r Responder) handlerFunc {
			h := tabbyHandlers{op: tabbyOp, configWired: profilesWired && groupsWired, executeWired: executeWired, storeWired: s.credentials != nil, plans: s, providerName: s.secretProviderName, log: s.log, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleTabbyExecute(ctx, req) }
		}),
	}
	return specs
}

// vaultRowResolver returns the RowResolver seam for the config write path —
// the vault's ResolveRow — or nil when no vault is wired (a config write
// carrying a row handle then fails loudly, the documented nil-RowResolver
// contract).
func (s *WSServer) vaultRowResolver() capability.RowResolver {
	if s.vaultLifecycle == nil {
		return nil
	}
	if rr, ok := s.vaultLifecycle.(capability.RowResolver); ok {
		return rr
	}
	return nil
}

// vaultSecretSeam returns the SecretVault seam for the tabby import (the
// vault's catalogue-aware secret surface), or nil when no vault is wired —
// CreateSecret then records namelessly through the plain store, exactly as
// before.
func (s *WSServer) vaultSecretSeam() capability.SecretVault {
	if s.vaultLifecycle == nil {
		return nil
	}
	if sv, ok := s.vaultLifecycle.(capability.SecretVault); ok {
		return sv
	}
	return nil
}

// vaultEndpointSecrets returns the EndpointSecrets seam for the endpoint
// write paths, or nil when no vault is wired — key-bearing endpoint writes
// and material deletes then fail loudly, the documented nil-seam contract.
func (s *WSServer) vaultEndpointSecrets() capability.EndpointSecrets {
	if s.vaultLifecycle == nil {
		return nil
	}
	if es, ok := s.vaultLifecycle.(capability.EndpointSecrets); ok {
		return es
	}
	return nil
}
