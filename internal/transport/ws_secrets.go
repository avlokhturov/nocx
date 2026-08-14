package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	gossh "golang.org/x/crypto/ssh"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/transport/control"
	"github.com/shady2k/nocx/internal/vault"
)

// ---------------------------------------------------------------------------
// The row-handle translation seam (ADR-0017 §1)
// ---------------------------------------------------------------------------
//
// A profile's secret bindings are BACKEND-OWNED references (sec:v1:...) in
// storage. The renderer may not hold or name a reference (ADR-0011 §2), so
// every profile that crosses the wire carries the reference's row handle
// (secrow:...) instead. The seam has a pure half and a resolving half:
//
//	reference → row   vault.RowFor (one-way derivation, no vault state read)
//	row → reference   the capability services (SecretService.ResolveRow,
//	                  ConfigService) — the transport no longer resolves rows
//	                  (migration map: the resolution lives in the services)
//
// Every profile/group read path converts to rows before marshaling; every
// write path resolves rows before storing. A reference therefore never
// appears in a renderer response, and a row never survives into storage.

// secretRefToRow converts a stored reference to the renderer's row handle.
// Empty stays empty.
func secretRefToRow(ref string) string {
	if ref == "" {
		return ""
	}
	return vault.RowFor(credential.SecretID(ref))
}

// optionsToWire replaces every stored secret reference in a profile's
// options with its row handle. Used on every read path that marshals a
// profile to the renderer.
func optionsToWire(o profile.StoredSSHProfileOptions) profile.StoredSSHProfileOptions {
	o.PasswordSecret = secretRefToRow(o.PasswordSecret)
	o.KeySecret = secretRefToRow(o.KeySecret)
	o.KeyPassphraseSecret = secretRefToRow(o.KeyPassphraseSecret)
	return o
}

// wireProfile converts a stored profile to its wire form: every secret
// reference replaced with the renderer's row handle.
func wireProfile(p profile.SSHProfile) profile.SSHProfile {
	p.Options = optionsToWire(p.Options)
	return p
}

// wireGroup converts a stored group to its wire form: every secret reference
// in the group's defaults replaced with the renderer's row handle.
func wireGroup(g profile.ProfileGroup) profile.ProfileGroup {
	if g.Defaults != nil {
		g.Defaults.SparseSSHOptions = sparseToWire(g.Defaults.SparseSSHOptions)
	}
	return g
}

// sparseToWire replaces the secret references in group/global defaults with
// row handles.
func sparseToWire(s profile.SparseSSHOptions) profile.SparseSSHOptions {
	rowPtr := func(p *string) *string {
		if p == nil {
			return nil
		}
		v := secretRefToRow(*p)
		return &v
	}
	s.PasswordSecret = rowPtr(s.PasswordSecret)
	s.KeySecret = rowPtr(s.KeySecret)
	s.KeyPassphraseSecret = rowPtr(s.KeyPassphraseSecret)
	return s
}

// wireEffectiveSecretFields replaces the secret references in an effective
// DTO's fields with row handles, so the renderer never receives a reference
// (ADR-0011 §2).
func wireEffectiveSecretFields(dto *profile.EffectiveProfileDTO) {
	for _, name := range []string{"passwordSecret", "keySecret", "keyPassphraseSecret"} {
		f, ok := dto.Fields[name]
		if !ok {
			continue
		}
		s, isStr := f.Value.(string)
		if isStr {
			f.Value = secretRefToRow(s)
			dto.Fields[name] = f
		}
	}
}

// ---------------------------------------------------------------------------
// The secrets.* handlers (migration map, "secrets.*")
// ---------------------------------------------------------------------------

// secretsHandlers answers the vault-secret methods: secrets.usage and the
// three mint methods (ADR-0017 §1, zqce.3). It holds the SecretOperation
// (config, vault gates — built once in secretSpecs) and the Responder; every
// store access goes through the operation's service. The wired flags
// reproduce the old handlers' answers on the unwired paths: secrets.usage
// reported "not available" without the vault or the profile/group stores,
// secrets.saveKeyPassphrase refused a row without a vault, and the other mint
// methods fell back to the plain store exactly like the old createSecret
// (MintSecret mirrors it in the service).
type secretsHandlers struct {
	op          capability.SecretOperation
	r           Responder
	vaultWired  bool // vaultLifecycle != nil at construction
	configWired bool // profiles != nil && groups != nil at construction
	storeWired  bool // credentials != nil at construction
}

// handleUsage answers secrets.usage: for one vault row, the profiles that use
// the secret behind it (ADR-0017: the count is the number of profiles whose
// effective secret is this one). The renderer addresses the secret by its row
// handle; the reference never leaves the backend. An unknown row or an unused
// secret answers an empty profile list.
func (h secretsHandlers) handleUsage(ctx context.Context, req jsonrpcRequest) {
	var params struct {
		Row string `json:"row"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Row == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: row required"})
		return
	}
	if !h.vaultWired || !h.configWired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "secrets.usage not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
		profiles, err := svc.Usage(ctx, params.Row)
		if err != nil {
			_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
			return nil
		}
		if profiles == nil {
			profiles = []profile.ProfileRef{}
		}
		_ = h.r.TryResult(req.ID, mustMarshal(struct {
			Profiles []profile.ProfileRef `json:"profiles"`
		}{Profiles: profiles}))
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// secretMintResult is the result of the password and passphrase mint
// methods: the row handle the editor names on the profile's options.
type secretMintResult struct {
	Row string `json:"row"`
}

// handleMint answers the three secrets.save* methods. Key and passphrase
// PARSING stays here (pure); only the store access goes through the service
// — MintSecret for the create, ResolveRow and GetSecret for the passphrase's
// verify-read.
func (h secretsHandlers) handleMint(ctx context.Context, req jsonrpcRequest) {
	switch req.Method {
	case "secrets.savePassword":
		var params struct {
			Password string `json:"password"`
			Name     string `json:"name,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.Password == "" {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: password required"})
			return
		}
		err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
			id, err := svc.MintSecret(ctx, credential.NewSecret(params.Password),
				vault.SecretMeta{Name: params.Name, Kind: vault.KindPassword})
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store password: ", err))
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(secretMintResult{Row: vault.RowFor(id)}))
			return nil
		})
		if err != nil {
			answerOperationRefusal(h.r, req.ID, err)
		}

	case "secrets.saveKeyMaterial":
		var params struct {
			KeyText string `json:"keyText"`
			Name    string `json:"name,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.KeyText == "" {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: keyText required"})
			return
		}
		fingerprint, passphraseWanted, parseErr := parsePrivateKeyMaterial(params.KeyText)
		if parseErr != nil {
			var invalidKey *errInvalidKeyMaterial
			if errors.As(parseErr, &invalidKey) {
				_ = h.r.TryError(req.ID, RPCError{
					Code:    -32603,
					Message: parseErr.Error(),
					Data:    &vaultErrorData{Reason: "invalid-key"},
				})
				return
			}
			_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store key material: ", parseErr))
			return
		}
		runErr := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
			id, err := svc.MintSecret(ctx, credential.NewSecret(params.KeyText),
				vault.SecretMeta{Name: params.Name, Kind: vault.KindPrivateKey})
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store key material: ", err))
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(struct {
				secretMintResult
				Fingerprint      string `json:"fingerprint"`
				PassphraseWanted bool   `json:"passphraseWanted"`
			}{
				secretMintResult: secretMintResult{Row: vault.RowFor(id)},
				Fingerprint:      fingerprint,
				PassphraseWanted: passphraseWanted,
			}))
			return nil
		})
		if runErr != nil {
			answerOperationRefusal(h.r, req.ID, runErr)
		}

	case "secrets.saveKeyPassphrase":
		var params struct {
			KeyRow     string `json:"keyRow"`
			Passphrase string `json:"passphrase"`
			Name       string `json:"name,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.KeyRow == "" {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: keyRow required"})
			return
		}
		if !h.vaultWired {
			_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "no vault: cannot resolve a secret row"})
			return
		}
		err := h.op.Run(ctx, func(ctx context.Context, svc capability.SecretService) error {
			keyID, ok := svc.ResolveRow(params.KeyRow)
			if !ok {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: fmt.Sprintf("unknown secret row %q", params.KeyRow)})
				return nil
			}
			if keyID == "" {
				_ = h.r.TryError(req.ID, RPCError{
					Code:    -32603,
					Message: "no stored key to verify against",
					Data:    &vaultErrorData{Reason: "invalid-key-passphrase"},
				})
				return nil
			}
			if !h.storeWired {
				_ = h.r.TryError(req.ID, RPCError{
					Code:    -32603,
					Message: "secret store not available",
					Data:    &vaultErrorData{Reason: "invalid-key-passphrase"},
				})
				return nil
			}
			secret, err := svc.GetSecret(ctx, keyID)
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store passphrase: ", fmt.Errorf("load key material: %w", err)))
				return nil
			}
			if verr := verifyPassphraseSecret(secret, []byte(params.Passphrase)); verr != nil {
				var invalidPass *errInvalidKeyPassphrase
				if errors.As(verr, &invalidPass) {
					_ = h.r.TryError(req.ID, RPCError{
						Code:    -32603,
						Message: verr.Error(),
						Data:    &vaultErrorData{Reason: "invalid-key-passphrase"},
					})
					return nil
				}
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store passphrase: ", verr))
				return nil
			}
			id, err := svc.MintSecret(ctx, credential.NewSecret(params.Passphrase),
				vault.SecretMeta{Name: params.Name, Kind: vault.KindKeyPassphrase})
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "store passphrase: ", err))
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(secretMintResult{Row: vault.RowFor(id)}))
			return nil
		})
		if err != nil {
			answerOperationRefusal(h.r, req.ID, err)
		}
	}
}

// verifyPassphraseSecret answers whether the passphrase opens the stored key
// material behind the secret. Refuses when it does not (nocx-dze3). The
// store read happened before (GetSecret); this is the pure parse half and
// stays in the handler.
func verifyPassphraseSecret(secret credential.Secret, passphrase []byte) error {
	if secret.IsEmpty() {
		return &errInvalidKeyPassphrase{msg: "stored key material is empty"}
	}
	var opens bool
	if err := secret.Use(func(keyBytes []byte) error {
		_, parseErr := gossh.ParsePrivateKeyWithPassphrase(keyBytes, passphrase)
		opens = parseErr == nil
		return nil
	}); err != nil {
		return fmt.Errorf("read key material: %w", err)
	}
	if !opens {
		return &errInvalidKeyPassphrase{msg: "that passphrase does not open this key"}
	}
	return nil
}

// secretSpecs declares the secrets.* control methods: the vault-secret mint
// and usage surface under one SecretOperation ([config, vault] gates), the
// pure detector (no capability), and the capture settlement under the
// CaptureSaveOperation ([vault, content] gates — the capture operation needs
// the content gate, so this builder takes four gates). The operations are
// built once here from the wired stores (composition root for this domain);
// the handlers carry the wired flags that reproduce the old dispatchers'
// unwired answers.
func (s *WSServer) secretSpecs(lane control.Admission, configGate, vaultGate, contentGate control.Admission) []methodSpec {
	secretOp := capability.NewSecretOperation(configGate, vaultGate, lane, s.profiles, s.groups, s.vaultLifecycle, s.credentials)
	captureOp := capability.NewCaptureSaveOperation(vaultGate, contentGate, lane, s.vaultLifecycle, s.contentDB)
	vaultWired := s.vaultLifecycle != nil
	configWired := s.profiles != nil && s.groups != nil
	storeWired := s.credentials != nil
	contentWired := s.contentDB != nil
	secretSub := s.operationQueue("secrets")
	captureSub := s.operationQueue("capture")
	return []methodSpec{
		regResponder(secretSub, "secrets.usage", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := secretsHandlers{op: secretOp, r: r, vaultWired: vaultWired, configWired: configWired, storeWired: storeWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleUsage(ctx, req) }
		}),
		regResponder(secretSub, "secrets.savePassword", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := secretsHandlers{op: secretOp, r: r, vaultWired: vaultWired, configWired: configWired, storeWired: storeWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMint(ctx, req) }
		}),
		regResponder(secretSub, "secrets.saveKeyMaterial", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := secretsHandlers{op: secretOp, r: r, vaultWired: vaultWired, configWired: configWired, storeWired: storeWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMint(ctx, req) }
		}),
		regResponder(secretSub, "secrets.saveKeyPassphrase", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := secretsHandlers{op: secretOp, r: r, vaultWired: vaultWired, configWired: configWired, storeWired: storeWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleMint(ctx, req) }
		}),
		regResponder(s.lane, "secrets.detect", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := secretsDetectHandlers{log: s.log, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleDetect(req) }
		}),
		regResponder(captureSub, "secrets.captureSave", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := captureSaveHandlers{op: captureOp, captures: s.captures, r: r, vaultWired: vaultWired, contentWired: contentWired}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleCaptureSave(ctx, req) }
		}),
		regResponder(s.lane, "secrets.captureDismiss", genericObject("per-field validation pending nocx-VALID"), func(r Responder) handlerFunc {
			h := captureDismissHandlers{captures: s.captures, r: r}
			return func(ctx context.Context, req jsonrpcRequest) { h.handleCaptureDismiss(ctx, req) }
		}),
	}
}
