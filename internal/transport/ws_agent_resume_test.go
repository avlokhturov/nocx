package transport

// The resume, from the transport's side (nocx-igu4y, nocx-v94ne).
//
// Two facts about a run that a person has answered, both of which were
// wrong and both of which a person met as "the prompt never ends":
//
//  1. The grant the resumed attempt runs under is minted AGAIN, from the
//     policy as it stands after the answer. It used to be the one minted
//     with the question, so "allow in this session" — written by the very
//     call that resumes — could not take effect until the person's NEXT
//     question, and every further call in the run asked again.
//  2. A run that terminalizes leaves no continuation behind. The engine
//     holds a checkpoint from the moment it suspends; a decline ends the
//     run by a path Ask never returns from, so the transport is what drops
//     it.
//
// Both are asserted over the REAL socket against the REAL stores, through
// the scripted engine the other approval tests use: what is in question is
// what the TRANSPORT hands the engine, and a test that called the handler
// directly would prove the part nobody doubts.

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/content"
)

// TestAgentApprove_SessionAnswerReachesTheRunThatAskedIt: one run, one
// question, answered "in this session" — and the resumed attempt's grant
// PERMITS that effect class. Every later proposal of the same class in the
// same run therefore runs without asking, which is what the answer said.
//
// The assertion is on the grant the transport handed the engine, because
// that is the whole of the mechanism: the middleware is built per Ask from
// AskParams.Grant, so a grant that permits is a run that does not ask.
func TestAgentApprove_SessionAnswerReachesTheRunThatAskedIt(t *testing.T) {
	client := &scriptedApprovalClient{script: []approvalScriptStep{
		{suspend: policySuspension("files.read", "call_1", `{"path":"/repo/a.txt"}`, "hash-a")},
		{deltas: []string{"done"}},
	}}
	h := suspendedRunWith(t, askPolicyStore(t), client)

	h.approve(t, "session")
	waitFor(t, "the resume to drive the engine", 5*time.Second, func() bool { return client.askCount() == 2 })

	got := client.params()
	if len(got) != 2 {
		t.Fatalf("the engine was driven %d times, want 2 — the ask and its resume", len(got))
	}
	if got[0].Grant == nil || got[0].Grant.Policy.DecisionFor(content.EffectObserve) != content.DecisionAsk {
		t.Fatalf("the ask ran under %+v, want a grant that ASKS for observe — otherwise the question below is not the one being answered", got[0].Grant)
	}
	if got[1].Grant == nil {
		t.Fatal("the resume carried no grant at all")
	}
	if d := got[1].Grant.Policy.DecisionFor(content.EffectObserve); d != content.DecisionPermit {
		t.Fatalf("the resumed attempt's grant decides observe = %q, want permit: the person answered \"allow in this session\" and the run they answered about went on asking (nocx-v94ne)", d)
	}
}

// TestAgentApprove_DeclineDropsTheEnginesContinuation: the person said no,
// the run is terminal, and nothing may resume it — so the checkpoint the
// suspension wrote is dropped. Ask never returns from a decline (the run
// ends between two drives), so this is the transport's to do; a checkpoint
// nobody may resume is a copy of the run's messages held for the life of
// the process (ADR-0028: deleted on terminalization).
func TestAgentApprove_DeclineDropsTheEnginesContinuation(t *testing.T) {
	client := &scriptedApprovalClient{script: []approvalScriptStep{
		{suspend: policySuspension("files.read", "call_1", `{"path":"/repo/a.txt"}`, "hash-a")},
	}}
	h := suspendedRunWith(t, askPolicyStore(t), client)

	h.deny(t, "once")

	waitFor(t, "the declined run's continuation to be dropped", 5*time.Second, func() bool { return len(client.discards()) > 0 })
	if got := client.discards(); len(got) != 1 || got[0] != strconv.FormatInt(h.runID, 10) {
		t.Fatalf("discarded %v, want exactly the declined run %q", got, strconv.FormatInt(h.runID, 10))
	}
	if client.askCount() != 1 {
		t.Fatalf("the engine was driven %d times, want 1 — a declined run is not resumed", client.askCount())
	}
}

// TestAgentApprove_ResumedDeltasContinueTheNumbering: one run, one answer,
// one ascending sequence — even though a question interrupted it.
//
// The numbering used to restart at 0 on every drive, and that was harmless
// only because the resume re-rolled the whole answer: a repeated delta is a
// no-op on the store's (artifact_id, seq) key, and the renderer re-received
// text it already had. Since nocx-igu4y the resume CONTINUES, so a restart
// would write new text over the persisted chunks of the text before the
// question and hand the renderer new content on numbers it has already
// placed.
func TestAgentApprove_ResumedDeltasContinueTheNumbering(t *testing.T) {
	client := &scriptedApprovalClient{script: []approvalScriptStep{
		{
			deltas:  []string{"let me", " look"},
			suspend: policySuspension("files.read", "call_1", `{"path":"/repo/a.txt"}`, "hash-a"),
		},
		{deltas: []string{" — it says", " hello"}},
	}}
	h := suspendedRunWith(t, askPolicyStore(t), client)

	// The two deltas before the question. suspendedRunWith has already read
	// past them to the approvalRequested notification, so they are read off
	// the ledger rather than the wire; the wire's own numbering is asserted
	// on the two that follow the answer.
	h.approve(t, "session")

	var seqs []int
	var text string
	deadline := time.Now().Add(5 * time.Second)
	for len(seqs) < 2 && time.Now().Before(deadline) {
		raw := readNotification(t, h.conn, "agent.runDelta", 5*time.Second)
		var d struct {
			Seq  int    `json:"seq"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatalf("runDelta unmarshal: %v", err)
		}
		seqs = append(seqs, d.Seq)
		text += d.Text
	}
	if len(seqs) != 2 || seqs[0] != 2 || seqs[1] != 3 {
		t.Fatalf("the resumed deltas arrived as seq %v carrying %q, want 2 then 3 — the answer before the question already used 0 and 1, and the resume continues it (nocx-igu4y)", seqs, text)
	}
}
