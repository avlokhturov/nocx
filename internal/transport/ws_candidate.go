package transport

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
)

// stageCandidateForCredential stores a password secret as a candidate version
// without affecting CurrentVersionID or changing how ordinary connections
// authenticate. The new secret is written under a fresh ID first, then metadata
// is updated — write-before-repoint prevents a crash from orphaning the new
// secret.
//
// The candidate has its own secret material, separate from the current version.
// Staging is reversible: call discardCandidateForCredential to remove it.
func (s *WSServer) stageCandidateForCredential(credID, password string) error {
	if s.credMeta == nil {
		return errors.New("profiles not available")
	}
	cred, ok, err := s.findCredentialByID(credID)
	if err != nil {
		return fmt.Errorf("load credential %s: %w", credID, err)
	}
	if !ok {
		return fmt.Errorf("credential %s not found", credID)
	}

	// Enforce one candidate at a time.
	if _, ok := cred.Candidate(); ok {
		return fmt.Errorf("credential %s: %w", credID, profile.ErrCandidateExists)
	}

	newID := credential.NewSecretID()
	if err := s.credentials.Set(newID, credential.NewSecret(password)); err != nil {
		return fmt.Errorf("store secret: %w", err)
	}

	// Carry over the existing passphrase ref so the candidate doesn't lose
	// key passphrase support. The candidate gets its own password secret but
	// shares the same passphrase until one is explicitly staged.
	passphraseRef := ""
	if v, ok := cred.Current(); ok {
		passphraseRef = v.PassphraseSecretID
	}

	if err := s.credMeta.SetCandidateVersion(credID, string(newID), passphraseRef); err != nil {
		return fmt.Errorf("set candidate version: %w", err)
	}
	return nil
}

// discardCandidateForCredential removes the candidate version and its secret.
// Idempotent: calling discard when no candidate exists returns success.
func (s *WSServer) discardCandidateForCredential(credID string) error {
	if s.credMeta == nil {
		return errors.New("profiles not available")
	}
	cred, ok, err := s.findCredentialByID(credID)
	if err != nil {
		return fmt.Errorf("load credential %s: %w", credID, err)
	}
	if !ok {
		return nil // idempotent: already gone
	}

	// Find the candidate secret ID to delete, before clearing the reference.
	candidateSecretID := credential.SecretID("")
	if v, ok := cred.Candidate(); ok {
		candidateSecretID = credential.SecretID(v.PasswordSecretID)
	}

	if err := s.credMeta.ClearCandidateVersion(credID); err != nil {
		return fmt.Errorf("clear candidate version: %w", err)
	}

	// Best-effort delete of the candidate secret.
	if candidateSecretID != "" {
		_ = s.credentials.Delete(candidateSecretID)
	}
	return nil
}

// handleStagePassword handles credentials.stagePassword RPC.
func (s *WSServer) handleStagePassword(wconn *wsConn, req jsonrpcRequest) {
	if s.credentials == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "credentials not available"))
		return
	}
	var params struct {
		CredentialID string `json:"credentialId"`
		Password     string `json:"password"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.CredentialID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: credentialId required"))
		return
	}
	if err := s.stageCandidateForCredential(params.CredentialID, params.Password); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(true)))
}

// handleDiscardCandidate handles credentials.discardCandidate RPC.
func (s *WSServer) handleDiscardCandidate(wconn *wsConn, req jsonrpcRequest) {
	if s.credentials == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "credentials not available"))
		return
	}
	var params struct {
		CredentialID string `json:"credentialId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.CredentialID == "" {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: credentialId required"))
		return
	}
	if err := s.discardCandidateForCredential(params.CredentialID); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(true)))
}
