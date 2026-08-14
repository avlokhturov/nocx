package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/transport/control"
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

// vaultMachine is the transport-owned vault surface the vault handlers need
// beyond their capability operations: the vault.changed notification fan-out.
// WSServer implements it; a handler is constructed with the interface, so it
// can announce changes without reaching the server's stores. This is
// transport lifecycle (the connection fan-out), not a store — no capability
// gates it (migration map).
type vaultMachine interface {
	broadcastVaultChanged()
}

// vaultLifecycleHandlers answers the vault-lifecycle methods: status, setup,
// unseal, seal, changePassphrase, regenerateRecovery, setDefaultProvider,
// setAutoSeal, activity. It holds the VaultOperation (the vault gate), the
// Responder, the transport-owned capture registry (seal destroys every
// pending capture: the offer's plaintext must not outlive the lock it was
// offered under) and the vault.changed fan-out; nothing else.
type vaultLifecycleHandlers struct {
	op       capability.VaultOperation // nil → vault lifecycle not wired
	r        Responder
	captures *credential.CaptureRegistry
	machine  vaultMachine
}

// vaultSecretHandlers answers the vault-secret methods: inventory,
// createSecret, renameSecret, replaceSecret, deleteSecret, resolveLine. It
// holds the shared SecretOperation ([config, vault] gates) and the
// vault.changed fan-out; the profile/group/credential stores are reachable
// only through the operation's service.
type vaultSecretHandlers struct {
	op       capability.SecretOperation // nil → not fully wired
	r        Responder
	machine  vaultMachine
	notWired string // exact old -32601 answer when op is nil
}

// vaultSecretError shapes a SecretService error the way the old handler did:
// a typed vault-domain error keeps the rpcErrorFor form — the actionable
// code, the method prefix and the machine-readable reason — while a
// config-store load error was answered bare, -32603 with the message only.
func vaultSecretError(fallback int, msgPrefix string, err error) RPCError {
	if vaultErrorCode(err, fallback) != fallback {
		return rpcErrorFor(fallback, msgPrefix, err)
	}
	return RPCError{Code: fallback, Message: err.Error()}
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

func (h vaultLifecycleHandlers) handleStatus(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		snap := svc.Snapshot(ctx)
		resp := vaultSnapToStatus(snap)
		_ = h.r.TryResult(req.ID, mustMarshal(resp))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleSetup(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultSetupParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		vreq := vault.SetupRequest{Passphrase: params.Passphrase}
		// Background is deliberate — domain-owned commit interval: vault Setup
		// documents its commit point and rolls back pre-commit failures itself
		// (owner: the initialization operation; see internal/vault/vault.go).
		// The transport never cancels across that boundary. Closing event:
		// Setup returning after commit-or-rollback.
		result, err := svc.Setup(context.Background(), vreq)
		if err != nil {
			code := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
			return nil
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
		_ = h.r.TryResult(req.ID, mustMarshal(resp))
		h.machine.broadcastVaultChanged()
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleUnseal(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultUnsealParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}

	// Reject secretId — the renderer never names a secret reference.
	if params.SecretID != "" {
		err := fmt.Errorf("secretId is backend-owned")
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: err.Error()})
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
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "invalid means: must be os, passphrase, or recovery"})
		return
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		if err := svc.Unseal(ctx, vreq); err != nil {
			code := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleSeal(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		svc.Seal()
		// Vault seal destroys every pending capture: the offer's plaintext
		// must not outlive the lock it was offered under (the capture
		// contract's destruction list names it). A save in flight is left to
		// settle — the registry skips non-pending captures.
		if h.captures != nil {
			h.captures.DestroyAll()
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
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

func (h vaultLifecycleHandlers) handleChangePassphrase(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultChangePassphraseParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		vreq := vault.ChangePassphraseRequest{
			OldPassphrase: params.OldPassphrase,
			RecoveryCode:  params.RecoveryCode,
			NewPassphrase: params.NewPassphrase,
		}
		if err := svc.ChangePassphrase(ctx, vreq); err != nil {
			code := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleRegenerateRecovery(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultRegenerateRecoveryParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		vreq := vault.RegenerateRequest{Passphrase: params.Passphrase}
		recoveryCode, err := svc.RegenerateRecovery(ctx, vreq)
		if err != nil {
			errCode := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: errCode, Message: err.Error(), Data: reasonForError(err)})
			return nil
		}
		h.machine.broadcastVaultChanged()
		resp := struct {
			RecoveryCode string `json:"recoveryCode"`
		}{RecoveryCode: recoveryCode}
		_ = h.r.TryResult(req.ID, mustMarshal(resp))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleSetDefaultProvider(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultSetDefaultProviderParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		provID := vault.ProviderID(params.Provider)
		if err := svc.SetDefaultProvider(ctx, provID); err != nil {
			code := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

type vaultSetAutoSealParams struct {
	Minutes *int `json:"minutes"`
}

func (h vaultLifecycleHandlers) handleSetAutoSeal(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	var params vaultSetAutoSealParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if params.Minutes == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: minutes is required"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		if err := svc.SetAutoSeal(ctx, *params.Minutes); err != nil {
			code := vaultErrorCode(err, -32603)
			_ = h.r.TryError(req.ID, RPCError{Code: code, Message: err.Error(), Data: reasonForError(err)})
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultLifecycleHandlers) handleActivity(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "vault not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.VaultService) error {
		svc.Activity()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

func (h vaultSecretHandlers) handleInventory(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: h.notWired})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		entries, err := svc.Inventory(ctx)
		if err != nil {
			_ = h.r.TryError(req.ID, vaultSecretError(-32603, "vault.inventory: ", err))
			return nil
		}
		result := struct {
			Entries []vault.InventoryEntry `json:"entries"`
		}{Entries: entries}
		_ = h.r.TryResult(req.ID, mustMarshal(result))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
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

// handleCreateSecret stores a secret the user created on the Secrets
// page: they were asked for the name and the kind, so both are required. The
// value goes to the default provider; the name and kind go into the vault's
// catalogue record — in the same create sequence, never a second path
// (ADR-0016). The service owns the atomic name-collision resolution when
// asked for it (vault.createSecret's resolve flag) and reports the name
// ACTUALLY used, so a caller can build the {{secret:NAME}} reference from
// the vault's answer, never from the name it sent.
//
// A private key may be supplied by PATH instead of by value: the renderer
// cannot read arbitrary paths, so the backend dereferences the path at save
// time and stores the file's CONTENTS — never the path string, which is the
// defect dcf566b fixed on the connection editor and must not be
// reintroduced here.
func (h vaultSecretHandlers) handleCreateSecret(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: h.notWired})
		return
	}
	var params vaultCreateSecretParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.Name) == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: name is required"})
		return
	}

	value := params.Value
	if params.Path != "" {
		contents, err := readKeyFile(params.Path)
		if err != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "vault.createSecret: read key file: ", err))
			return
		}
		value = contents
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		name, err := svc.CreateSecret(ctx, credential.NewSecret(value), vault.SecretMeta{Name: params.Name, Kind: params.Kind}, params.Resolve)
		if err != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "vault.createSecret: ", err))
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(vaultCreateSecretResponse{Name: name}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
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

// handleRenameSecret sets a secret's display name. The row is addressed
// by its renderer-addressable handle, which the backend resolves — a SecretID
// is never accepted from the renderer as an identifier (nocx-jb20.1). The
// row set is the same one the inventory shows, so an unrecorded
// (pre-ADR-0016) reference can be renamed too.
func (h vaultSecretHandlers) handleRenameSecret(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: h.notWired})
		return
	}
	var params vaultRenameSecretParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.Name) == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: name is required"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		if err := svc.RenameSecret(ctx, params.ID, params.Name); err != nil {
			_ = h.r.TryError(req.ID, vaultSecretError(-32603, "vault.renameSecret: ", err))
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

type vaultReplaceSecretParams struct {
	ID    string `json:"id"`
	Value string `json:"value,omitempty"`
	Path  string `json:"path,omitempty"`
}

// handleReplaceSecret overwrites a secret's material. The row is
// addressed by its renderer-addressable handle, which the backend resolves —
// a SecretID is never accepted from the renderer as an identifier
// (nocx-jb20.1). The reference does NOT change: the new value lands under
// the same SecretID, so every connection using the secret keeps working and
// the name and kind are untouched (renaming and replacing are independent
// operations). The old value is never shown back — the vault does not hand
// it out (ADR-0011 §2) — so the renderer only ever supplies the replacement.
// Like create, a private key may be supplied by PATH, which the backend
// dereferences to the file's contents.
func (h vaultSecretHandlers) handleReplaceSecret(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: h.notWired})
		return
	}
	var params vaultReplaceSecretParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}

	value := params.Value
	if params.Path != "" {
		contents, err := readKeyFile(params.Path)
		if err != nil {
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "vault.replaceSecret: read key file: ", err))
			return
		}
		value = contents
	}

	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		if err := svc.ReplaceSecret(ctx, params.ID, credential.NewSecret(value)); err != nil {
			_ = h.r.TryError(req.ID, vaultSecretError(-32603, "vault.replaceSecret: ", err))
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

type vaultDeleteSecretParams struct {
	ID string `json:"id"`
}

// handleDeleteSecret deletes a secret the user chose on the Secrets
// page. The row is addressed by its renderer-addressable handle, which the
// backend resolves — a SecretID is never accepted from the renderer as an
// identifier (nocx-jb20.1).
//
// # Order: metadata first, stored secret second (ADR-0011 §4)
//
// The service owns the order: "Deletion goes metadata-first with a retriable
// secret deletion after: a brief unreachable orphan is safer than metadata
// pointing at a secret that is gone." Every profile reference is cleared —
// one atomic write — BEFORE the stored value is deleted, so a failed
// provider delete leaves a brief unreachable orphan (the journal retries
// it), never a connection claiming a password that cannot exist.
func (h vaultSecretHandlers) handleDeleteSecret(ctx context.Context, req jsonrpcRequest) {
	if h.op == nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: h.notWired})
		return
	}
	var params vaultDeleteSecretParams
	if !isJSONObject(req.Params) {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if strings.TrimSpace(params.ID) == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: id is required"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		if err := svc.DeleteSecret(ctx, params.ID); err != nil {
			_ = h.r.TryError(req.ID, vaultSecretError(-32603, "vault.deleteSecret: ", err))
			return nil
		}
		h.machine.broadcastVaultChanged()
		_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
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

	// Every other caller reaches here from the vault lifecycle handlers,
	// which are constructed with a nil operation when the lifecycle is
	// absent and refuse before announcing — so this dereference was safe by
	// construction until vault.reset arrived. Reset deliberately bypasses
	// that gate, because a reset must work on a vault that is broken or
	// half-built, and there is nothing to announce when there is no vault to
	// describe.
	if s.vaultLifecycle == nil {
		return
	}
	// Background is deliberate here, and the owner is the notification
	// fan-out, not any one request: vault.changed is addressed to EVERY
	// connection, so no single connection's lifetime is the right owner
	// (the mutating handler's own work is done by the time the snapshot
	// runs). The closing event is the synchronous snapshot read completing
	// within the caller's handler — bounded, in-memory, never awaited.
	snap := s.vaultLifecycle.Snapshot(context.Background())
	for _, wc := range conns {
		_ = wc.TryNotify("vault.changed", mustMarshal(vaultSnapToStatus(snap)))
	}
}

// vaultSecretUnavailable computes the exact old not-wired answer for a
// vault-secret method from the construction wiring: the old dispatcher
// answered "vault not available" whenever the vault lifecycle was absent,
// and with a lifecycle present but the profile/group stores absent each
// config-dependent method answered its own "vault.<method> not available".
// vault.createSecret had no per-method gate — it ran on the lifecycle
// alone — so its fallback is the family's message.
func (s *WSServer) vaultSecretUnavailable(method string) string {
	if s.vaultLifecycle == nil {
		return "vault not available"
	}
	switch method {
	case "vault.inventory":
		return "vault.inventory not available"
	case "vault.renameSecret":
		return "vault.renameSecret not available"
	case "vault.replaceSecret":
		return "vault.replaceSecret not available"
	case "vault.deleteSecret":
		return "vault.deleteSecret not available"
	case "vault.resolveLine":
		return "vault.resolveLine not available"
	default:
		return "vault not available"
	}
}

// vaultSpecs declares the vault.* control methods: the lifecycle family
// under the VaultOperation (vault gate), the secret family under the shared
// SecretOperation ([config, vault] gates — the inventory inputs are computed
// inside the service from the profile/group stores) and the reset family
// under the VaultResetOperation, which is built from the reset orchestrator
// alone so a reset stays reachable on a vault that is broken or half-built.
// The operations are built here from the wired stores (composition root for
// this domain): nil when their stores are absent, and the handlers then
// answer the old not-available errors.
func (s *WSServer) vaultSpecs(lane control.Admission, configGate, vaultGate control.Admission) []methodSpec {
	var vaultOp capability.VaultOperation
	if s.vaultLifecycle != nil {
		vaultOp = capability.NewVaultOperation(vaultGate, lane, s.vaultLifecycle)
	}
	var secretOp capability.SecretOperation
	if s.vaultLifecycle != nil && s.profiles != nil && s.groups != nil && s.credentials != nil {
		secretOp = capability.NewSecretOperation(configGate, vaultGate, lane, s.profiles, s.groups, s.vaultLifecycle, s.credentials)
	}
	var resetOp capability.VaultResetOperation
	if s.vaultReset != nil {
		resetOp = capability.NewVaultResetOperation(configGate, vaultGate, lane, s.vaultReset)
	}
	vaultSub := s.operationQueue("vault")
	secretSub := s.operationQueue("vault-secret")
	resetSub := s.operationQueue("vault-reset")

	return []methodSpec{
		regResponder(vaultSub, "vault.status", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleStatus(ctx, req) }
		}),
		regResponder(vaultSub, "vault.setup", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSetup(ctx, req) }
		}),
		regResponder(vaultSub, "vault.unseal", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleUnseal(ctx, req) }
		}),
		regResponder(vaultSub, "vault.seal", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSeal(ctx, req) }
		}),
		regResponder(vaultSub, "vault.changePassphrase", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleChangePassphrase(ctx, req) }
		}),
		regResponder(vaultSub, "vault.regenerateRecovery", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleRegenerateRecovery(ctx, req) }
		}),
		regResponder(vaultSub, "vault.setDefaultProvider", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSetDefaultProvider(ctx, req) }
		}),
		regResponder(vaultSub, "vault.setAutoSeal", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleSetAutoSeal(ctx, req) }
		}),
		regResponder(vaultSub, "vault.activity", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultLifecycleHandlers{op: vaultOp, r: r, captures: s.captures, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleActivity(ctx, req) }
		}),
		regResponder(secretSub, "vault.inventory", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.inventory")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleInventory(ctx, req) }
		}),
		regResponder(secretSub, "vault.createSecret", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.createSecret")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleCreateSecret(ctx, req) }
		}),
		regResponder(secretSub, "vault.renameSecret", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.renameSecret")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleRenameSecret(ctx, req) }
		}),
		regResponder(secretSub, "vault.replaceSecret", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.replaceSecret")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleReplaceSecret(ctx, req) }
		}),
		regResponder(secretSub, "vault.deleteSecret", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.deleteSecret")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleDeleteSecret(ctx, req) }
		}),
		regResponder(secretSub, "vault.resolveLine", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultSecretHandlers{op: secretOp, r: r, machine: s, notWired: s.vaultSecretUnavailable("vault.resolveLine")}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleResolveLine(ctx, req) }
		}),
		regResponder(resetSub, "vault.resetPreview", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultResetHandlers{op: resetOp, r: r, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleResetPreview(ctx, req) }
		}),
		regResponder(resetSub, "vault.reset", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := vaultResetHandlers{op: resetOp, r: r, machine: s}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleReset(ctx, req) }
		}),
	}
}
