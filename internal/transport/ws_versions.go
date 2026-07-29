package transport

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/session"
)

// ---------------------------------------------------------------------------
// VersionSessionRegistry — narrow interface for session operations keyed by
// credential version ID. Defined here (consumer package) per the repo's DI
// convention; the single implementation wraps session.Registry in app.go.
// ---------------------------------------------------------------------------

// VersionSessionRegistry provides session lookup and closing by credential
// version. Used by revocation to close sessions on a specific version.
type VersionSessionRegistry interface {
	// FindByCredentialVersion returns session IDs whose CredentialID matches
	// the given credential ID AND CredentialVersionID matches the given version
	// ID. Returns nil when no sessions match.
	FindByCredentialVersion(credentialID, versionID string) []session.ID
	// Close closes the session with the given ID. Returns an error when the
	// session is not found or is already closed.
	Close(id session.ID) error
}

// WithVersionSessionRegistry attaches a VersionSessionRegistry for the
// versions.revoke and versions.retire JSON-RPC methods. When not wired,
// session draining/revocation is silently a no-op (the credential mutation
// still applies).
func WithVersionSessionRegistry(vr VersionSessionRegistry) WSServerOption {
	return func(s *WSServer) { s.versionRegistry = vr }
}

// ---------------------------------------------------------------------------
// Threshold types
// ---------------------------------------------------------------------------

// PromoteThreshold is the minimum evidence required to promote a candidate.
// MinAccepted must be > 0 — a mandatory threshold is validated by the
// service layer, not gated in the handler.
type PromoteThreshold struct {
	MinAccepted int `json:"minAccepted"`
}

// PromoteEvidence reports what was measured during threshold validation.
type PromoteEvidence struct {
	Accepted int                 `json:"accepted"`
	Total    int                 `json:"total"`
	Results  []ProbeResultRecord `json:"results,omitempty"`
}

// ---------------------------------------------------------------------------
// versions.* JSON-RPC types
// ---------------------------------------------------------------------------

type versionsPromoteParams struct {
	CredentialID string           `json:"credentialId"`
	Threshold    PromoteThreshold `json:"threshold"`
}

type versionsPromoteResult struct {
	VersionID string           `json:"versionId"`
	Evidence  *PromoteEvidence `json:"evidence,omitempty"`
}

type versionsRetireParams struct {
	CredentialID  string `json:"credentialId"`
	VersionID     string `json:"versionId"`
	DrainExisting bool   `json:"drainExisting"`
}

type versionsRevokeParams struct {
	CredentialID string `json:"credentialId"`
	VersionID    string `json:"versionId"`
}

type versionsActionResult struct {
	VersionID      string `json:"versionId"`
	Retired        bool   `json:"retired"`
	SessionsClosed int    `json:"sessionsClosed"`
}

// ---------------------------------------------------------------------------
// Handler: versions.promote
// ---------------------------------------------------------------------------

// handleVersionsPromote promotes a candidate version to current.
// The threshold is validated against the probe result store before promoting.
// Returns the promoted version ID and the evidence that was measured.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"versions.promote","params":{"credentialId":"cred:prod:abc","threshold":{"minAccepted":3}}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"versionId":"v2","evidence":{"accepted":5,"total":5}}}
//	<-- {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"promote threshold not met: need 3 accepted, have 1 out of 5"}}
func (s *WSServer) handleVersionsPromote(wconn *wsConn, req jsonrpcRequest) {
	if s.profileSvc == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "Method not found"))
		return
	}

	var params versionsPromoteParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.CredentialID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: credentialId required"))
		return
	}

	// Load the credential to find the candidate version.
	cred, err := s.findFullCredential(params.CredentialID)
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	candidate, ok := cred.Candidate()
	if !ok {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, "no candidate version to promote"))
		return
	}
	// Collect probe evidence. nil is handled by the service — a missing
	// probe store means zero evidence, which fails the threshold.
	evidence := s.evaluatePromoteThreshold(params.CredentialID, candidate.ID)
	accepted, total := 0, 0
	if evidence != nil {
		accepted = evidence.Accepted
		total = evidence.Total
	}

	// Perform the promotion — the service validates threshold against evidence
	// and refuses with ErrThresholdNotMet when insufficient.
	_, err = s.profileSvc.PromoteVersion(params.CredentialID, accepted, total, params.Threshold.MinAccepted)
	if err != nil {
		var tnm *profile.ErrThresholdNotMet
		if errors.As(err, &tnm) {
			_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, tnm.Error()))
		} else {
			_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		}
		return
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(versionsPromoteResult{
		VersionID: candidate.ID,
		Evidence:  evidence,
	})))
}

// ---------------------------------------------------------------------------
// Handler: versions.retire
// ---------------------------------------------------------------------------

// handleVersionsRetire marks a version as retired. When drainExisting is true,
// closes all sessions running on this version.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"versions.retire","params":{"credentialId":"cred:prod:abc","versionId":"v1","drainExisting":false}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"versionId":"v1","retired":true,"sessionsClosed":0}}
func (s *WSServer) handleVersionsRetire(wconn *wsConn, req jsonrpcRequest) {
	if s.profileSvc == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "Method not found"))
		return
	}

	var params versionsRetireParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.CredentialID == "" || params.VersionID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: credentialId and versionId required"))
		return
	}

	if err := s.profileSvc.RetireVersion(params.CredentialID, params.VersionID); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	closed := 0
	if params.DrainExisting && s.versionRegistry != nil {
		ids := s.versionRegistry.FindByCredentialVersion(params.CredentialID, params.VersionID)
		for _, id := range ids {
			if err := s.versionRegistry.Close(id); err == nil {
				closed++
			}
		}
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(versionsActionResult{
		VersionID:      params.VersionID,
		Retired:        true,
		SessionsClosed: closed,
	})))
}

// ---------------------------------------------------------------------------
// Handler: versions.revoke
// ---------------------------------------------------------------------------

// handleVersionsRevoke marks a version as retired and closes ALL sessions
// on that version unconditionally.
//
//	--> {"jsonrpc":"2.0","id":1,"method":"versions.revoke","params":{"credentialId":"cred:prod:abc","versionId":"v1"}}
//	<-- {"jsonrpc":"2.0","id":1,"result":{"versionId":"v1","retired":true,"sessionsClosed":3}}
func (s *WSServer) handleVersionsRevoke(wconn *wsConn, req jsonrpcRequest) {
	if s.profileSvc == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "Method not found"))
		return
	}

	var params versionsRevokeParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.CredentialID == "" || params.VersionID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: credentialId and versionId required"))
		return
	}

	if err := s.profileSvc.RetireVersion(params.CredentialID, params.VersionID); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	closed := 0
	if s.versionRegistry != nil {
		ids := s.versionRegistry.FindByCredentialVersion(params.CredentialID, params.VersionID)
		for _, id := range ids {
			if err := s.versionRegistry.Close(id); err == nil {
				closed++
			}
		}
	}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(versionsActionResult{
		VersionID:      params.VersionID,
		Retired:        true,
		SessionsClosed: closed,
	})))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// evaluatePromoteThreshold collects probe evidence for the given credential
// and version. Returns nil when the probe result store is unavailable.
func (s *WSServer) evaluatePromoteThreshold(credentialID, versionID string) *PromoteEvidence {
	if s.probeResultStore == nil {
		return nil
	}
	results := s.collectProbeResults(credentialID, versionID)
	accepted := 0
	for _, r := range results {
		if r.Outcome == OutcomeAccepted {
			accepted++
		}
	}
	return &PromoteEvidence{
		Accepted: accepted,
		Total:    len(results),
		Results:  results,
	}
}

// collectProbeResults filters probe results for the given credential and
// version. Both credentialID and versionID must match.
func (s *WSServer) collectProbeResults(credentialID, versionID string) []ProbeResultRecord {
	all := s.probeResultStore.List()
	if len(all) == 0 {
		return nil
	}
	results := make([]ProbeResultRecord, 0, len(all))
	for _, r := range all {
		if r.CredentialID == credentialID && r.Identity.CredentialVersion == versionID {
			results = append(results, r)
		}
	}
	return results
}

// findFullCredential loads a credential by ID through the credential metadata
// repository, returning an error when not found.
func (s *WSServer) findFullCredential(id string) (profile.Credential, error) {
	if s.credMeta == nil {
		return profile.Credential{}, fmt.Errorf("profiles not available")
	}
	all, err := s.credMeta.LoadCredentials()
	if err != nil {
		return profile.Credential{}, fmt.Errorf("load credentials: %w", err)
	}
	for _, c := range all {
		if c.ID == id {
			return c, nil
		}
	}
	return profile.Credential{}, fmt.Errorf("credential %s not found", id)
}
