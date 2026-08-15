package transport

// The endpoint-config handlers as constructed types (design §4.5.4,
// ADR-0030): each handler holds a ConfigOperation (gates [config, vault]
// — the key-bearing write paths mint and rotate through the vault) plus
// the Responder. Never the *WSServer: a handler constructed with the
// operation cannot reach a store it was not given.
//
// The pure wire helpers (wireEndpoint, wireEndpoints) stay here: they map
// the stored credential reference to the renderer's row handle (vault.RowFor)
// and touch no store, exactly like wireProfile.
//
// The API key is an INPUT only: it rides the create/update params once,
// is minted or rotated by the service, and never survives a result, a
// log line or the persisted record (credential.Secret redacts in every
// fmt/slog path).

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/vault"
)

// endpointHandlers answers the endpoints.* methods. wired is true when the
// endpoint repository is wired; the old-style refusal without it is
// -32601 "endpoints not available", the same shape profiles and groups
// use.
type endpointHandlers struct {
	op    capability.ConfigOperation
	wired bool
	r     Responder
}

func (h endpointHandlers) handleMethod(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "endpoints not available"})
		return
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		switch req.Method {
		case "endpoints.list":
			eps, err := svc.ListEndpoints()
			if err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
				return nil
			}
			// Secret references stay backend-owned: hand the renderer row
			// handles (ADR-0017 §1).
			_ = h.r.TryResult(req.ID, mustMarshal(endpointsListResponse{Endpoints: wireEndpoints(eps)}))
		case "endpoints.create":
			var params endpointCreateParams
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			e := params.toEndpoint()
			// Mint an ID when the renderer sends none, exactly like
			// profiles.create.
			if e.ID == "" {
				e.ID = profile.NewEndpointID(e.Name)
			}
			var key credential.Secret
			if params.Key != "" {
				key = credential.NewSecret(params.Key)
			}
			created, err := svc.CreateEndpoint(ctx, e, key)
			if err != nil {
				// rpcErrorFor keeps the endpoint conflict codes (-32602) and
				// attaches the vault's reason when the mint failed because the
				// vault needs setup or is sealed: without data.reason the
				// renderer's operation-first wrapper (saveSecretWithVault) and
				// the dispatcher's sealed interception cannot tell the vault
				// from a disk error, so the setup/unlock sheet never opens and
				// the save dies in a toast (nocx-4egm, the shape of nocx-25k9.7).
				_ = h.r.TryError(req.ID, rpcErrorFor(endpointMethodErrorCode(err), "", err))
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(endpointResultResponse{Endpoint: wireEndpoint(created)}))
		case "endpoints.update":
			var params endpointUpdateParams
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if params.ID == "" {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "id required"})
				return nil
			}
			e := params.toEndpoint()
			// "Absent or empty key" keeps the existing material (design
			// §4.5.4); a non-empty one rotates or mints.
			var key *credential.Secret
			if params.Key != "" {
				sk := credential.NewSecret(params.Key)
				key = &sk
			}
			updated, err := svc.UpdateEndpoint(ctx, e, key)
			if err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(endpointMethodErrorCode(err), "", err))
				return nil
			}
			_ = h.r.TryResult(req.ID, mustMarshal(endpointResultResponse{Endpoint: wireEndpoint(updated)}))
		case "endpoints.delete":
			var params struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
				return nil
			}
			if err := svc.DeleteEndpoint(ctx, params.ID); err != nil {
				_ = h.r.TryError(req.ID, rpcErrorFor(-32603, "", err))
				return nil
			}
			// Nothing to return; the list is the state (like
			// vault.deleteSecret's empty result).
			_ = h.r.TryResult(req.ID, mustMarshal(struct{}{}))
		}
		return nil
	})
	if err != nil {
		answerOperationRefusal(h.r, req.ID, err)
	}
}

// endpointMethodErrorCode maps the endpoint store's sentinel errors to
// transport codes, mirroring profileMethodErrorCode: an existing or missing
// record is a conflict/not-found (-32602 family), everything else internal.
func endpointMethodErrorCode(err error) int {
	switch {
	case errors.Is(err, profile.ErrEndpointExists),
		errors.Is(err, profile.ErrEndpointNotFound):
		return -32602
	default:
		return -32603
	}
}

// endpointModelInput is the wire form of one model in create/update params.
type endpointModelInput struct {
	Name  string  `json:"name"`
	Alias *string `json:"alias"`
}

type endpointCreateParams struct {
	Name    string                 `json:"name"`
	BaseURL string                 `json:"baseUrl"`
	Schema  profile.EndpointSchema `json:"schema"`
	Key     string                 `json:"key"`
	Models  []endpointModelInput   `json:"models"`
}

// resolveEndpointSchema completes a schema the wire params omitted. The
// backend owns an endpoint's schema until the form grows a control for it
// (design §4.5, decision 2): today there is exactly ONE legal dialect, and
// a renderer that sent "openai-compatible" would be stating a fact it
// never decided — the form has no control that chose it. The moment a
// second dialect exists, that constant and the backend's validation would
// become two owners of one value that must change in lockstep (AD-8),
// arriving on a schedule. So the value is completed here, at the wire seam
// that maps params to records, and the renderer-side alternative is
// rejected because a constant nobody chose is not a fact. When a
// dialect select lands, the renderer starts sending a value a person
// actually picked, and this default comes out.
func resolveEndpointSchema(s profile.EndpointSchema) profile.EndpointSchema {
	if s == "" {
		return profile.EndpointSchemaOpenAICompatible
	}
	return s
}

func (p endpointCreateParams) toEndpoint() profile.Endpoint {
	return profile.Endpoint{
		Name:    p.Name,
		BaseURL: p.BaseURL,
		Schema:  resolveEndpointSchema(p.Schema),
		Models:  wireModelsToStored(p.Models),
	}
}

// endpointUpdateParams is the full-replace update: same fields as create,
// plus the id. key is optional and empty means "keep the existing
// material" (design §4.5.4).
type endpointUpdateParams struct {
	ID      string                 `json:"id"`
	Name    string                 `json:"name"`
	BaseURL string                 `json:"baseUrl"`
	Schema  profile.EndpointSchema `json:"schema"`
	Key     string                 `json:"key"`
	Models  []endpointModelInput   `json:"models"`
}

func (p endpointUpdateParams) toEndpoint() profile.Endpoint {
	return profile.Endpoint{
		ID:      p.ID,
		Name:    p.Name,
		BaseURL: p.BaseURL,
		Schema:  resolveEndpointSchema(p.Schema),
		Models:  wireModelsToStored(p.Models),
	}
}

func wireModelsToStored(in []endpointModelInput) []profile.EndpointModel {
	if in == nil {
		return nil
	}
	out := make([]profile.EndpointModel, len(in))
	for i, m := range in {
		out[i] = profile.EndpointModel{Name: m.Name, Alias: m.Alias}
	}
	return out
}

// Wire result shapes. Both are pinned by contracts/endpoints.*.schema.json
// and the renderer's types are generated from those files, so a field added
// here that is not added there fails the contract test rather than reaching
// a renderer that cannot see it.
type endpointsListResponse struct {
	Endpoints []profile.EndpointDTO `json:"endpoints"`
}

type endpointResultResponse struct {
	Endpoint profile.EndpointDTO `json:"endpoint"`
}

// wireEndpoint maps a stored endpoint to its wire form: the credential
// reference becomes the renderer's row handle, or null when no key is set.
// The reference never crosses the wire (ADR-0017 §1).
func wireEndpoint(e profile.Endpoint) profile.EndpointDTO {
	dto := profile.EndpointDTO{
		ID:      e.ID,
		Name:    e.Name,
		BaseURL: e.BaseURL,
		Schema:  e.Schema,
		Models:  make([]profile.EndpointModelDTO, 0, len(e.Models)),
	}
	for _, m := range e.Models {
		dto.Models = append(dto.Models, profile.EndpointModelDTO(m))
	}
	if e.CredentialRef != "" {
		row := vault.RowFor(credential.SecretID(e.CredentialRef))
		dto.Credential = &row
	}
	return dto
}

// wireEndpoints maps a stored list to its wire form. Never null: an empty
// list is [] — the contract declares an array and a null there has cost
// this project a defect once already (nocx-25k9.14).
func wireEndpoints(eps []profile.Endpoint) []profile.EndpointDTO {
	if eps == nil {
		return []profile.EndpointDTO{}
	}
	out := make([]profile.EndpointDTO, len(eps))
	for i := range eps {
		out[i] = wireEndpoint(eps[i])
	}
	return out
}
