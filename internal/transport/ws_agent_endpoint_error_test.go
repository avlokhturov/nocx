package transport

import (
	"net/http"
	"strings"
	"testing"

	openai "github.com/meguminnnnnnnnn/go-openai"
	"github.com/shady2k/nocx/internal/content"
)

func TestClassifyAskFailure_EndpointResponsesUseAssistantSentences(t *testing.T) {
	const model = "tiel-coder-35b-a3b-mlx-oq4e"
	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "credential",
			err:  &openai.APIError{HTTPStatusCode: http.StatusUnauthorized},
			want: "credential",
		},
		{
			name: "address",
			err:  &openai.APIError{HTTPStatusCode: http.StatusNotFound},
			want: "/v1",
		},
		{
			name: "model id",
			err:  &openai.APIError{HTTPStatusCode: http.StatusNotFound, Code: "model_not_found"},
			want: model,
		},
		{
			name: "other status",
			err:  &openai.RequestError{HTTPStatusCode: http.StatusTooManyRequests},
			want: "429",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reason, sentence := classifyAskFailure(tt.err, model)
			if reason != content.TermFailed {
				t.Fatalf("reason = %q, want %q", reason, content.TermFailed)
			}
			if !strings.Contains(sentence, tt.want) {
				t.Fatalf("sentence = %q, want %q", sentence, tt.want)
			}
			for _, frameworkWord := range []string{"NodeRunError", "node path", "ToolNode"} {
				if strings.Contains(sentence, frameworkWord) {
					t.Errorf("sentence contains framework text %q: %q", frameworkWord, sentence)
				}
			}
		})
	}
}
