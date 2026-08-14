package profile

import (
	"fmt"
	"net/url"
	"strings"
)

// EndpointSchema is the wire-schema vocabulary of an AI endpoint (design
// §4.5, decision 2). The field is on the record because a schema cannot be
// inferred from a base URL; the set is closed and grows by addition — the
// UI's select appears when the second value does, never before.
type EndpointSchema string

const (
	// EndpointSchemaOpenAICompatible is the ONE schema this pass knows: the
	// chat-completions protocol the eino openai adapter speaks (design
	// §4.5; "OpenAI-compatible" is not one protocol — risk 6 — but this
	// pass implements exactly one and says so).
	EndpointSchemaOpenAICompatible EndpointSchema = "openai-compatible"
)

// validEndpointSchema reports whether v is a value this build recognises.
// An unrecognised stored value is a validation error at write time — there
// is no resolution layer for endpoints to fall back on, so the record must
// never hold a schema nobody can speak.
func validEndpointSchema(v EndpointSchema) bool {
	return v == EndpointSchemaOpenAICompatible
}

// EndpointModel is one model an endpoint offers: the model id the API
// understands, plus an optional alias the picker shows instead of the id.
// Alias is nil when the picker should show Name.
type EndpointModel struct {
	Name  string  `json:"name"`
	Alias *string `json:"alias,omitempty"`
}

// Endpoint is an AI model endpoint (design §4.5, ADR-0030): a display
// name, a base URL, a wire schema, ONE credential and one or more models.
//
// CredentialRef is the endpoint's OWN secret: the API key the user gave at
// create/update time, minted into the vault. It is a BACKEND-OWNED
// reference (sec:v1:...) — on the wire the transport replaces it with the
// renderer's row handle, exactly like profile secret bindings (ADR-0017
// §1), so a reference never crosses the boundary. Empty means no key is
// set: the endpoint was created without one, or the key was deleted on the
// Secrets page (ClearSecretRefs), and agent.status then reports the
// credential unresolvable.
type Endpoint struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	BaseURL       string          `json:"baseUrl"`
	Schema        EndpointSchema  `json:"schema"`
	CredentialRef string          `json:"credentialRef"`
	Models        []EndpointModel `json:"models"`
}

// ValidateEndpoint checks an endpoint record before it is stored.
//
// Base-URL validation is parse-level only this pass: any absolute http(s)
// URL is accepted. The loopback/private address policy, redirect
// re-checking and proxy handling belong to nocx-edio, where the HTTP
// client that could enforce them lands (design §4.5) — a rule with no
// enforcement point would be theatre. What IS checked here is shape, not
// policy: a URL that is not an absolute http(s) URL cannot be a base URL,
// and userinfo in the URL is rejected because credentials belong in the
// credential field, never in the address.
func ValidateEndpoint(e Endpoint) error {
	if strings.TrimSpace(e.Name) == "" {
		return fmt.Errorf("endpoint name is required")
	}
	if !validEndpointSchema(e.Schema) {
		return fmt.Errorf("unknown endpoint schema %q", e.Schema)
	}
	u, err := url.Parse(e.BaseURL)
	if err != nil {
		return fmt.Errorf("invalid base URL %q: %v", e.BaseURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("base URL scheme must be http or https, got %q", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("base URL must name a host")
	}
	if u.User != nil {
		return fmt.Errorf("base URL must not carry credentials; put the API key in the credential field")
	}
	if len(e.Models) == 0 {
		return fmt.Errorf("endpoint requires at least one model")
	}
	for _, m := range e.Models {
		if strings.TrimSpace(m.Name) == "" {
			return fmt.Errorf("model name is required")
		}
	}
	return nil
}

// NewEndpointID mints a namespaced endpoint id: "endpoint:custom:slug:uuid".
//
// Ids are minted here rather than in the renderer for the same reason
// profile ids are: an id is identity, and a display layer that invents one
// has to know the uniqueness rule the store enforces.
func NewEndpointID(name string) string {
	return "endpoint:custom:" + slugify(name) + ":" + newUUID()
}

// EndpointDTO is the wire form of an endpoint (design §4.5.4): the stored
// record with CredentialRef mapped to the renderer's row handle (or null
// when no key is set). The reference itself never crosses the wire — the
// transport does the mapping (vault.RowFor), the way wireProfile does for
// profiles.
type EndpointDTO struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	BaseURL    string             `json:"baseUrl"`
	Schema     EndpointSchema     `json:"schema"`
	Credential *string            `json:"credential"`
	Models     []EndpointModelDTO `json:"models"`
}

// EndpointModelDTO is the wire form of one model. Alias is required on the
// wire and null when absent — the contract declares nullable fields
// explicitly (["string","null"]), never by omission.
type EndpointModelDTO struct {
	Name  string  `json:"name"`
	Alias *string `json:"alias"`
}
