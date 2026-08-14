package assistant

// The eino wiring (ADR-0028 decision 1, design §4.1): adk.ChatModelAgent
// with the OpenAI-compatible adapter from eino-ext, zero tools declared.
// We do NOT write a tool-calling loop, an SSE client, or a provider adapter
// set — the framework's, all of it.
//
// Explain mode only (design §4.2): zero tools, terminate after the first
// completed response, context is question + referenced frames. The tools,
// the policy middleware, the grant and the narrowed capability are nocx-lndv
// and deliberately do not live here. With zero tools ADK builds
// buildNoToolsRunFunc — a direct model chain with no tools node — so a
// hallucinated tool call cannot even reach a middleware; there is none.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	openai "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/schema"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
)

// buildModel constructs the OpenAI-compatible chat model for one
// endpoint+model over the guarded HTTP client. The key is a copy made
// deliberately inside Secret.Use, exactly as internal/capability does for
// the same boundary; it lives only in the model config, which dies with the
// function's scope.
func buildModel(httpClient *http.Client, key credential.Secret, baseURL, model string) (*openai.ChatModel, error) {
	var apiKey string
	if err := key.Use(func(b []byte) error {
		apiKey = string(b)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read API key: %w", err)
	}
	cm, err := openai.NewChatModel(context.Background(), &openai.ChatModelConfig{
		BaseURL:    baseURL,
		APIKey:     apiKey,
		Model:      model,
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, fmt.Errorf("build model: %w", err)
	}
	return cm, nil
}

// streamModelAnswer streams the model's answer to msgs through the adk
// agent, calling onDelta for every content chunk. It is the explain-mode
// run: zero tools, terminate after the first completed response.
//
// Every error this returns is a stream failure the caller maps into a probe
// outcome; a nil return means a response was received in full.
func streamModelAnswer(ctx context.Context, logger log.Logger, httpClient *http.Client, key credential.Secret, baseURL, model string, msgs []*schema.Message, onDelta func(string)) error {
	cm, err := buildModel(httpClient, key, baseURL, model)
	if err != nil {
		return err
	}
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{Model: cm})
	if err != nil {
		return fmt.Errorf("build agent: %w", err)
	}

	it := agent.Run(ctx, &adk.AgentInput{
		Messages:        msgs,
		EnableStreaming: true,
	})
	for {
		ev, ok := it.Next()
		if !ok {
			return nil
		}
		if ev.Err != nil {
			return ev.Err
		}
		if ev.Output == nil || ev.Output.MessageOutput == nil {
			continue
		}
		mo := ev.Output.MessageOutput
		if mo.IsStreaming && mo.MessageStream != nil {
			stream := mo.MessageStream
			// Read-once, must close exactly once (schema/stream.go) —
			// drained to EOF or returned early, either way it closes.
			defer stream.Close()
			for {
				msg, err := stream.Recv()
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					return err
				}
				if msg != nil && msg.Content != "" {
					onDelta(msg.Content)
				}
			}
			continue
		}
		if mo.Message != nil && mo.Message.Content != "" {
			onDelta(mo.Message.Content)
		}
	}
}
