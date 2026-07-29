package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/connection"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/rollout"
	"github.com/shady2k/nocx/internal/ssh"
)

// ---------------------------------------------------------------------------
// rollout.run — JSON-RPC types
// ---------------------------------------------------------------------------

// rolloutRunParams is the payload of the "rollout.run" RPC call.
type rolloutRunParams struct {
	CredentialID       string   `json:"credentialId"`
	VersionID          string   `json:"versionId"`
	TargetIDs          []string `json:"targetIds"`
	CanaryIDs          []string `json:"canaryIds,omitempty"`
	BatchSize          int      `json:"batchSize,omitempty"`
	GlobalConcurrency  int      `json:"globalConcurrency,omitempty"`
	BastionConcurrency int      `json:"bastionConcurrency,omitempty"`
}

// rolloutRunResult is the success response for rollout.run.
type rolloutRunResult struct {
	Status       string                   `json:"status"`
	Probed       []rollout.EndpointResult `json:"probed,omitempty"`
	Excluded     []rollout.Exclusion      `json:"excluded,omitempty"`
	NotAttempted []rollout.NotAttempted   `json:"notAttempted,omitempty"`
	StartedAt    string                   `json:"startedAt"`
	CompletedAt  *string                  `json:"completedAt,omitempty"`
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// handleRolloutRun starts a rollout run and returns the state.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"rollout.run","params":{
//	      "credentialId":"cred:prod-ops:abc",
//	      "versionId":"v2",
//	      "targetIds":["ssh:p1:1","ssh:p2:1"],
//	      "canaryIds":["ssh:canary:1"]
//	    }}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"status":"completed","probed":[...]}}
func (s *WSServer) handleRolloutRun(wconn *wsConn, req jsonrpcRequest) {
	var params rolloutRunParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if params.CredentialID == "" || params.VersionID == "" || len(params.TargetIDs) == 0 {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "credentialId, versionId, and targetIds are required"))
		return
	}

	if s.rolloutRunner == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Rollout not available (no runner wired)"))
		return
	}

	state, err := s.rolloutRunner.Run(context.Background(), rollout.RunParams{
		CredentialID:       params.CredentialID,
		VersionID:          params.VersionID,
		TargetIDs:          params.TargetIDs,
		CanaryIDs:          params.CanaryIDs,
		BatchSize:          params.BatchSize,
		GlobalConcurrency:  params.GlobalConcurrency,
		BastionConcurrency: params.BastionConcurrency,
	})

	if err != nil && state == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "Rollout failed: "+err.Error()))
		return
	}

	// A rollout's whole purpose is to produce the evidence a promotion is
	// measured against, and versions.promote reads that evidence from the
	// probe result store — so the run has to write there, not only into its
	// own reply. Without this the two halves each work and never compose: a
	// rollout in which every host accepts is followed by a promotion that
	// refuses, because the store it consults is empty.
	s.storeRolloutResults(params, state)
	if err != nil {
		// State is still valid — include it.
		_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(stateToResult(state, err.Error()))))
		return
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(stateToResult(state, ""))))
}

// storeRolloutResults records each probed endpoint as operational evidence,
// under the same full identity key connections.test uses (spec §6). Only
// probed endpoints are recorded: an exclusion is a statement about the target,
// not a probe result, and counting one as evidence would let a fleet nobody
// reached satisfy a promotion threshold.
func (s *WSServer) storeRolloutResults(params rolloutRunParams, state *rollout.RunState) {
	if s.probeResultStore == nil || state == nil {
		return
	}
	for _, p := range state.Probed {
		s.probeResultStore.Store(ProbeResultRecord{
			Identity: ProbeResultIdentity{
				Endpoint:           p.Endpoint,
				HostKeyFingerprint: p.Fingerprint,
				CredentialVersion:  params.VersionID,
				Username:           p.Username,
				AuthPolicy:         p.AuthPolicy,
				Timestamp:          p.Timestamp,
			},
			Outcome:      p.Outcome,
			Detail:       p.Detail,
			ProfileID:    p.ProfileID,
			CredentialID: params.CredentialID,
		})
	}
}

// stateToResult converts a rollout.RunState to a JSON-serializable result.
func stateToResult(state *rollout.RunState, errMsg string) rolloutRunResult {
	r := rolloutRunResult{
		Status:       string(state.Status),
		Probed:       state.Probed,
		Excluded:     state.Excluded,
		NotAttempted: state.NotAttempted,
		StartedAt:    state.StartedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	if state.CompletedAt != nil {
		s := state.CompletedAt.Format("2006-01-02T15:04:05Z07:00")
		r.CompletedAt = &s
	}
	return r
}

// ---------------------------------------------------------------------------
// WithRolloutRunner wires a rollout.Runner into the WSServer.
func WithRolloutRunner(resolver *connection.Resolver, credRepo profile.CredentialMetadataRepository) WSServerOption {
	return func(s *WSServer) {
		s.rolloutRunner = rollout.NewRunner(
			&rolloutResolverAdapter{inner: resolver},
			s.prober,
			&rolloutCredentialAdapter{credRepo: credRepo},
		)
	}
}

// ---------------------------------------------------------------------------
// Adapters: normalize package-boundary types for the rollout runner
// ---------------------------------------------------------------------------

// rolloutResolverAdapter wraps *connection.Resolver as rollout.Resolver,
// translating connection.ErrVersionNotFound to rollout.ErrVersionNotFound.
type rolloutResolverAdapter struct {
	inner *connection.Resolver
}

func (a *rolloutResolverAdapter) ResolveWithVersion(profileID, credentialID, versionID string) (string, *ssh.ConnectConfig, error) {
	host, cfg, err := a.inner.ResolveWithVersion(profileID, credentialID, versionID)
	if errors.Is(err, connection.ErrVersionNotFound) {
		return "", nil, rollout.ErrVersionNotFound
	}
	return host, cfg, err
}

// rolloutCredentialAdapter wraps profile.CredentialMetadataRepository as
// rollout.CredentialInfo, extracting the auth mode for pre-probe checks.
type rolloutCredentialAdapter struct {
	credRepo profile.CredentialMetadataRepository
}

func (a *rolloutCredentialAdapter) AuthMode(credentialID string) (string, error) {
	creds, err := a.credRepo.LoadCredentials()
	if err != nil {
		return "", err
	}
	for _, c := range creds {
		if c.ID == credentialID {
			return string(c.Auth), nil
		}
	}
	return "", fmt.Errorf("credential %s: %w", credentialID, rollout.ErrCredentialNotFound)
}
