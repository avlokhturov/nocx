package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/vault"
)

// VaultLifecycle is the seal-lifecycle surface of the vault.
// Satisfied by *vault.Vault.
type VaultLifecycle interface {
	State() vault.State
	Snapshot(ctx context.Context) vault.Snapshot
	Setup(ctx context.Context, req vault.SetupRequest) (vault.SetupResult, error)
	Unseal(ctx context.Context, req vault.UnsealRequest) error
	Seal()
	ChangePassphrase(ctx context.Context, req vault.ChangePassphraseRequest) error
	RegenerateRecovery(ctx context.Context, req vault.RegenerateRequest) (string, error)
	// BuildInventory assembles the vault inventory from credential metadata.
	// Returns vault.ErrVaultSealed when the vault is sealed.
	BuildInventory(ctx context.Context, inputs []vault.CredentialInventory) ([]vault.InventoryEntry, error)
	SetDefaultProvider(ctx context.Context, p vault.ProviderID) error
	SetAutoSeal(ctx context.Context, minutes int) error
	Activity()
}

// vaultSetupParams is the wire format for vault.setup.
type vaultSetupParams struct {
	Passphrase string `json:"passphrase,omitempty"`
}

// vaultUnsealParams is the wire format for vault.unseal.
type vaultUnsealParams struct {
	Means    string `json:"means"`
	Secret   string `json:"secret,omitempty"`
	SecretID string `json:"secretId,omitempty"`
}

// vaultErrorData carries a machine-readable reason in the JSON-RPC error data.
type vaultErrorData struct {
	Reason string `json:"reason"`
}

func vaultErrorCode(err error, fallback int) int {
	switch {
	case errors.Is(err, vault.ErrVaultUninitialized):
		return -32000
	case errors.Is(err, vault.ErrVaultSealed):
		return -32001
	case errors.Is(err, vault.ErrProviderUnavailable):
		return -32002
	case errors.Is(err, vault.ErrUnsealFailed):
		return -32003
	default:
		return fallback
	}
}

func reasonForError(err error) *vaultErrorData {
	var pe *vault.ProviderError
	if errors.As(err, &pe) {
		return &vaultErrorData{Reason: string(pe.Reason)}
	}
	switch {
	case errors.Is(err, vault.ErrVaultUninitialized):
		return &vaultErrorData{Reason: "vault-uninitialized"}
	case errors.Is(err, vault.ErrVaultSealed):
		return &vaultErrorData{Reason: "vault-sealed"}
	case errors.Is(err, vault.ErrVaultGenerationChanged):
		// NOT "vault-sealed". The renderer turns that reason into an Unlock
		// dialog, and unlocking cannot fix a generation change — which is how
		// the retry loop in nocx-25k9.20 became endless.
		return &vaultErrorData{Reason: "vault-changed"}
	case errors.Is(err, vault.ErrUnsealFailed):
		return &vaultErrorData{Reason: "unseal-failed"}
	default:
		return nil
	}
}

func newVaultError(id json.RawMessage, code int, msg string, err error) jsonrpcResponse {
	data := reasonForError(err)
	obj := jsonrpcErrorObj{Code: code, Message: msg}
	if data != nil {
		obj.Data = data
	}
	return jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &obj,
	}
}

// rpcErrorFor renders err as a JSON-RPC error, preserving the vault reason
// code when err wraps one.
//
// Every handler that can reach the SecretStore must use this rather than
// newJSONRPCError. The renderer tells "the vault needs setting up" apart from
// a genuine failure by reading data.reason; a bare -32603 with a prose message
// is indistinguishable from a disk error, so the setup dialog never opens and
// the user is shown a toast instead. That was the whole of nocx-25k9.7: the
// vault handlers attached the reason and the older credentials.* handlers,
// which are the ones the connection form actually calls, did not.
func rpcErrorFor(id json.RawMessage, fallback int, msgPrefix string, err error) jsonrpcResponse {
	return newVaultError(id, vaultErrorCode(err, fallback), msgPrefix+err.Error(), err)
}

// handleVaultMethod dispatches vault.* RPCs. Returns -32601 when the vault
// lifecycle is not wired.
func (s *WSServer) handleVaultMethod(wconn *wsConn, req jsonrpcRequest) {
	if s.vaultLifecycle == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "vault not available"))
		return
	}

	switch req.Method {
	case "vault.status":
		s.handleVaultStatus(wconn, req)
	case "vault.setup":
		s.handleVaultSetup(wconn, req)
	case "vault.unseal":
		s.handleVaultUnseal(wconn, req)
	case "vault.seal":
		s.handleVaultSeal(wconn, req)
	case "vault.changePassphrase":
		s.handleVaultChangePassphrase(wconn, req)
	case "vault.regenerateRecovery":
		s.handleVaultRegenerateRecovery(wconn, req)
	case "vault.setDefaultProvider":
		s.handleVaultSetDefaultProvider(wconn, req)
	case "vault.setAutoSeal":
		s.handleVaultSetAutoSeal(wconn, req)
	case "vault.activity":
		s.handleVaultActivity(wconn, req)
	case "vault.inventory":
		s.handleVaultInventory(wconn, req)
	}
}

type vaultStatusResponse struct {
	State           string `json:"state"`
	OSKeyAvailable  bool   `json:"osKeyAvailable"`
	OSKeyCapable    bool   `json:"osKeyCapable"`
	HasPassphrase   bool   `json:"hasPassphrase"`
	AutoSealMinutes int    `json:"autoSealMinutes"`
	// Pointer, so an uninitialized vault sends null rather than "". The
	// renderer has to tell "no store chosen yet" from "a store id I do not
	// recognise", and an empty string reads as the second.
	DefaultProvider *string                    `json:"defaultProvider"`
	Providers       []vaultStatusProviderEntry `json:"providers"`
}

type vaultStatusProviderEntry struct {
	ID       string `json:"id"`
	Writable bool   `json:"writable"`
	Ready    bool   `json:"ready"`
	Reason   string `json:"reason,omitempty"`
}

func vaultSnapToStatus(snap vault.Snapshot) vaultStatusResponse {
	resp := vaultStatusResponse{
		State:           snap.State.String(),
		OSKeyAvailable:  snap.HasOSKey,
		OSKeyCapable:    snap.OSKeyCapable,
		HasPassphrase:   snap.HasPassphrase,
		AutoSealMinutes: snap.AutoSealMinutes,
	}
	if snap.DefaultProvider != "" {
		id := string(snap.DefaultProvider)
		resp.DefaultProvider = &id
	}
	// Empty, not nil. A nil slice marshals to `null`, and the renderer's type
	// says `providers: ProviderStatus[]` — so on a vault with no providers
	// registered, the first `.map` over it throws. The same defect shipped once
	// already on the inventory (nocx-25k9.14); the contract schema is what
	// caught it here, because `"type": "array"` refuses null and no
	// hand-written test had thought to ask.
	resp.Providers = make([]vaultStatusProviderEntry, 0, len(snap.Providers))
	for _, p := range snap.Providers {
		entry := vaultStatusProviderEntry{
			ID:       string(p.ID),
			Writable: p.Writable,
			Ready:    p.Ready,
		}
		if p.Reason != "" {
			entry.Reason = string(p.Reason)
		}
		resp.Providers = append(resp.Providers, entry)
	}
	return resp
}

func (s *WSServer) handleVaultStatus(wconn *wsConn, req jsonrpcRequest) {
	ctx := context.Background()
	snap := s.vaultLifecycle.Snapshot(ctx)
	resp := vaultSnapToStatus(snap)
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
}

func (s *WSServer) handleVaultSetup(wconn *wsConn, req jsonrpcRequest) {
	var params vaultSetupParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	vreq := vault.SetupRequest{Passphrase: params.Passphrase}
	result, err := s.vaultLifecycle.Setup(context.Background(), vreq)
	if err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, code, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()

	var resp any = struct{}{}
	if result.RecoveryCode != "" {
		resp = struct {
			RecoveryCode string `json:"recoveryCode"`
		}{RecoveryCode: result.RecoveryCode}
	}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
}

func (s *WSServer) handleVaultUnseal(wconn *wsConn, req jsonrpcRequest) {
	var params vaultUnsealParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	// Reject secretId — the renderer never names a secret reference.
	if params.SecretID != "" {
		err := fmt.Errorf("secretId is backend-owned")
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, err.Error()))
		return
	}

	vreq := vault.UnsealRequest{}
	switch params.Means {
	case "os":
		vreq.UseOSKey = true
	case "passphrase":
		vreq.Passphrase = params.Secret
	case "recovery":
		vreq.RecoveryCode = params.Secret
	default:
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "invalid means: must be os, passphrase, or recovery"))
		return
	}

	if err := s.vaultLifecycle.Unseal(context.Background(), vreq); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, code, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

func (s *WSServer) handleVaultSeal(wconn *wsConn, req jsonrpcRequest) {
	s.vaultLifecycle.Seal()
	s.broadcastVaultChanged()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

type vaultChangePassphraseParams struct {
	OldPassphrase string `json:"oldPassphrase,omitempty"`
	RecoveryCode  string `json:"recoveryCode,omitempty"`
	NewPassphrase string `json:"newPassphrase"`
}

type vaultRegenerateRecoveryParams struct {
	Passphrase string `json:"passphrase"`
}

type vaultSetDefaultProviderParams struct {
	Provider string `json:"provider"`
}

func (s *WSServer) handleVaultChangePassphrase(wconn *wsConn, req jsonrpcRequest) {
	var params vaultChangePassphraseParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	vreq := vault.ChangePassphraseRequest{
		OldPassphrase: params.OldPassphrase,
		RecoveryCode:  params.RecoveryCode,
		NewPassphrase: params.NewPassphrase,
	}
	if err := s.vaultLifecycle.ChangePassphrase(context.Background(), vreq); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, code, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

func (s *WSServer) handleVaultRegenerateRecovery(wconn *wsConn, req jsonrpcRequest) {
	var params vaultRegenerateRecoveryParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	vreq := vault.RegenerateRequest{Passphrase: params.Passphrase}
	recoveryCode, err := s.vaultLifecycle.RegenerateRecovery(context.Background(), vreq)
	if err != nil {
		errCode := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, errCode, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()
	resp := struct {
		RecoveryCode string `json:"recoveryCode"`
	}{RecoveryCode: recoveryCode}
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(resp)))
}

func (s *WSServer) handleVaultSetDefaultProvider(wconn *wsConn, req jsonrpcRequest) {
	var params vaultSetDefaultProviderParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}

	provID := vault.ProviderID(params.Provider)
	if err := s.vaultLifecycle.SetDefaultProvider(context.Background(), provID); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, code, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

type vaultSetAutoSealParams struct {
	Minutes *int `json:"minutes"`
}

func (s *WSServer) handleVaultSetAutoSeal(wconn *wsConn, req jsonrpcRequest) {
	var params vaultSetAutoSealParams
	if !isJSONObject(req.Params) {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params"))
		return
	}
	if params.Minutes == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32602, "Invalid params: minutes is required"))
		return
	}

	if err := s.vaultLifecycle.SetAutoSeal(context.Background(), *params.Minutes); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.writeJSON(newVaultError(req.ID, code, err.Error(), err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

func (s *WSServer) handleVaultActivity(wconn *wsConn, req jsonrpcRequest) {
	s.vaultLifecycle.Activity()
	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(struct{}{})))
}

func (s *WSServer) handleVaultInventory(wconn *wsConn, req jsonrpcRequest) {
	if s.credMeta == nil || s.profiles == nil || s.groups == nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32601, "vault.inventory not available"))
		return
	}

	creds, err := s.credMeta.LoadCredentials()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.writeJSON(newJSONRPCError(req.ID, -32603, err.Error()))
		return
	}

	usage := profile.ComputeCredentialUsage(creds, profiles, groups, profile.SparseSSHOptions{})

	// Build profile lookup for single-use label resolution.
	profByID := make(map[string]profile.SSHProfile, len(profiles))
	for _, p := range profiles {
		profByID[p.ID] = p
	}

	// Build usage maps.
	usageCount := make(map[string]int, len(usage))
	usageRefs := make(map[string][]profile.ProfileRef, len(usage))
	for _, u := range usage {
		usageCount[u.CredentialID] = len(u.Profiles)
		usageRefs[u.CredentialID] = u.Profiles
	}

	// Build vault inventory inputs.
	inputs := make([]vault.CredentialInventory, 0, len(creds))
	for _, c := range creds {
		ci := vault.CredentialInventory{
			ID:                 c.ID,
			Username:           c.Username,
			AuthMode:           string(c.Auth),
			SecretID:           c.SecretID,
			PassphraseSecretID: c.PassphraseSecretID,
			UsageCount:         usageCount[c.ID],
		}

		// Populate versions.
		for _, v := range c.Versions {
			ci.Versions = append(ci.Versions, vault.CredentialVersionInventory{
				PasswordSecretID:   v.PasswordSecretID,
				PassphraseSecretID: v.PassphraseSecretID,
				KeyFingerprint:     v.KeyFingerprint,
			})
		}

		// For single-use passwords, resolve the sole profile to get host:port.
		if ci.UsageCount == 1 {
			if refs, ok := usageRefs[c.ID]; ok && len(refs) > 0 {
				if p, ok := profByID[refs[0].ProfileID]; ok {
					eff, resolveErr := profile.ResolveEffectiveProfile(p, groups, profile.SparseSSHOptions{})
					if resolveErr == nil {
						ci.SingleHost = eff.ResolvedOptions.Host
						ci.SinglePort = eff.ResolvedOptions.Port
					}
				}
			}
		}

		inputs = append(inputs, ci)
	}

	entries, err := s.vaultLifecycle.BuildInventory(context.Background(), inputs)
	if err != nil {
		_ = wconn.writeJSON(rpcErrorFor(req.ID, -32603, "vault.inventory: ", err))
		return
	}

	result := struct {
		Entries []vault.InventoryEntry `json:"entries"`
	}{Entries: entries}

	_ = wconn.writeJSON(newJSONRPCResult(req.ID, mustMarshal(result)))
}

// broadcastVaultChanged sends a vault.changed notification to every connected
// client. Best-effort: a write failure on one connection does not prevent
// writes to others.
func (s *WSServer) broadcastVaultChanged() {
	s.connsMu.Lock()
	conns := make([]*wsConn, 0, len(s.conns))
	for wc := range s.conns {
		conns = append(conns, wc)
	}
	s.connsMu.Unlock()

	ctx := context.Background()
	snap := s.vaultLifecycle.Snapshot(ctx)
	msg := map[string]any{
		"jsonrpc": "2.0",
		"method":  "vault.changed",
		"params":  vaultSnapToStatus(snap),
	}
	for _, wc := range conns {
		_ = wc.writeJSON(msg)
	}
}
