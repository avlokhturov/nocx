// Package assistant is the AI assistant's model access, behind one
// interface (ADR-0028, design §4). eino runs the loop; this package is the
// one owner of the eino wiring, the guarded HTTP client and the probe — the
// rest of the app depends on Client, never on eino types, and nothing in
// the product reads eino's state to answer a question the ledger answers
// (ADR-0019).
//
// The engine is adk.ChatModelAgent with the OpenAI-compatible adapter
// (ADR-0028 decision 1; design §4.1). Explain mode is the ONLY mode this
// slice knows: zero tools declared, terminate after the first completed
// response, context is question + referenced frames (design §4.2). The
// tools, the policy middleware, the grant and the narrowed capability are
// nocx-lndv and deliberately do not live here.
//
// The HTTP client every model call goes through enforces design §4.5
// decision 3 at dial time — see httpguard.go for the rule and the four
// reasons it cannot live in the form.
package assistant

import (
	"context"
	"net/http"
	"time"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
)

// Client is the app-facing surface of the assistant engine. The only
// consumer today is the endpoint form's Test button (nocx-edio); the ask
// transaction (nocx-f4s5) will call the same seam when it lands.
type Client interface {
	// Probe streams one real response from the given endpoint configuration
	// — the Test button's whole meaning: it probes what will actually be
	// used, not one cheap completion (design §4.5, bead notes). The
	// parameters are the form's DRAFT values: the endpoint may not be saved
	// yet, and the key is an input that never crosses back (ADR-0030).
	//
	// A failed dial, a refused stream, a timeout or zero content is a
	// ProbeResult with OK=false — a probe outcome, not a Go error. A Go
	// error means the probe could not run at all (a parameter the engine
	// refuses), and no result is produced.
	Probe(ctx context.Context, p ProbeParams) (ProbeResult, error)
}

// ProbeParams is the draft endpoint configuration the Test button probes:
// what the form shows, not what the store holds.
type ProbeParams struct {
	// Name is the display name (draft). Reported in the result for the
	// "last probe" fact; not sent to the model.
	Name string
	// BaseURL is the absolute http(s) base URL of the OpenAI-compatible
	// API. The http:// address rule is enforced at dial time, never here.
	BaseURL string
	// Key is the API key input, empty when the form has none (local models
	// like Ollama need none). Never persisted, never echoed.
	Key credential.Secret
	// Model is the model id the probe asks to speak. The form tests its
	// first model; the result reports which one was probed.
	Model string
}

// ProbeResult is the outcome of one probe. It is the wire shape declared in
// contracts/endpoints.probe.schema.json ($defs/probeResult) and reused by
// agent.status's lastProbe — the Go DTO lives here so the transport maps
// to it directly.
type ProbeResult struct {
	// EndpointName is the probed draft's display name. Historical fact:
	// agent.status reports the last probe whatever the endpoint list says
	// now.
	EndpointName string `json:"name"`
	// Model is the model id that was probed.
	Model string `json:"model"`
	// OK is true when the probe streamed at least one content chunk.
	OK bool `json:"ok"`
	// Error describes what went wrong when OK is false: the dial failure,
	// the HTTP status, the refused stream, zero content. Empty when OK.
	Error string `json:"error,omitempty"`
	// ElapsedMS is the total wall time of the probe, from dial to the end
	// of the stream.
	ElapsedMS int64 `json:"elapsedMs"`
	// At is when the probe finished, wall-clock (the renderer shows it as
	// "2m ago"; a monotonic clock would render as 1970 — wall-clock-vs-
	// monotonic-persistence).
	At time.Time `json:"at"`
}

// NewClient builds the engine client: eino's openai adapter over the
// guarded HTTP client (httpguard.go). Cheap; nothing dials until Probe.
func NewClient(logger log.Logger) Client {
	return &client{log: logger, http: newGuardedHTTPClient(logger)}
}

type client struct {
	log  log.Logger
	http *http.Client
}
