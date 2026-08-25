package assistant

import (
	"errors"
	"fmt"
	"net/http"

	einoopenai "github.com/cloudwego/eino-ext/components/model/openai"
	openai "github.com/meguminnnnnnnnn/go-openai"
)

// UnexplainedFailureSentence is what a person reads when nothing below could
// name the cause. It says "the log" because the log is where the framework's
// own text was kept, once, at the boundary that caught it (nocx-avogl.3).
//
// It lives here rather than at either call site because there are two of them
// — the ask path's terminal arm and the probe's — and one sentence written
// twice is the shape this whole file exists to remove.
const UnexplainedFailureSentence = "the model failed to answer. The details are in nocx's log."

// Why this file imports go-openai directly, and why go.mod promotes it from an
// indirect dependency: the HTTP status is carried on a STRUCT FIELD
// (HTTPStatusCode) rather than behind a method, so there is no interface to
// depend on instead and no way to reach it without naming the type. The
// alternative was matching the framework's error TEXT, which classifyAskFailure
// forbids in as many words — every arm is reached by a type, so that the typed
// chain survives eino. A pinned dependency we can see in go.mod is the lesser
// coupling: if eino changes adapters this stops compiling, which is exactly the
// failure we want, rather than silently classifying nothing.

// EndpointErrorSentence turns a typed HTTP response from the model endpoint
// into a sentence a person can act on. The adapter preserves the provider's
// response type through its own APIError wrapper or the underlying
// RequestError, so this owner can classify it without exposing framework text.
func EndpointErrorSentence(err error, model string) (string, bool) {
	var requestErr *openai.RequestError
	var adapterAPIError *einoopenai.APIError
	var clientAPIError *openai.APIError
	if !errors.As(err, &requestErr) &&
		!errors.As(err, &adapterAPIError) &&
		!errors.As(err, &clientAPIError) {
		return "", false
	}

	status := 0
	if requestErr != nil {
		status = requestErr.HTTPStatusCode
	}
	if adapterAPIError != nil && adapterAPIError.HTTPStatusCode != 0 {
		status = adapterAPIError.HTTPStatusCode
	}
	if clientAPIError != nil && clientAPIError.HTTPStatusCode != 0 {
		status = clientAPIError.HTTPStatusCode
	}
	if status == 0 {
		return "", false
	}

	var code any
	if adapterAPIError != nil {
		code = adapterAPIError.Code
	} else if clientAPIError != nil {
		code = clientAPIError.Code
	}

	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "the model endpoint rejected the credential. Check the endpoint's API key or credential, then ask again.", true
	case http.StatusNotFound:
		if isModelNotFound(code) {
			return fmt.Sprintf("the model endpoint could not find model %q. Check the model id, then ask again.", model), true
		}
		return "the model endpoint returned 404 Not Found. Check the endpoint's address — the path may be wrong; an OpenAI-compatible base URL usually ends in /v1 — then ask again.", true
	default:
		return endpointStatusSentence(status), true
	}
}

func isModelNotFound(code any) bool {
	value, ok := code.(string)
	return ok && value == "model_not_found"
}

func endpointStatusSentence(status int) string {
	statusText := http.StatusText(status)
	if statusText == "" {
		return fmt.Sprintf("the model endpoint returned HTTP %d. Check the endpoint's configuration or status, then ask again.", status)
	}
	return fmt.Sprintf("the model endpoint returned HTTP %d %s. Check the endpoint's configuration or status, then ask again.", status, statusText)
}
