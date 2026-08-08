package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/shady2k/nocx/internal/credential"
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
	// BuildInventory assembles the vault inventory from profile secret
	// bindings. Returns vault.ErrVaultSealed when the vault is sealed.
	BuildInventory(ctx context.Context, inputs []vault.CredentialInventory) ([]vault.InventoryEntry, error)
	// CreateNamed stores value with the secret's catalogue metadata — display
	// name and kind (ADR-0016). The name joins Create's journal sequence; it
	// is never written by a second, independent path.
	CreateNamed(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, error)
	// CreateNamedResolved is CreateNamed with atomic name-collision
	// resolution: when the requested name is taken, the next free suffixed
	// name is chosen under the vault lock and the name ACTUALLY used comes
	// back — the renderer must never predict that a suffixed name is free;
	// two tabs can save at once.
	CreateNamedResolved(ctx context.Context, value credential.Secret, meta vault.SecretMeta) (credential.SecretID, string, error)
	// renderer-addressable row handle — never by a SecretID (nocx-jb20.1).
	RenameSecret(ctx context.Context, row string, name string, inputs []vault.CredentialInventory) error
	// ResolveRow maps a renderer-addressable row handle to the SecretID
	// behind it. Backend-only: the renderer never receives a SecretID
	// (nocx-jb20.1). The transport resolves the row first so it can clear
	// profile references — metadata first (ADR-0011 §4) — before the
	// stored secret is deleted.
	ResolveRow(row string, inputs []vault.CredentialInventory) (credential.SecretID, bool)
	// Get resolves id to a provider and reads the secret. The value is only
	// ever used inside Secret.Use; the transport hands the resolved bytes to
	// the caller for a PTY write and nowhere else.
	Get(ctx context.Context, id credential.SecretID) (credential.Secret, error)
	// ReplaceSecret overwrites the material behind an existing secret,
	// addressed by its renderer-addressable row handle — never by a SecretID
	// (nocx-jb20.1). The reference does not change: the new value lands under
	// the SAME SecretID, so every connection referencing the secret keeps
	// working.
	ReplaceSecret(ctx context.Context, row string, value credential.Secret, inputs []vault.CredentialInventory) error
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

// rpcErrorFor wraps a vault-domain error in an RPCError with the reason
// attached. The renderer tells "the vault needs setting up" apart from a
// genuine failure by reading data.reason; a bare -32603 with a prose message
// is indistinguishable from a disk error, so the setup dialog never opens and
// the user is shown a toast instead. That was the whole of nocx-25k9.7.
func rpcErrorFor(fallback int, msgPrefix string, err error) RPCError {
	return RPCError{
		Code:    vaultErrorCode(err, fallback),
		Message: msgPrefix + err.Error(),
		Data:    reasonForError(err),
	}
}

// handleVaultMethod dispatches vault.* RPCs. Returns -32601 when the vault
// lifecycle is not wired.
func (s *WSServer) handleVaultMethod(wconn Responder, req jsonrpcRequest) {
	if s.vaultLifecycle == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
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
	case "vault.createSecret":
		s.handleVaultCreateSecret(wconn, req)
	case "vault.renameSecret":
		s.handleVaultRenameSecret(wconn, req)
	case "vault.replaceSecret":
		s.handleVaultReplaceSecret(wconn, req)
	case "vault.deleteSecret":
		s.handleVaultDeleteSecret(wconn, req)
	case "vault.resolveLine":
		s.handleVaultResolveLine(wconn, req)
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

func (s *WSServer) handleVaultStatus(wconn Responder, req jsonrpcRequest) {
	ctx := context.Background()
	snap := s.vaultLifecycle.Snapshot(ctx)
	resp := vaultSnapToStatus(snap)
	_ = wconn.TryResult(req.ID, mustMarshal(resp))
}

func (s *WSServer) handleVaultSetup(wconn Responder, req jsonrpcRequest) {
	var params vaultSetupParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	vreq := vault.SetupRequest{Passphrase: params.Passphrase}
	result, err := s.vaultLifecycle.Setup(context.Background(), vreq)
	if err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
		return
	}
	// Response first, notification second: the caller that requested the
	// setup must learn its own outcome before any peer hears the change
	// the outcome caused. A vault.changed that precedes the announcing
	// response lets a listener act on a commit it has not yet been told
	// succeeded.
	var resp any = struct{}{}
	if result.RecoveryCode != "" {
		resp = struct {
			RecoveryCode string `json:"recoveryCode"`
		}{RecoveryCode: result.RecoveryCode}
	}
	_ = wconn.TryResult(req.ID, mustMarshal(resp))

	s.broadcastVaultChanged()
}

func (s *WSServer) handleVaultUnseal(wconn Responder, req jsonrpcRequest) {
	var params vaultUnsealParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	// Reject secretId — the renderer never names a secret reference.
	if params.SecretID != "" {
		err := fmt.Errorf("secretId is backend-owned")
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
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
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "invalid means: must be os, passphrase, or recovery"})
		return
	}

	if err := s.vaultLifecycle.Unseal(context.Background(), vreq); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

func (s *WSServer) handleVaultSeal(wconn Responder, req jsonrpcRequest) {
	s.vaultLifecycle.Seal()
	// Vault seal destroys every pending capture: the offer's plaintext
	// must not outlive the lock it was offered under (the capture
	// contract's destruction list names it). A save in flight is left to
	// settle — the registry skips non-pending captures.
	if s.captures != nil {
		s.captures.DestroyAll()
	}
	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
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

func (s *WSServer) handleVaultChangePassphrase(wconn Responder, req jsonrpcRequest) {
	var params vaultChangePassphraseParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	vreq := vault.ChangePassphraseRequest{
		OldPassphrase: params.OldPassphrase,
		RecoveryCode:  params.RecoveryCode,
		NewPassphrase: params.NewPassphrase,
	}
	if err := s.vaultLifecycle.ChangePassphrase(context.Background(), vreq); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

func (s *WSServer) handleVaultRegenerateRecovery(wconn Responder, req jsonrpcRequest) {
	var params vaultRegenerateRecoveryParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	vreq := vault.RegenerateRequest{Passphrase: params.Passphrase}
	recoveryCode, err := s.vaultLifecycle.RegenerateRecovery(context.Background(), vreq)
	if err != nil {
		errCode := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: errCode, Message: err.Error(), Data: reasonForError(err)})
		return
	}

	s.broadcastVaultChanged()
	resp := struct {
		RecoveryCode string `json:"recoveryCode"`
	}{RecoveryCode: recoveryCode}
	_ = wconn.TryResult(req.ID, mustMarshal(resp))
}

func (s *WSServer) handleVaultSetDefaultProvider(wconn Responder, req jsonrpcRequest) {
	var params vaultSetDefaultProviderParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	provID := vault.ProviderID(params.Provider)
	if err := s.vaultLifecycle.SetDefaultProvider(context.Background(), provID); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

type vaultSetAutoSealParams struct {
	Minutes *int `json:"minutes"`
}

func (s *WSServer) handleVaultSetAutoSeal(wconn Responder, req jsonrpcRequest) {
	var params vaultSetAutoSealParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if params.Minutes == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: minutes is required"})
		return
	}

	if err := s.vaultLifecycle.SetAutoSeal(context.Background(), *params.Minutes); err != nil {
		code := vaultErrorCode(err, -32603)
		_ = wconn.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

func (s *WSServer) handleVaultActivity(wconn Responder, req jsonrpcRequest) {
	s.vaultLifecycle.Activity()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

func (s *WSServer) handleVaultInventory(wconn Responder, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.inventory not available"})
		return
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}

	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}

	inputs := s.vaultInventoryInputs(profiles, groups)

	entries, err := s.vaultLifecycle.BuildInventory(context.Background(), inputs)
	if err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.inventory: ", err))
		return
	}

	result := struct {
		Entries []vault.InventoryEntry `json:"entries"`
	}{Entries: entries}

	_ = wconn.TryResult(req.ID, mustMarshal(result))
}

// vaultInventoryInputs projects profile secret bindings into the vault's
// inventory input shape: one entry per distinct bound secret, with its usage
// count and, for a single-use secret, the effective host and port of the
// sole profile (ADR-0017: a connection references a secret).
//
// Every input ref lands in the SecretID slot and the KIND is not carried
// here: BuildInventory takes it from the vault's own catalogue record
// (ADR-0016), which every bound secret has — every mint path goes through
// CreateNamed. The slot's fallback kind therefore never mislabels a real
// secret; it would only affect a recordless pre-ADR-0016 reference, which
// the wired app cannot produce.
func (s *WSServer) vaultInventoryInputs(profiles []profile.SSHProfile, groups []profile.ProfileGroup) []vault.CredentialInventory {
	usage := profile.ComputeSecretUsage(profiles, groups, profile.SparseSSHOptions{})

	// Build profile lookup for label resolution and single-use ownership.
	profByID := make(map[string]profile.SSHProfile, len(profiles))
	for _, p := range profiles {
		profByID[p.ID] = p
	}

	inputs := make([]vault.CredentialInventory, 0, len(usage))
	for _, u := range usage {
		ci := vault.CredentialInventory{
			SecretID:   u.SecretID,
			UsageCount: len(u.Profiles),
		}

		// Labels derive from the first user of the secret; the renderer-safe
		// owner id and the single-use host:port come from the sole profile
		// when there is one. A SecretID is NEVER used as an owner id — it
		// would leak the reference onto the inventory wire (ADR-0011 §2).
		if len(u.Profiles) > 0 {
			if p, ok := profByID[u.Profiles[0].ProfileID]; ok {
				eff, resolveErr := profile.ResolveEffectiveProfile(p, groups, profile.SparseSSHOptions{})
				if resolveErr == nil {
					ci.Username = eff.ResolvedOptions.User
					ci.AuthMode = string(eff.ResolvedOptions.Auth)
					if len(u.Profiles) == 1 {
						ci.ID = u.Profiles[0].ProfileID
						ci.SingleHost = eff.ResolvedOptions.Host
						ci.SinglePort = eff.ResolvedOptions.Port
					}
				}
			}
		}

		inputs = append(inputs, ci)
	}
	return inputs
}

type vaultCreateSecretParams struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Value string `json:"value,omitempty"`
	Path  string `json:"path,omitempty"`
	// Resolve asks for atomic name-collision resolution — the same path
	// secrets.captureSave takes (vault.CreateNamedResolved) — and for the
	// name ACTUALLY used in the response. The Secrets page's ordinary
	// create keeps CreateNamed's exact-name semantics and an empty result.
	// The renderer must never predict that a suffixed name is free; the
	// vault is where the real name is decided.
	Resolve bool `json:"resolve,omitempty"`
}

// vaultCreateSecretResponse carries the name ACTUALLY used, so a caller
// that asked for collision resolution (the prompt's ⌘S save) can build the
// {{secret:NAME}} reference from the vault's answer, never from the name it
// sent. The Secrets page ignores it.
type vaultCreateSecretResponse struct {
	Name string `json:"name"`
}

// handleVaultCreateSecret stores a secret the user created on the Secrets
// page: they were asked for the name and the kind, so both are required. The
// value goes to the default provider; the name and kind go into the vault's
// catalogue record — in the same create sequence, never a second path
// (ADR-0016).
//
// A private key may be supplied by PATH instead of by value: the renderer
// cannot read arbitrary paths, so the backend dereferences the path at save
// time and stores the file's CONTENTS — never the path string, which is the
// defect dcf566b fixed on the connection editor and must not be
// reintroduced here.
func (s *WSServer) handleVaultCreateSecret(wconn Responder, req jsonrpcRequest) {
	var params vaultCreateSecretParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.Name) == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: name is required"})
		return
	}

	value := params.Value
	if params.Path != "" {
		contents, err := readKeyFile(params.Path)
		if err != nil {
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.createSecret: read key file: ", err))
			return
		}
		value = contents
	}

	name := params.Name
	if params.Resolve {
		_, realName, err := s.vaultLifecycle.CreateNamedResolved(context.Background(), credential.NewSecret(value),
			vault.SecretMeta{Name: params.Name, Kind: params.Kind})
		if err != nil {
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.createSecret: ", err))
			return
		}
		name = realName
	} else {
		_, err := s.vaultLifecycle.CreateNamed(context.Background(), credential.NewSecret(value),
			vault.SecretMeta{Name: params.Name, Kind: params.Kind})
		if err != nil {
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.createSecret: ", err))
			return
		}
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(vaultCreateSecretResponse{Name: name}))
}

// readKeyFile reads the file the user chose in Path mode. A leading ~ is
// expanded to the home directory: the native dialog yields absolute paths,
// but the hand-typed fallback (dev-web, where no dialog exists) commonly
// starts with ~, and the backend is the only side that can resolve it.
func readKeyFile(path string) (string, error) {
	expanded := path
	if path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		expanded = home
	} else if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		expanded = filepath.Join(home, path[2:])
	}
	// gosec flags the variable path, and the flag is worth answering rather
	// than silencing. The path comes from the renderer, so this is an
	// arbitrary-read primitive on the control plane — but the caller and the
	// file's owner are the same person: nocx runs as the user, reading a key
	// they named, on a machine they own. A hostile owner of the machine is
	// explicitly out of the threat model (T6), and a process that could forge
	// this call already runs as them and can read the file directly (T4).
	//
	// What must NOT be allowed is a path arriving from anywhere but the user's
	// own typing or the native dialog. That is the boundary to keep, and it is
	// why the contents go straight into the vault and are never echoed back:
	// an attacker who could steer this call must not also be able to read what
	// it found.
	data, err := os.ReadFile(expanded) //nolint:gosec // see above: user-named path, user-owned file, contents never returned
	if err != nil {
		return "", err
	}
	return string(data), nil
}

type vaultRenameSecretParams struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// handleVaultRenameSecret sets a secret's display name. The row is addressed
// by its renderer-addressable handle, which the backend resolves — a SecretID
// is never accepted from the renderer as an identifier (nocx-jb20.1). The
// row set is the same one the inventory shows, so an unrecorded
// (pre-ADR-0016) reference can be renamed too.
func (s *WSServer) handleVaultRenameSecret(wconn Responder, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.renameSecret not available"})
		return
	}
	var params vaultRenameSecretParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.Name) == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: name is required"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	inputs := s.vaultInventoryInputs(profiles, groups)

	if err := s.vaultLifecycle.RenameSecret(context.Background(), params.ID, params.Name, inputs); err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.renameSecret: ", err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

type vaultReplaceSecretParams struct {
	ID    string `json:"id"`
	Value string `json:"value,omitempty"`
	Path  string `json:"path,omitempty"`
}

// handleVaultReplaceSecret overwrites a secret's material. The row is
// addressed by its renderer-addressable handle, which the backend resolves —
// a SecretID is never accepted from the renderer as an identifier
// (nocx-jb20.1). The reference does NOT change: the new value lands under
// the same SecretID, so every connection using the secret keeps working and
// the name and kind are untouched (renaming and replacing are independent
// operations). The old value is never shown back — the vault does not hand
// it out (ADR-0011 §2) — so the renderer only ever supplies the replacement.
// Like create, a private key may be supplied by PATH, which the backend
// dereferences to the file's contents.
func (s *WSServer) handleVaultReplaceSecret(wconn Responder, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.replaceSecret not available"})
		return
	}
	var params vaultReplaceSecretParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}

	value := params.Value
	if params.Path != "" {
		contents, err := readKeyFile(params.Path)
		if err != nil {
			_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.replaceSecret: read key file: ", err))
			return
		}
		value = contents
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	inputs := s.vaultInventoryInputs(profiles, groups)

	if err := s.vaultLifecycle.ReplaceSecret(context.Background(), params.ID, credential.NewSecret(value), inputs); err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.replaceSecret: ", err))
		return
	}

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

type vaultDeleteSecretParams struct {
	ID string `json:"id"`
}

// handleVaultDeleteSecret deletes a secret the user chose on the Secrets
// page. The row is addressed by its renderer-addressable handle, which the
// backend resolves — a SecretID is never accepted from the renderer as an
// identifier (nocx-jb20.1).
//
// # Order: metadata first, stored secret second (ADR-0011 §4)
//
// "Deletion goes metadata-first with a retriable secret deletion after: a
// brief unreachable orphan is safer than metadata pointing at a secret that
// is gone." The profile records are the metadata that point at this secret,
// so every reference is cleared BEFORE the vault deletes the stored value —
// the vault's own catalogue record and journal go with the provider delete,
// in Vault.Delete's existing metadata-first sequence. A failed provider
// delete therefore leaves a brief unreachable orphan (the journal retries
// it), never a connection claiming a password that cannot exist.
func (s *WSServer) handleVaultDeleteSecret(wconn Responder, req jsonrpcRequest) {
	if s.profiles == nil || s.groups == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.deleteSecret not available"})
		return
	}
	if s.vaultLifecycle == nil || s.credentials == nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32601, Message: "vault.deleteSecret not available"})
		return
	}
	var params vaultDeleteSecretParams
	if !isJSONObject(req.Params) {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = wconn.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}

	profiles, err := s.profiles.LoadProfiles()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	groups, err := s.groups.LoadGroups()
	if err != nil {
		_ = wconn.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	inputs := s.vaultInventoryInputs(profiles, groups)

	// Resolve the row to the secret it names before touching anything: the
	// reference must be found while the metadata still holds it.
	id, ok := s.vaultLifecycle.ResolveRow(params.ID, inputs)
	if !ok {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.deleteSecret: ", fmt.Errorf("unknown secret row %q", params.ID)))
		return
	}

	// Metadata first (ADR-0011 §4): clear every reference in the profile
	// records — one atomic write. If this fails, nothing was deleted.
	pc, ok := s.profiles.(interface{ ClearSecretRefs(string) error })
	if !ok {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.deleteSecret: ", errors.New("profile store does not support reference clearing")))
		return
	}
	if err := pc.ClearSecretRefs(string(id)); err != nil {
		_ = wconn.TryError(req.ID, rpcErrorFor(-32603, "vault.deleteSecret: ", err))
		return
	}

	// Stored secret second, best-effort like every other metadata-first
	// deletion in this file: the metadata removal stands regardless, and a
	// failed provider delete is a brief unreachable orphan the journal
	// reconciles — never a dangling row.
	_ = s.credentials.Delete(context.Background(), id)

	s.broadcastVaultChanged()
	_ = wconn.TryResult(req.ID, mustMarshal(struct{}{}))
}

// broadcastVaultChanged sends a vault.changed notification to every connected
// client. Best-effort and non-blocking: each notification is one enqueue
// into the connection's outbound queue, so a slow renderer delays its own
// connection only.
func (s *WSServer) broadcastVaultChanged() {
	s.connsMu.Lock()
	conns := make([]*wsConn, 0, len(s.conns))
	for wc := range s.conns {
		conns = append(conns, wc)
	}
	s.connsMu.Unlock()

	// Every other caller reaches here from handleVaultMethod, which refuses
	// when the lifecycle is absent — so this dereference was safe by
	// construction until vault.reset arrived. Reset deliberately bypasses that
	// gate, because a reset must work on a vault that is broken or half-built,
	// and there is nothing to announce when there is no vault to describe.
	if s.vaultLifecycle == nil {
		return
	}

	ctx := context.Background()
	snap := s.vaultLifecycle.Snapshot(ctx)
	for _, wc := range conns {
		_ = wc.TryNotify("vault.changed", mustMarshal(vaultSnapToStatus(snap)))
	}
}
