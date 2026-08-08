package transport

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/transport/control"
)

// ── control.saturated error data contract ──────────────────────────────

// The DTO's own conformance: the error envelope carries the fixed code and
// message, and its data payload satisfies the schema — exact key set
// (additionalProperties: false) and explicit required list. Reason is the
// fixed literal, never the rejection's free text; scope is the rejection's
// admission name, server vocabulary by construction.
func TestControlSaturated_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "control.saturated.schema.json")

	cases := map[string]struct {
		retryAfter time.Duration
		wantMs     int64
	}{
		"with a retry hint":    {retryAfter: 250 * time.Millisecond, wantMs: 250},
		"no retry hint":        {retryAfter: 0, wantMs: 0},
		"sub-millisecond hint": {retryAfter: 500 * time.Microsecond, wantMs: 0},
		"whole-second hint":    {retryAfter: 2 * time.Second, wantMs: 2000},
		// The struct carries no non-negative invariant; a negative hint is
		// clamped so the payload never violates the schema's minimum 0.
		"negative hint clamped": {retryAfter: -1 * time.Second, wantMs: 0},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := saturationErrorFor(&control.Rejection{
				Reason:     "capacity exhausted",
				Scope:      "exec",
				RetryAfter: c.retryAfter,
			})
			if err.Code != SaturationErrorCode {
				t.Errorf("code = %d, want %d", err.Code, SaturationErrorCode)
			}
			if err.Message != SaturationMessage {
				t.Errorf("message = %q, want %q", err.Message, SaturationMessage)
			}
			if err.Data.Reason != "control-saturated" {
				t.Errorf("data.reason = %q, want the fixed literal control-saturated", err.Data.Reason)
			}
			if err.Data.Scope != "exec" {
				t.Errorf("data.scope = %q, want the rejection's admission name exec", err.Data.Scope)
			}
			if !err.Data.Retryable {
				t.Error("data.retryable = false; saturation is transient and must be retryable")
			}
			if err.Data.RetryAfterMs != c.wantMs {
				t.Errorf("data.retryAfterMs = %d, want %d", err.Data.RetryAfterMs, c.wantMs)
			}
			raw, marshalErr := json.Marshal(err.Data)
			if marshalErr != nil {
				t.Fatalf("marshal: %v", marshalErr)
			}
			validateJSON(t, schema, raw, "control.saturated error data DTO")
		})
	}
}

// The reason on the wire is FIXED vocabulary. A rejection's Reason is free
// server text; if an admission ever built its rejection from request data,
// none of that text may survive into the payload — only the admission's
// name (scope, server-defined) and the retry hint do.
func TestSaturationError_NormalizesReasonToFixedVocabulary(t *testing.T) {
	secret := "s3cret-request-value"
	rej := &control.Rejection{
		Reason:     secret, // as if an admission echoed request text into the rejection
		Scope:      "exec",
		RetryAfter: 250 * time.Millisecond,
	}
	raw, err := json.Marshal(saturationErrorFor(rej))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), secret) {
		t.Fatalf("wire error carried the rejection's free-text reason %q: %s", secret, raw)
	}
	var got struct {
		Data saturationData `json:"data"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Data.Reason != "control-saturated" {
		t.Errorf("data.reason = %q, want control-saturated", got.Data.Reason)
	}
}

// The transport-wide rule: any control frame may carry a secret, so none are
// echoed verbatim. The mapper takes ONLY the *control.Rejection — a request
// parameter is structurally unable to reach the wire. Drive a request that
// carried a secret-looking parameter through the refusal and assert no trace
// of it survives in the error.
func TestSaturationError_DataNeverCarriesRequestParams(t *testing.T) {
	secret := "s3cret-host-token"
	// The request the renderer sent, refused by the saturated executor.
	reqParams := map[string]any{"host": secret, "password": "hunter2"}
	// The admission's rejection knows nothing of the request — only its own
	// resource name and the retry hint. This is the shape the real executor
	// produces; the mapper's signature is what makes the property hold.
	rej := &control.Rejection{Reason: "capacity exhausted", Scope: "exec", RetryAfter: 250 * time.Millisecond}

	raw, err := json.Marshal(saturationErrorFor(rej))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, v := range reqParams {
		s, ok := v.(string)
		if !ok {
			continue
		}
		if strings.Contains(string(raw), s) {
			t.Fatalf("wire error echoed request parameter %q: %s", s, raw)
		}
	}
}

// ── control.saturated notification params contract ─────────────────────

// The notification is server→client, so there is no result shape — the
// params ARE the contract, exactly as vault.unlockRequest's are. methodClass
// is the server's coarse class, scope the admission's name; the builder takes
// no request data, so the notification can carry neither a method's params
// nor the raw method.
func TestControlSaturatedNotification_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "control.saturated.notification.schema.json")
	params := saturatedNotificationParamsFor("ssh", "exec")
	if params.MethodClass != "ssh" {
		t.Errorf("methodClass = %q, want ssh", params.MethodClass)
	}
	if params.Scope != "exec" {
		t.Errorf("scope = %q, want exec", params.Scope)
	}
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	validateJSON(t, schema, raw, "control.saturated notification params DTO")
}

// The same no-echo rule as the error payload: a request that carried a
// secret-looking value must leave no trace in the notification.
func TestSaturatedNotification_DataNeverCarriesRequestParams(t *testing.T) {
	secret := "s3cret-request-value"
	raw, err := json.Marshal(saturatedNotificationParamsFor("ssh", "exec"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), secret) {
		t.Fatalf("notification carried request-derived text %q: %s", secret, raw)
	}
}
