package transport

// The assistant's control-plane methods as constructed types (design §7,
// nocx-edio): agent.status and endpoints.probe. Each handler holds only its
// seams — the config operation (endpoint list), the credential store
// (credential resolvability), the assistant client (the probe) and the
// probe store (the last-probe fact) — plus its Responder; never the
// *WSServer, so a handler cannot reach a store it was not constructed with.
//
// The ask transaction (agent.ask, agent.cancel, agent.approve, the run
// state machine, the ledger writes) is nocx-f4s5 and deliberately does not
// live here.

import (
	"context"
	"encoding/json"

	"github.com/shady2k/nocx/internal/assistant"
	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
)

// agentStatusResult is the agent.status wire shape, pinned by
// contracts/agent.status.schema.json. lastProbe is required on the wire and
// null when none has run — a nil pointer marshals to null.
type agentStatusResult struct {
	EndpointConfigured   bool                   `json:"endpointConfigured"`
	CredentialResolvable bool                   `json:"credentialResolvable"`
	LastProbe            *assistant.ProbeResult `json:"lastProbe"`
}

// endpointProbeParams are the form's DRAFT values (design §4.5): the
// endpoint may not be saved yet, and the key is an input that rides the
// params once and never crosses back (ADR-0030). Params are not contracted
// (contracts/README.md) — the handler validates what it parses.
type endpointProbeParams struct {
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	Key     string `json:"key"`
	Model   string `json:"model"`
}

// agentHandlers answers agent.status. wired is true when the endpoint
// repository is wired; without it the method refuses with -32601, the same
// shape profiles and groups use.
type agentHandlers struct {
	op      capability.ConfigOperation
	secrets credential.SecretStore
	probes  *assistant.ProbeStore
	wired   bool
	r       Responder
}

func (h agentHandlers) handleAgentStatus(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "agent not available"})
		return
	}
	res := agentStatusResult{LastProbe: nil}
	if h.probes != nil {
		res.LastProbe = h.probes.Last()
	}
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		eps, err := svc.ListEndpoints()
		if err != nil {
			return err
		}
		res.EndpointConfigured = len(eps) > 0
		for _, ep := range eps {
			if h.credentialResolvableFor(ctx, ep.CredentialRef) {
				res.CredentialResolvable = true
				break
			}
		}
		return nil
	})
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	_ = h.r.TryResult(req.ID, mustMarshal(res))
}

// credentialResolvableFor answers whether the vault can currently resolve
// ref: the secret exists and is readable. A sealed vault, a deleted secret
// or a missing key all answer false — the product says so instead of
// offering an ask that cannot authenticate.
func (h agentHandlers) credentialResolvableFor(ctx context.Context, ref string) bool {
	if ref == "" || h.secrets == nil {
		return false
	}
	secret, err := h.secrets.Get(ctx, credential.SecretID(ref))
	if err != nil {
		return false
	}
	return !secret.IsEmpty()
}

// assistantHandlers answers endpoints.probe: probe the form's draft values
// with the engine the ask transaction will use, record the outcome, and
// return it. wired is true when the assistant client is present; without it
// the method refuses with -32601.
type assistantHandlers struct {
	client assistant.Client
	probes *assistant.ProbeStore
	wired  bool
	r      Responder
}

func (h assistantHandlers) handleEndpointProbe(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "agent not available"})
		return
	}
	var params endpointProbeParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if params.BaseURL == "" || params.Model == "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: baseUrl and model are required"})
		return
	}

	res, err := h.client.Probe(ctx, assistant.ProbeParams{
		Name:    params.Name,
		BaseURL: params.BaseURL,
		Key:     credential.NewSecret(params.Key),
		Model:   params.Model,
	})
	if err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: err.Error()})
		return
	}
	if h.probes != nil {
		h.probes.Record(res)
	}
	_ = h.r.TryResult(req.ID, mustMarshal(res))
}
