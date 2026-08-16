package assistant

// The tool-call pipeline (design §6, ADR-0028 decision 2), at eino's own
// seam — adk.ChatModelAgentMiddleware.WrapInvokableToolCall, called at
// request time with the tool's name, call id and arguments before it runs.
//
// This layer SEQUENCES AND ENFORCES; it does not implement. Masking has an
// owner, the audit has an owner, usage has an owner. What is ours, and only
// what is ours: the permit/ask/refuse decision, the attempt record before
// the call, the narrowed capability, and the batch latch.
//
// The order is the design's order, and two of its three invariants are
// stated with both ends:
//
//   - Validation precedes policy. A policy reading arguments that have not
//     been validated is deciding about something that may not be what
//     executes.
//   - The attempt exists from before the effect until the outcome or a
//     terminal reason is recorded. Not "the attempt is written before the
//     call" — that names a moment; the interval is the thing.
//   - A refusal terminalizes. ErrPolicyRefused is a nocx error, never a
//     ToolOutput: a tool result with no error becomes text the model reads
//     and works around, which is exactly the failure this rule prevents.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/shady2k/nocx/internal/agenttools"
	"github.com/shady2k/nocx/internal/content"
)

// ErrPolicyRefused is the terminal error of a refused tool call (ADR-0028
// decision 2): the run fails with it — ToolsNode aborts on a non-interrupt
// error rather than producing a tool message, and no second model request is
// made. The run adapter terminalizes the attempt as refused.
var ErrPolicyRefused = errors.New("agent policy: tool call refused")

// ErrMalformedModelOutput marks a tool call that corresponds to no declared
// tool or whose arguments do not match the schema the model was shown. Not a
// refusal — there is nothing to call; the model produced output the engine
// cannot act on. Terminal, like a refusal.
var ErrMalformedModelOutput = errors.New("agent policy: malformed model output")

// errApprovalRequested is what Ask returns when the run suspended for human
// approval: the run is NOT failed — it is awaiting_approval, and the request
// is what the approval surface renders and the resume re-validates.
type errApprovalRequested struct {
	request *approvalRequest
}

func (e *errApprovalRequested) Error() string {
	if e.request == nil {
		return "agent run suspended for approval"
	}
	return fmt.Sprintf("agent run suspended for approval: %s %s", e.request.Tool, e.request.CallID)
}

// approvalRequest is the user-facing ask (design §7.2): what was proposed,
// bound to the exact proposal. The surface shows it; the resume re-runs the
// pipeline and the approval record decides. It is also the interrupt state
// the checkpoint persists, so it is gob-registered: checkpoints are
// serialized, and an unregistered type fails the run at the suspension.
type approvalRequest struct {
	RunID     string `json:"runId"`
	Attempt   int    `json:"attempt"`
	Tool      string `json:"tool"`
	CallID    string `json:"callId"`
	Arguments string `json:"arguments"`
}

func init() {
	gob.Register(approvalRequest{})
}

// attemptLedger is the slice of the ledger one tool attempt needs (design
// §6.4 — the attempt is durable, before the call). The full
// LedgerRepository is not the seam: a test must be able to fail exactly the
// write the invariant names (nocx-m4r3m's StartExecution) without
// implementing the other twenty methods.
type AttemptLedger interface {
	EnsureEnvironment(ctx context.Context, env content.Environment) error
	RecordObservation(ctx context.Context, obs content.Observation) (int64, error)
	Submit(ctx context.Context, in content.SubmitEntry) (content.SubmitResult, error)
	StartExecution(ctx context.Context, in content.StartExecution) (int64, error)
	FinishExecution(ctx context.Context, executionID int64, end content.FinishExecution) error
}

// maxArgsBytes bounds the model's argument JSON — the ingress size bound of
// design §6.2. A path is a few hundred bytes; anything larger is malformed.
const maxArgsBytes = 64 << 10

// maxToolResultBytes is the ingest bound of design §6.7, a defense for a
// tool that violates the window contract (§4.4: every tool that returns text
// returns a window) — files.read's window is filesReadWindowBytes, far below
// this.
const maxToolResultBytes = 1 << 20

// policyMiddleware is the pipeline for ONE run (one Ask): it holds the run's
// grant, the assembled registry, the ledger seam, the approval store and the
// run's identity — everything the permit/ask/refuse decision and the attempt
// record need. A fresh instance per run; the grant is immutable once
// execution starts (ADR-0020 decision 5), and only a new attempt carries a
// different one.
type policyMiddleware struct {
	adk.BaseChatModelAgentMiddleware

	grant     content.Grant
	registry  agenttools.Registry
	ledger    AttemptLedger
	approvals *ApprovalStore
	runID     string
	attempt   int

	validators map[string]*jsonschema.Schema
}

// newPolicyMiddleware builds the pipeline for one run. A schema that does
// not compile is a broken declaration — the run fails here, loudly, rather
// than at the call.
func newPolicyMiddleware(grant content.Grant, registry agenttools.Registry, ledger AttemptLedger, approvals *ApprovalStore, runID string, attempt int) (*policyMiddleware, error) {
	m := &policyMiddleware{
		grant:      grant,
		registry:   registry,
		ledger:     ledger,
		approvals:  approvals,
		runID:      runID,
		attempt:    attempt,
		validators: make(map[string]*jsonschema.Schema, len(registry.All())),
	}
	for _, t := range registry.All() {
		v, err := compileToolSchema(t)
		if err != nil {
			return nil, err
		}
		m.validators[t.Name] = v
	}
	return m, nil
}

// compileToolSchema compiles one tool's params schema — the same file the
// model was shown — into the validator the middleware applies to the model's
// arguments (design §6.2: the model is a LESS trusted source than the
// renderer and gets the same discipline, never a weaker one).
func compileToolSchema(t agenttools.Tool) (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(t.ParamsSchema))
	if err != nil {
		return nil, fmt.Errorf("tool %s: params schema: %w", t.Name, err)
	}
	url := "https://nocx.local/contracts/tools/" + t.Name + ".schema.json"
	c := jsonschema.NewCompiler()
	if addErr := c.AddResource(url, doc); addErr != nil {
		return nil, fmt.Errorf("tool %s: params schema: %w", t.Name, addErr)
	}
	s, err := c.Compile(url)
	if err != nil {
		return nil, fmt.Errorf("tool %s: params schema: %w", t.Name, err)
	}
	return s, nil
}

// BeforeAgent mints the batch latch for this run and installs it in the run
// context (the batch latch is ours, not the framework's — ADR-0028 decision
// 2). It runs on every Run AND every Resume: a resumed attempt is a new
// attempt with a fresh latch.
func (m *policyMiddleware) BeforeAgent(ctx context.Context, runCtx *adk.ChatModelAgentContext) (context.Context, *adk.ChatModelAgentContext, error) {
	return withLatch(ctx, &batchLatch{}), runCtx, nil
}

// WrapInvokableToolCall installs the pipeline on one tool call.
func (m *policyMiddleware) WrapInvokableToolCall(ctx context.Context, endpoint adk.InvokableToolCallEndpoint, tCtx *adk.ToolContext) (adk.InvokableToolCallEndpoint, error) {
	return func(ctx context.Context, rawArgs string, _ ...tool.Option) (string, error) {
		// The batch latch, before anything else: once a call in this model
		// response refused or escalated, every later call returns immediately
		// without calling next. sequentialRunToolCall loops every task and
		// never inspects tasks[i].err, so without the latch a refused call
		// would not stop the next one from running.
		if l := latchFrom(ctx); l != nil {
			if reason := l.tripped(); reason != nil {
				return "", m.deferred(ctx, tCtx, reason)
			}
		}

		// 1. Declaration lookup. A name absent from the registry is malformed
		// model output, not a refusal — there is nothing to call.
		decl, ok := m.registry.Lookup(tCtx.Name)
		if !ok {
			return "", fmt.Errorf("%w: unknown tool %q", ErrMalformedModelOutput, tCtx.Name)
		}

		// 2. Parameter validation against the tool's schema: the file the
		// model was shown, byte for byte, plus the ingress size bound.
		if len(rawArgs) > maxArgsBytes {
			return "", fmt.Errorf("%w: tool %q: arguments exceed the %d-byte bound", ErrMalformedModelOutput, decl.Name, maxArgsBytes)
		}
		args, err := m.validate(decl, rawArgs)
		if err != nil {
			return "", fmt.Errorf("%w: tool %q: %v", ErrMalformedModelOutput, decl.Name, err)
		}

		// 3. Policy — permit / ask / refuse over the ADR-0020 lattice.
		switch m.decide(decl, args) {
		case policyRefuse:
			tripLatch(ctx, ErrPolicyRefused)
			return "", ErrPolicyRefused
		case policyAsk:
			// Approval binds to the exact proposal: an approved call skips
			// the ask; a changed argument hashes differently and does NOT
			// resume under the old approval (design §7.2).
			ap := m.proposal(decl.Name, tCtx.CallID, rawArgs)
			if m.approvals != nil && m.approvals.IsApproved(ap) {
				break // the exact proposal was approved; execute it
			}
			tripLatch(ctx, &errApprovalRequested{request: m.request(decl.Name, tCtx.CallID, rawArgs)})
			return "", m.escalate(ctx, decl.Name, tCtx.CallID, rawArgs)
		}

		// 4. The attempt is written BEFORE the call. If that write fails, no
		// capability is constructed, next is not called, and the run fails
		// with a terminal infrastructure error — an interrupted run can
		// never be told "this may already have happened" when it cannot.
		execID, err := m.openAttempt(ctx, decl, rawArgs)
		if err != nil {
			return "", fmt.Errorf("agent tool %q: record attempt: %w", decl.Name, err)
		}

		// 5. The narrowed capability is constructed. The tool holds only
		// this; it cannot exceed the grant because it never has more
		// (ADR-0028 decision 4 — a check would leave it holding a full
		// manager). A tool with no Narrow is declared-but-not-executable
		// and is refused here, honestly.
		if decl.Narrow == nil {
			_ = m.closeAttempt(ctx, execID, content.TermFailed, content.EntryFailure)
			return "", fmt.Errorf("agent tool %q is declared but not executable: no capability constructor is wired", decl.Name)
		}
		capability, err := decl.Narrow(m.grant)
		if err != nil {
			_ = m.closeAttempt(ctx, execID, content.TermFailed, content.EntryFailure)
			return "", fmt.Errorf("agent tool %q: construct capability: %w", decl.Name, err)
		}

		// 6. Execution — in Go, against the narrowed capability.
		out, runErr := m.run(decl, ctx, capability, []byte(rawArgs))

		// 8. The outcome is recorded on the attempt — the interval closes
		// with the outcome or the terminal reason, never before.
		if runErr != nil {
			_ = m.closeAttempt(ctx, execID, content.TermFailed, content.EntryFailure)
			return "", runErr
		}

		// 7. Result ingest: the window and the size bound. The executor
		// windows its own return (design §4.4); this is the bound that holds
		// even when a tool forgets.
		if len(out) > maxToolResultBytes {
			_ = m.closeAttempt(ctx, execID, content.TermFailed, content.EntryFailure)
			return "", fmt.Errorf("agent tool %q: result exceeds the %d-byte bound — a tool that returns text must return a window (design §4.4)", decl.Name, maxToolResultBytes)
		}
		if err := m.closeAttempt(ctx, execID, content.TermCompleted, content.EntrySuccess); err != nil {
			return "", fmt.Errorf("agent tool %q: record outcome: %w", decl.Name, err)
		}
		return out, nil
	}, nil
}

// validate applies the tool's compiled schema to the model's raw arguments.
// The result is the parsed object the policy evaluates — the same object the
// executor will receive, so the policy never decides about something that
// may not be what executes.
func (m *policyMiddleware) validate(decl agenttools.Tool, raw string) (map[string]any, error) {
	v := m.validators[decl.Name]
	if v == nil {
		return nil, errors.New("no validator compiled for this tool")
	}
	var doc any
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("arguments are not JSON: %w", err)
	}
	if err := v.Validate(doc); err != nil {
		return nil, fmt.Errorf("arguments do not match the schema the model was shown: %w", err)
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, errors.New("arguments are not an object")
	}
	return obj, nil
}

// ── policy ────────────────────────────────────────────────────────────────

type policyOutcome int

const (
	policyPermit policyOutcome = iota
	policyAsk
	policyRefuse
)

// decide is the permit/ask/refuse function over the ADR-0020 lattice
// (decision 6) — the three presets of decision 7, plus the two rules that
// must hold under any preset: a call naming a resource outside the grant is
// refused (the tool's contract is "within the grant's paths"; widening the
// grant is a NEW grant on a NEW attempt, not a mid-run question), and an
// effect the grant does not permit is refused (the tool should never have
// been declared under this grant — ForGrant filters — and this is the
// defense that holds if the declaration path is bypassed).
func (m *policyMiddleware) decide(t agenttools.Tool, args map[string]any) policyOutcome {
	if !m.effectPermitted(t.Effect) {
		return policyRefuse
	}
	if !m.inScope(t, args) {
		return policyRefuse
	}
	switch m.grant.Policy {
	case content.GrantAskEveryTime:
		return policyAsk
	case content.GrantAskOnMutate:
		if t.Effect != content.EffectObserve {
			return policyAsk
		}
		return policyPermit
	case content.GrantAutonomous:
		return policyPermit
	default:
		// A grant without a stated policy fails toward asking: the default
		// for anything unreadable is to ask, and a silent grant is how a
		// feature that does not exist survives a release.
		return policyAsk
	}
}

func (m *policyMiddleware) effectPermitted(e content.Effect) bool {
	for _, p := range m.grant.Effects {
		if p == e {
			return true
		}
	}
	return false
}

// inScope is the policy's scope check: the resource the call names must be
// inside the grant. It is NOT the enforcement — the capability is the
// enforcement (ADR-0028 decision 4) — and it is deliberately the advisory
// lexical approximation of it: the capability resolves canonical identity,
// the policy compares the spelled path. A call this check lets through can
// still be refused by the capability; a call it refuses never reaches the
// capability.
func (m *policyMiddleware) inScope(t agenttools.Tool, args map[string]any) bool {
	if t.ResourceArg == "" {
		// The tool names no resource in its parameters; its scope is the
		// grant's own scope for the kinds it declares.
		return true
	}
	path, ok := args[t.ResourceArg].(string)
	if !ok {
		return false // validation already required it; refuse to be sure
	}
	for _, s := range m.grant.Scopes {
		if s.Kind == content.ResourcePath && pathUnder(path, s.ID) {
			return true
		}
	}
	return false
}

// pathUnder is the lexical containment test of the policy's scope check: the
// path is the spelled argument, the scope is the grant's spelled scope. Both
// ends are absolute; the capability's canonical check is what actually
// decides whether the read happens.
func pathUnder(path, scope string) bool {
	if scope == "" {
		return false
	}
	if path == scope {
		return true
	}
	return strings.HasPrefix(path, strings.TrimSuffix(scope, "/")+"/")
}

// ── the ask and the latch ─────────────────────────────────────────────────

// escalate suspends the run BEFORE next — the call that is asking has not
// run, and no call after it in this model response will. The persisted state
// is the proposal itself: the resume re-runs the pipeline and the approval
// record decides whether the exact proposal may execute.
func (m *policyMiddleware) escalate(ctx context.Context, toolName, callID, rawArgs string) error {
	req := m.request(toolName, callID, rawArgs)
	if m.approvals != nil {
		m.approvals.Request(m.proposal(toolName, callID, rawArgs))
	}
	return compose.StatefulInterrupt(ctx, req, req)
}

func (m *policyMiddleware) request(toolName, callID, rawArgs string) *approvalRequest {
	return &approvalRequest{
		RunID:     m.runID,
		Attempt:   m.attempt,
		Tool:      toolName,
		CallID:    callID,
		Arguments: rawArgs,
	}
}

func (m *policyMiddleware) proposal(toolName, callID, rawArgs string) Approval {
	return Approval{
		RunID:   m.runID,
		Attempt: m.attempt,
		Tool:    toolName,
		CallID:  callID,
		ArgHash: canonicalArgHash(rawArgs),
	}
}

// canonicalArgHash hashes the CANONICAL form of the arguments — JSON with
// sorted object keys — so a re-serialized equivalent is the same proposal.
func canonicalArgHash(raw string) string {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		h := sha256.Sum256([]byte(raw)) // unparseable: hash the bytes as-is
		return hex.EncodeToString(h[:])
	}
	b, err := json.Marshal(v)
	if err != nil {
		h := sha256.Sum256([]byte(raw))
		return hex.EncodeToString(h[:])
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// deferred returns what a latched call returns: an interrupt error, so the
// batch still suspends cleanly when the trigger was an escalation (a plain
// error here would fail the run instead of suspending it). When the trigger
// was a refusal, ToolsNode aborts at the first non-interrupt error before
// this one is examined. Either way: next is not called, the tool does not
// run, and the human is told the truth about the call that asked.
func (m *policyMiddleware) deferred(ctx context.Context, tCtx *adk.ToolContext, reason error) error {
	info := fmt.Sprintf("call %q (%s) did not run: a prior call in this response %v", tCtx.Name, tCtx.CallID, reason)
	return compose.Interrupt(ctx, info)
}

// approvalRequestFrom finds the pipeline's own ask among an interrupt
// event's contexts: the asking call carries our *approvalRequest as its
// info; the latched, deferred calls carry a plain string ("a prior call
// ..."). The first ask is the one the human decides about.
func approvalRequestFrom(info *adk.InterruptInfo) *approvalRequest {
	if info == nil {
		return nil
	}
	for _, ic := range info.InterruptContexts {
		if req, ok := ic.Info.(*approvalRequest); ok {
			return req
		}
	}
	return nil
}

// ── the attempt ───────────────────────────────────────────────────────────

// openAttempt writes the durable attempt BEFORE the call: the environment,
// the action entry (the audit row — kind='action', design §3.2) and the
// execution that records the grant. The grant recorded is the run's grant:
// "what was this allowed to do" is a query over the record, not a
// reconstruction (ADR-0020 decision 5).
func (m *policyMiddleware) openAttempt(ctx context.Context, decl agenttools.Tool, rawArgs string) (int64, error) {
	if m.ledger == nil {
		return 0, errors.New("no attempt ledger wired — a tool call may not run without a durable attempt (design §6.4)")
	}
	envID := content.EnvironmentIDFor(content.EnvLocal, "")
	if err := m.ledger.EnsureEnvironment(ctx, content.Environment{ID: envID, Kind: content.EnvLocal}); err != nil {
		return 0, fmt.Errorf("environment: %w", err)
	}
	if _, err := m.ledger.RecordObservation(ctx, content.Observation{
		EnvironmentID: envID,
		Criticality:   content.CriticalityRoutine,
	}); err != nil {
		return 0, fmt.Errorf("observation: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"tool":   decl.Name,
		"effect": decl.Effect,
		"args":   json.RawMessage(rawArgs),
	})
	if err != nil {
		return 0, fmt.Errorf("payload: %w", err)
	}
	res, err := m.ledger.Submit(ctx, content.SubmitEntry{
		ID:            uuid.NewString(),
		Client:        "agent",
		EnvironmentID: envID,
		Cwd:           "/",
		Kind:          content.EntryAction,
		Intent:        decl.Name,
		Payload:       string(payload),
	})
	if err != nil {
		return 0, fmt.Errorf("submit: %w", err)
	}
	execID, err := m.ledger.StartExecution(ctx, content.StartExecution{
		EntryID:  res.ID,
		Executor: new("agent"),
		Grant:    &m.grant,
	})
	if err != nil {
		return 0, fmt.Errorf("start execution: %w", err)
	}
	return execID, nil
}

// closeAttempt records the outcome on the attempt — the closing event of the
// interval "the attempt exists from before the effect until the outcome or a
// terminal reason is recorded".
func (m *policyMiddleware) closeAttempt(ctx context.Context, execID int64, reason content.TerminationReason, status content.EntryStatus) error {
	if m.ledger == nil {
		return nil
	}
	return m.ledger.FinishExecution(ctx, execID, content.FinishExecution{
		EndedAt:           time.Now().UnixMilli(),
		TerminationReason: reason,
		Status:            status,
	})
}

// run dispatches one executable tool to its executor. The capability and the
// executor stay paired by the declaration row: the same tool name looked up
// here is the name the middleware narrowed the capability with.
func (m *policyMiddleware) run(decl agenttools.Tool, ctx context.Context, capability agenttools.Capability, rawArgs []byte) (string, error) {
	fn, ok := executors[decl.Name]
	if !ok {
		return "", fmt.Errorf("tool %q has a capability constructor but no executor — a registration that cannot run", decl.Name)
	}
	return fn(ctx, capability, rawArgs)
}

// ── the batch latch ───────────────────────────────────────────────────────

// batchLatch is per-run state shared by every call in one model response:
// once one call refuses or escalates, the others return without calling
// next. It lives in the run context, installed by BeforeAgent — which is why
// a resumed attempt gets a fresh one: the resume is a new attempt.
type batchLatch struct {
	mu     sync.Mutex
	reason error
}

func (l *batchLatch) trip(reason error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.reason == nil {
		l.reason = reason
	}
}

func (l *batchLatch) tripped() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.reason
}

type latchKey struct{}

func withLatch(ctx context.Context, l *batchLatch) context.Context {
	return context.WithValue(ctx, latchKey{}, l)
}

func latchFrom(ctx context.Context) *batchLatch {
	l, _ := ctx.Value(latchKey{}).(*batchLatch)
	return l
}

func tripLatch(ctx context.Context, reason error) {
	if l := latchFrom(ctx); l != nil {
		l.trip(reason)
	}
}
