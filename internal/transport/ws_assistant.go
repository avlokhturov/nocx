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
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/shady2k/nocx/internal/assistant"
	"github.com/shady2k/nocx/internal/capability"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/profile"
)

// agentStatusResult is the agent.status wire shape, pinned by
// contracts/agent.status.schema.json. lastProbe is required on the wire and
// null when none has run — a nil pointer marshals to null.
type agentStatusResult struct {
	EndpointConfigured   bool                   `json:"endpointConfigured"`
	CredentialResolvable bool                   `json:"credentialResolvable"`
	LastProbe            *assistant.ProbeResult `json:"lastProbe"`
}

// endpointProbeParams are the form's DRAFT values (design §4.5) plus the
// endpoint id when the form is editing a SAVED endpoint. The key is an
// input that rides the params once and never crosses back (ADR-0030).
// Params are not contracted (contracts/README.md) — the handler validates
// what it parses.
//
// The credential resolution rule, in code:
//
//  1. A non-empty key WINS — the user typed a key to test it before saving
//     it (the other half of what this button is for), so the stored
//     credential must not be consulted at all. The other order would
//     silently test the credential the user is actively replacing.
//  2. Else, endpointId names the record and the BACKEND resolves the
//     credential that record owns — exactly how connections.test resolves
//     a profile by its id (the renderer never re-fetches the material,
//     which ADR-0030 forbids crossing back). A sealed or unavailable vault
//     is a probe RESULT naming that, never a Go error and never a
//     no-key dial (which would 401 and lie about a working endpoint).
//  3. Else (no key, no id, or a saved endpoint with no credential) the
//     probe runs without one — the local-model case.
//
// The baseUrl and model stay the form's: the button sits on the form, so
// the form's target is what is tested; only the credential is resolved.
type endpointProbeParams struct {
	Name       string `json:"name"`
	BaseURL    string `json:"baseUrl"`
	Key        string `json:"key"`
	Model      string `json:"model"`
	EndpointID string `json:"endpointId"`
}

// assistantStatusHandlers answers agent.status. wired is true when the endpoint
// repository is wired; without it the method refuses with -32601, the same
// shape profiles and groups use.
type assistantStatusHandlers struct {
	op      capability.ConfigOperation
	secrets credential.SecretStore
	probes  *assistant.ProbeStore
	wired   bool
	r       Responder
}

func (h assistantStatusHandlers) handleAgentStatus(ctx context.Context, req jsonrpcRequest) {
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
func (h assistantStatusHandlers) credentialResolvableFor(ctx context.Context, ref string) bool {
	if ref == "" || h.secrets == nil {
		return false
	}
	secret, err := h.secrets.Get(ctx, credential.SecretID(ref))
	if err != nil {
		return false
	}
	return !secret.IsEmpty()
}

// assistantProbeHandlers answers endpoints.probe: probe the form's draft
// values with the engine the ask transaction will use, record the outcome,
// and return it. wired is true when the assistant client is present;
// without it the method refuses with -32601. The op and secrets seams are
// the credential resolution (the endpointId path): the op names the
// record, the secret store resolves the material — the same two seams
// agent.status holds, and the same split the ask path uses (record under
// the config operation, material at stream time).
type assistantProbeHandlers struct {
	op      capability.ConfigOperation
	secrets credential.SecretStore
	client  assistant.Client
	probes  *assistant.ProbeStore
	wired   bool
	r       Responder
}

func (h assistantProbeHandlers) handleEndpointProbe(ctx context.Context, req jsonrpcRequest) {
	if !h.wired {
		_ = h.r.TryError(req.ID, RPCError{Code: -32601, Message: "agent not available"})
		return
	}
	var params endpointProbeParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params"})
		return
	}
	if msg := validateProbeParams(params); msg != "" {
		_ = h.r.TryError(req.ID, RPCError{Code: -32602, Message: "Invalid params: " + msg})
		return
	}

	key, refused, resolveErr := h.resolveProbeCredential(ctx, params)
	if resolveErr != nil {
		// The renderer named a record that does not exist (deleted
		// meanwhile): a caller error, exactly as connections.test surfaces
		// a profile that does not resolve — never a fabricated verdict.
		_ = h.r.TryError(req.ID, RPCError{Code: -32603, Message: resolveErr.Error()})
		return
	}
	if refused != nil {
		// A sealed or unavailable vault is a probe RESULT naming that —
		// the Test button that hangs or lies is the thing being fixed, and
		// a Go error here would be a second kind of lie. Recorded like any
		// other outcome, so agent.status reports it.
		if h.probes != nil {
			h.probes.Record(*refused)
		}
		_ = h.r.TryResult(req.ID, mustMarshal(*refused))
		return
	}

	res, err := h.client.Probe(ctx, assistant.ProbeParams{
		Name:    params.Name,
		BaseURL: params.BaseURL,
		Key:     key,
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

// resolveProbeCredential applies the endpoints.probe resolution rule (the
// params comment carries the rule and the rejected alternative):
//
//  1. A non-empty typed key wins — no vault read, no record lookup.
//  2. Else, endpointId names the record; its OWN credential is resolved
//     from the vault. Unavailable (sealed vault, deleted secret, missing
func (h assistantProbeHandlers) resolveProbeCredential(ctx context.Context, params endpointProbeParams) (credential.Secret, *assistant.ProbeResult, error) {
	typed := credential.NewSecret(params.Key)
	if !typed.IsEmpty() {
		return typed, nil, nil
	}
	if params.EndpointID == "" {
		return credential.Secret{}, nil, nil
	}

	var ref string
	err := h.op.Run(ctx, func(ctx context.Context, svc capability.ConfigService) error {
		ep, err := svc.GetEndpoint(params.EndpointID)
		if err != nil {
			return err
		}
		ref = ep.CredentialRef
		return nil
	})
	if err != nil {
		return credential.Secret{}, nil, err
	}
	if ref == "" {
		// The endpoint honestly has no credential (created without one, or
		// its key was deleted on the Secrets page): probe without one.
		return credential.Secret{}, nil, nil
	}
	if h.secrets == nil {
		// No store to resolve with: the same refused result as a sealed
		// vault — the probe must not dial without the credential.
		return credential.Secret{}, refusedProbeResult(params), nil
	}
	secret, err := h.secrets.Get(ctx, credential.SecretID(ref))
	if err != nil || secret.IsEmpty() {
		return credential.Secret{}, refusedProbeResult(params), nil
	}
	return secret, nil, nil
}

// ── endpoints.probe ingress bounds ────────────────────────────────────────
//
// Every one of these params is renderer-supplied and reaches something real:
// the base URL is dialled, the model goes into the request body, and the key
// goes into an HTTP header. Before nocx-q27y this method checked only that
// the base URL was non-empty — the thinnest ingress in the assistant surface,
// and the one that had grown a second reachable shape.
const (
	// maxProbeNameRunes bounds the display name, which is only echoed back
	// in the result and stored as the "last probe" fact.
	maxProbeNameRunes = 200
	// maxProbeURLRunes bounds the base URL. Far above any real endpoint;
	// this is a wire-cost bound, not a naming rule.
	maxProbeURLRunes = 2_000
	// maxProbeModelRunes bounds the model id.
	maxProbeModelRunes = 200
	// maxProbeKeyRunes bounds the API key. Generous — some providers issue
	// long JWTs — and still a bound.
	maxProbeKeyRunes = 8_000
	// maxProbeIDRunes bounds the renderer-supplied endpoint id, matching the
	// ask path's maxIDRunes.
	maxProbeIDRunes = 128
)

// validateProbeParamsRaw is the registered validator (registration.go): it
// decodes the params and applies validateProbeParams, so the handler is never
// entered with anything it would have had to check itself. The exemplar for
// converting a method off genericObject — decode, then check every reachable
// field.
func validateProbeParamsRaw(raw json.RawMessage) string {
	var p endpointProbeParams
	if len(raw) == 0 {
		return "params are required"
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return "params must be a JSON object"
	}
	return validateProbeParams(p)
}

// validateProbeParams checks every reachable endpoints.probe param, returning
// a non-empty message on the first failure. Returns "" when the params are
// acceptable.
//
// An absent model is NOT a missing parameter: it is the other question — "can
// I reach this API with this key" — which needs no model and is the only one
// askable of an endpoint nobody has typed a model into yet (nocx-q27y). The
// engine routes on it and the result names which check ran.
func validateProbeParams(p endpointProbeParams) string {
	if p.BaseURL == "" {
		return "baseUrl is required"
	}
	if n := utf8.RuneCountInString(p.BaseURL); n > maxProbeURLRunes {
		return fmt.Sprintf("baseUrl exceeds %d characters", maxProbeURLRunes)
	}
	// The SAME parse-level rule a stored endpoint is held to
	// (profile.ValidateBaseURL) — one owner, so a URL refused at save time
	// cannot be silently dialled at test time. The address policy proper
	// stays at dial time (internal/assistant/httpguard.go), where it can be
	// enforced against the address actually connected.
	if err := profile.ValidateBaseURL(p.BaseURL); err != nil {
		return err.Error()
	}
	if utf8.RuneCountInString(p.Name) > maxProbeNameRunes {
		return fmt.Sprintf("name exceeds %d characters", maxProbeNameRunes)
	}
	if utf8.RuneCountInString(p.Model) > maxProbeModelRunes {
		return fmt.Sprintf("model exceeds %d characters", maxProbeModelRunes)
	}
	if utf8.RuneCountInString(p.Key) > maxProbeKeyRunes {
		return fmt.Sprintf("key exceeds %d characters", maxProbeKeyRunes)
	}
	if utf8.RuneCountInString(p.EndpointID) > maxProbeIDRunes {
		return fmt.Sprintf("endpointId exceeds %d characters", maxProbeIDRunes)
	}
	// The key becomes an Authorization header and the model becomes part of
	// a request body. A control character in either is never legitimate, and
	// refusing it here means the header writer never has to be the last line
	// of defence against a newline in a credential.
	if hasControlChars(p.Key) {
		return "key must not contain control characters"
	}
	if hasControlChars(p.Model) {
		return "model must not contain control characters"
	}
	return ""
}

// hasControlChars reports whether s contains any C0/C1 control character or
// DEL. Tabs and newlines are control characters too, and neither belongs in
// a credential, a model id or a URL.
func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return true
		}
	}
	return false
}

// refusedProbeResult is the sealed-or-unavailable-vault probe verdict: a
// probe RESULT naming the state, never a Go error and never a no-key dial
// (which would 401 and lie about a working endpoint). The sentence matches
// the ask path's terminalize (ws_agent.go) — one owner of "the vault is
// unavailable" for a named credential.
func refusedProbeResult(params endpointProbeParams) *assistant.ProbeResult {
	kind := assistant.ProbeModel
	if params.Model == "" {
		kind = assistant.ProbeConnection
	}
	return &assistant.ProbeResult{
		EndpointName: params.Name,
		Model:        params.Model,
		Kind:         kind,
		OK:           false,
		Error:        "the endpoint's credential is unavailable — unlock the vault",
		At:           time.Now(),
	}
}
