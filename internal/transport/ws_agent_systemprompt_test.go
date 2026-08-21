package transport

// The system prompt reaches the model on every ask (nocx-avogl.1).
//
// The defect these tests close is the one in the owner's screenshot: the
// model was never told the session id its tools require, and the policy's
// scope check refuses an invented one BEFORE it would ask the person. So
// the assertion is not "a system message exists" but "the message names the
// session THIS run is scoped to, verbatim" — and the paired end, in
// internal/assistant, is that the same string passes the scope check.

import (
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/assistant"
)

// systemMessages is the system half of what the engine was handed.
func systemMessages(msgs []assistant.Message) []assistant.Message {
	out := make([]assistant.Message, 0, 1)
	for _, m := range msgs {
		if m.Role == "system" {
			out = append(out, m)
		}
	}
	return out
}

// TestAgentAsk_QuestionWithNoReferencesStillCarriesTheSystemPrompt is the
// bead's third criterion at the near end: nothing attached, and the model is
// still told where it is — with the session id spelled as the tools take it.
func TestAgentAsk_QuestionWithNoReferencesStillCarriesTheSystemPrompt(t *testing.T) {
	client := &scriptedAssistantClient{deltas: []string{"sure"}}
	h := newAskHarness(t, client)
	h.createEndpoint()
	sid := openLocalSession(t, h.conn)

	res, errObj := askOverWire(t, h.conn, map[string]any{
		"askId":      "ask-sysprompt-1",
		"sessionId":  sid,
		"question":   "what is in this directory?",
		"cwd":        "/home/dev/repos/nocx",
		"references": []any{},
	}, 2)
	if errObj != nil {
		t.Fatalf("ask refused: %+v", errObj)
	}
	if res.State != "prepared" {
		t.Fatalf("ask state = %q, want prepared", res.State)
	}
	for range client.deltaCount() {
		readNotification(t, h.conn, "agent.runDelta", 5*time.Second)
	}

	msgs := client.messages()
	sys := systemMessages(msgs)
	if len(sys) != 1 {
		t.Fatalf("engine received %d system message(s), want exactly one standing prompt: %#v", len(sys), msgs)
	}
	if msgs[0].Role != "system" {
		t.Fatalf("the first message is %q, want the system prompt ahead of the question", msgs[0].Role)
	}
	if !strings.Contains(sys[0].Content, sid) {
		t.Fatalf("the prompt never names this run's session %q:\n%s", sid, sys[0].Content)
	}
	if !strings.Contains(sys[0].Content, "/home/dev/repos/nocx") {
		t.Fatalf("the prompt never names the working directory the ask carried:\n%s", sys[0].Content)
	}
	if !strings.Contains(sys[0].Content, "local shell") {
		t.Fatalf("the prompt never says this pane is a local shell:\n%s", sys[0].Content)
	}
	// The bought rule (nocx-4wtlh): nothing was attached, so nothing may
	// claim it was.
	if strings.Contains(sys[0].Content, "attached to this question") {
		t.Fatalf("a zero-reference ask claims attached content:\n%s", sys[0].Content)
	}
	if last := msgs[len(msgs)-1]; last.Role != "user" || last.Content != "what is in this directory?" {
		t.Fatalf("the question did not reach the engine intact: %#v", msgs)
	}
}

// TestAgentAsk_ReferencedContentIsAnnouncedInTheOneSystemPrompt is the far
// end: with a frame attached the standing prompt is still there, still names
// the session, and now carries the data-not-instructions sentence — one
// system message, not two, because there is one owner of what the model is
// told.
func TestAgentAsk_ReferencedContentIsAnnouncedInTheOneSystemPrompt(t *testing.T) {
	client := &scriptedAssistantClient{deltas: []string{"ok"}}
	h := newAskHarness(t, client)
	h.createEndpoint()
	sid := openLocalSession(t, h.conn)

	frameID, errObj := captureFrameOverWire(t, h.conn, frozenWireFrame(sid, "frame-sysprompt-1"), 1)
	if errObj != nil {
		t.Fatalf("captureFrame: %+v", errObj)
	}
	_, errObj = askOverWire(t, h.conn, map[string]any{
		"askId":     "ask-sysprompt-2",
		"sessionId": sid,
		"question":  "what does this mean?",
		"cwd":       "/repo",
		"references": []any{
			map[string]any{"frameId": frameID, "region": map[string]any{"rowStart": 0, "rowEnd": 2}},
		},
	}, 2)
	if errObj != nil {
		t.Fatalf("ask refused: %+v", errObj)
	}
	for range client.deltaCount() {
		readNotification(t, h.conn, "agent.runDelta", 5*time.Second)
	}

	msgs := client.messages()
	sys := systemMessages(msgs)
	if len(sys) != 1 {
		t.Fatalf("engine received %d system message(s), want exactly one: %#v", len(sys), msgs)
	}
	if !strings.Contains(sys[0].Content, sid) {
		t.Fatalf("the prompt never names this run's session %q:\n%s", sid, sys[0].Content)
	}
	if !strings.Contains(sys[0].Content, "attached to this question") {
		t.Fatalf("content was attached and the prompt never says so:\n%s", sys[0].Content)
	}
	var full string
	for _, m := range msgs {
		full += m.Content + "\n"
	}
	if !strings.Contains(full, "Referenced frame:") {
		t.Fatalf("the referenced frame's text never reached the engine: %q", full)
	}
}
