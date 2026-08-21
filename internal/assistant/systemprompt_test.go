package assistant

// The system prompt (nocx-avogl.1, design §1). Two things are asserted here,
// and the second is the defect the bead closes:
//
//   - the assembled text is a PURE function of its facts — a table over the
//     shapes a pane can have, with no I/O and nothing read from the machine
//     the test runs on;
//   - a model told this prompt can name the session its tools require. The
//     id is read back OUT OF THE PROMPT, the way a model reads it, and the
//     same string is then put through the real policy pipeline: it passes
//     the scope check that terminally refuses an invented one.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
)

// sessionIDAsAModelReadsIt takes the id back out of the prompt text: the
// token the "Session id:" line names, up to the end of the line. Reading it
// rather than reusing the constant is the point — a prompt that truncated,
// quoted or reformatted the id would fail here exactly as it fails at the
// tool call.
func sessionIDAsAModelReadsIt(t *testing.T, prompt string) string {
	t.Helper()
	_, after, ok := strings.Cut(prompt, "Session id: ")
	if !ok {
		t.Fatalf("the prompt never names the session id:\n%s", prompt)
	}
	line, _, _ := strings.Cut(after, "\n")
	return strings.TrimSpace(line)
}

// TestSystemPrompt_TellsTheModelTheSessionItsToolsRequire is the bead's
// first criterion. The grant is minted as the transport mints it — scoped to
// exactly one session — and the pipeline is the real one: an invented id is
// refused terminally (the scope check runs BEFORE the ask branch), and the
// id the prompt gave the model is not.
func TestSystemPrompt_TellsTheModelTheSessionItsToolsRequire(t *testing.T) {
	const sid = "0198f3aa-6d1e-7c31-9f0a-1c2d3e4f5a6b"
	prompt := SystemPrompt(SystemPromptFacts{
		SessionID: sid,
		Cwd:       "/home/dev/repos/nocx",
		Env:       content.Environment{Kind: content.EnvLocal},
		OS:        "linux",
	})

	told := sessionIDAsAModelReadsIt(t, prompt)
	if told != sid {
		t.Fatalf("the prompt names session %q, want %q verbatim — the tools take the exact string", told, sid)
	}

	grant := sessionGrant(sid, autonomousMatrix())

	// readScreen: the invented id is refused, the told id reaches the
	// renderer.
	screen := &recordingRequester{body: liveFrameBody("hello")}
	mw := middlewareForWithRequester(t, grant, &fakeLedger{}, nil, screen)
	if _, err := wrappedEndpoint(mw, "readScreen", "c1", `{"sessionId":"the-model-made-this-up"}`); !errors.Is(err, ErrPolicyRefused) {
		t.Fatalf("an invented sessionId gave %v, want ErrPolicyRefused — the refusal the prompt exists to prevent", err)
	}
	out, err := wrappedEndpoint(mw, "readScreen", "c2", `{"sessionId":`+quoted(told)+`}`)
	if err != nil {
		t.Fatalf("readScreen with the id the prompt gave failed: %v", err)
	}
	if calls := screen.calls(); len(calls) != 1 || calls[0].sessionID != sid {
		t.Fatalf("renderer was asked %+v, want exactly one read of %s", calls, sid)
	}
	if !strings.Contains(out, "hello") {
		t.Fatalf("readScreen result = %q, want the screen text", out)
	}

	// run: the same rule on the tool that changes something.
	runner := &recordingRunner{body: runResolvedBody("e1", nil, "completed", 1, 0, 1, "ok")}
	mwRun := middlewareForWithRequester(t, grant, &fakeLedger{}, nil, runner)
	if _, err := wrappedEndpoint(mwRun, "run", "c3", `{"sessionId":"the-model-made-this-up","command":"ls"}`); !errors.Is(err, ErrPolicyRefused) {
		t.Fatalf("an invented sessionId on run gave %v, want ErrPolicyRefused", err)
	}
	if _, err := wrappedEndpoint(mwRun, "run", "c4", `{"sessionId":`+quoted(told)+`,"command":"ls"}`); errors.Is(err, ErrPolicyRefused) {
		t.Fatalf("run with the id the prompt gave was refused by the policy: %v", err)
	}
	calls := runner.runCalls()
	if len(calls) != 1 || calls[0].sessionID != sid || calls[0].command != "ls" {
		t.Fatalf("runner was asked %+v, want exactly one `ls` in %s", calls, sid)
	}
}

func quoted(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestSystemPrompt_IsAFunctionOfItsFacts is the table: what each shape of
// pane produces, and what it must never produce. No I/O, nothing read from
// the host — the caller owns every fact, including the OS.
func TestSystemPrompt_IsAFunctionOfItsFacts(t *testing.T) {
	host := "build.example.com"
	remote := content.Environment{Kind: content.EnvSSH, Endpoint: &host}

	cases := []struct {
		name   string
		facts  SystemPromptFacts
		want   []string
		unwant []string
	}{
		{
			name: "a local pane names the machine's OS",
			facts: SystemPromptFacts{
				SessionID: "s-1", Cwd: "/repo",
				Env: content.Environment{Kind: content.EnvLocal}, OS: "darwin",
			},
			want:   []string{"s-1", "/repo", "darwin", "local"},
			unwant: []string{"ssh", "attached"},
		},
		{
			name: "an ssh pane names the host and states no OS for it",
			facts: SystemPromptFacts{
				SessionID: "s-2", Cwd: "/srv", Env: remote, OS: "darwin",
			},
			want:   []string{"s-2", "/srv", "ssh", host},
			unwant: []string{"darwin"},
		},
		{
			name: "a fact with no owner is omitted, not guessed",
			facts: SystemPromptFacts{
				SessionID: "s-3", Env: content.Environment{Kind: content.EnvLocal},
			},
			want:   []string{"s-3"},
			unwant: []string{"Working directory"},
		},
		{
			name: "attached content is called out only when something is attached",
			facts: SystemPromptFacts{
				SessionID: "s-4", Cwd: "/repo",
				Env: content.Environment{Kind: content.EnvLocal}, OS: "linux",
				AttachedContent: true,
			},
			want:   []string{"s-4", "attached"},
			unwant: []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SystemPrompt(tc.facts)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("prompt lacks %q:\n%s", w, got)
				}
			}
			for _, u := range tc.unwant {
				if strings.Contains(got, u) {
					t.Errorf("prompt contains %q and must not:\n%s", u, got)
				}
			}
			if again := SystemPrompt(tc.facts); again != got {
				t.Errorf("the same facts produced two different prompts")
			}
		})
	}
}

// TestSystemPrompt_AttachedContentSentenceIsConditional keeps the bought
// rule (nocx-4wtlh): a question with nothing attached must not claim
// content was attached — the sentence is derived from the facts, never a
// constant.
func TestSystemPrompt_AttachedContentSentenceIsConditional(t *testing.T) {
	base := SystemPromptFacts{
		SessionID: "s-5", Cwd: "/repo",
		Env: content.Environment{Kind: content.EnvLocal}, OS: "linux",
	}
	without := SystemPrompt(base)
	base.AttachedContent = true
	with := SystemPrompt(base)

	if strings.Contains(without, "attached") {
		t.Errorf("a zero-reference ask claims attached content:\n%s", without)
	}
	if !strings.Contains(with, "attached") {
		t.Errorf("an ask with references never says the content is attached data:\n%s", with)
	}
	if len(with) <= len(without) {
		t.Errorf("the attached-content sentence added nothing")
	}
}
