# ADR-0028 — Eino runs the loop; the grant and the narrowing are ours

- **Status:** Accepted
- **Date:** 2026-08-13
- **Related:** ADR-0020 (the agent gets a lane, authority is granted per run — this decision
  is what makes its rules 5 and 6 executable), ADR-0019 (one authoritative ledger), AD-1
  (binary data plane + JSON-RPC control plane), AD-8 (one owner per behaviour), beads
  `nocx-x8s2` (the assistant surface), `nocx-dw3` (agent mode), `nocx-reoe` (the
  brainstorming session), `nocx-6jb7` (the stress test).
- **Design:** `.internal/specs/2026-08-13-ai-assistant-surface-design.md` §4.
- **Consulted:** an adversarial review (codex, 2026-08-13) over two rounds. Note what that
  review could and could not do: it had no network access and said so, and it therefore
  treated every claim about eino as a fact supplied by us. It was not.

## Correction — read this before the rest

**The first version of this ADR, written the same day, decided the opposite: that nocx must
write its own agent loop because a framework cannot make a refusal a control decision or
suspend before a domain call for approval. That claim was never verified. It is false.**

It was believed because it is true of a _typical_ ReAct implementation, and because two
readers repeated it to each other — one of them from a summary of a web page, the other with
no network at all. The owner asked the obvious question ("why can't we use eino's loop?"),
and five minutes with the actual module answered it. From `eino v0.9.13`:

```go
// compose/tool_node.go
type InvokableToolEndpoint func(ctx context.Context, input *ToolInput) (*ToolOutput, error)
type InvokableToolMiddleware func(InvokableToolEndpoint) InvokableToolEndpoint
// "can be used to intercept, modify, or enhance tool call execution"

type ToolInput struct {
    Name      string // the tool being called
    Arguments string // and its arguments — before it runs
    CallID    string
    CallOptions []tool.Option
}

// compose/interrupt.go, compose/checkpoint.go
func Interrupt(ctx context.Context, info any) error
func StatefulInterrupt(ctx context.Context, info any, state any) error
type CheckPointStore = core.CheckPointStore
```

A middleware is `func(next) next`, so it is free **not to call `next`**. It receives the
tool's **name and arguments** before execution — which is exactly where authority lives.
And `StatefulInterrupt` suspends the run with persisted state, to be resumed from a
checkpoint.

So every seam the rejected argument said was missing is present, and named.

The lesson is cheap to state and was expensive to learn twice in one document: **assert only
what has been run.** The pi defect in the same design was found by running pi; this one was
created by not running eino. A dependency that a decision turns on gets `go get`, not a
summary.

## Context

The product is gaining an assistant that reads what is on the terminal and, at the next
rung, acts — by calling **our** tools: read a block from the ledger, run a command in the
agent's lane, look at a connection, reach the vault. ADR-0020 requires that authority is a
per-run grant checked at the tool call, that a refusal is a control decision, and that
approval mints a new attempt rather than mutating a running grant.

Four engines were considered. Three are still rejected, and for reasons that were verified:

**`pi --mode rpc`** — a Node subprocess speaking JSONL. Its RPC protocol has a
**client-callable `bash` command that executes even under `--no-tools`**; verified by
running pi 0.84.1 locally with every isolation flag set. The flag bounds what the _model_
may call, not what the _client_ may request. And pi "intentionally does not include
built-in MCP, sub-agents, permission popups" (`docs/usage.md:303`), so our tools would have
had to live as a TypeScript extension **inside pi's process**, calling back into the Go
backend over an IPC channel we would have had to invent. It also costs a Node ≥ 22
prerequisite and a 307 MB package.

**pi's Node SDK in a sidecar we author** — tools, resource loading and in-memory sessions
become structural rather than flags, which is better. Same Node cost, and our domain tools
would still be TypeScript calling back into Go.

**`google.golang.org/adk/v2`** — Go and in-process, but its model implementations are
`gemini`, `openaimodel` and `apigee`: no Anthropic, no Ollama.

## Decision

**1. The loop is eino's.** `flow/agent/react` runs the agent; `compose` provides the graph,
the interrupt and the checkpoint. We do not write a tool-calling loop, an SSE client, or a
provider adapter set. The instruction from the owner is the right one and now has evidence
behind it: reuse the framework, and write only what it cannot give.

**2. The framework gives the mechanism; it cannot give the policy or the capability.** That
distinction is the whole of what stays ours, and it is small.

eino provides the place to intervene (`ToolMiddleware`), the way to pause
(`StatefulInterrupt` + checkpoint), and message blocks for relaying an approval request that
arrives from a remote **MCP** server's protocol (`MCPToolApprovalRequest` /
`MCPToolApprovalResponse`). It has no policy, no grant, no resource scope and no effect
classification — and structurally cannot: those questions ("is this destructive", "does this
cross an environment boundary", "is this lane in scope", "is this path inside the grant") are
asked in terms of _nocx's_ environments, lanes, connections, vault and ledger. A general
framework has no vocabulary for them because they are not general. The same is true of the
**capability** a tool holds: eino can pass a tool a context; what is inside that context is
ours by definition.

So what we write is two small things over our own types — a function that answers
permit/ask/refuse, and a constructor for a narrowed capability — wired in at the framework's
own seam. `adk.TypedChatModelAgentMiddleware` offers three places to put them, and the grant
uses all three, strongest first:

- **`BeforeAgent`** — it "allow[s] modification of the agent's instruction and tools
  configuration". A tool the run's grant does not permit is **never declared to the model**.
  The strongest form of refusal is the one that is never proposed.
- **`BeforeModelRewriteState`** — `ToolInfos` is modifiable before each model call, so a
  scope that narrows mid-run narrows what is on offer at the next iteration.
- **`WrapInvokableToolCall(ctx, endpoint, tCtx *ToolContext)`** — "called at request time
  when the tool is about to be executed". This is where the arguments are visible and where
  the three outcomes live:

- **refuse** — do not call `next`; the run terminalizes with a recorded reason. A refusal
  handed back as an ordinary tool result would let the model improvise around it: retry, a
  broader tool, or the same effect encoded as a shell command.
- **escalate** — `StatefulInterrupt` **before** calling `next`, so nothing has touched the
  domain while a human decides; approval resumes from the checkpoint as a **new attempt with
  a new grant**, never by mutating a running one (ADR-0020 §5).
- **permit** — call `next`, with the tool holding a narrowed capability (decision 4).

**3. The grant is over resources and effects, never over tool names.** A grant that says
"may call `run-command`" permits nothing in particular and everything in general: one
command tool reaches files, the network, ssh, other processes and the vault. A grant names
environments, lanes, paths, destinations and effect classes — the lattice ADR-0020 §6
already defines. `ToolInput.Arguments` is why this is enforceable at the middleware: the
arguments are visible before execution.

**4. The dispatcher narrows; it does not check.** A check before the call is advisory,
because the tool still holds a full session manager, the vault and the filesystem. The
middleware resolves the run's grant into a **scoped capability** and the tool holds only
that — so it cannot exceed the grant, because it never has more than it. Package privacy is
not a substitute: Go's `internal` stops another package naming a symbol, not code in the
same package calling it, and such a test rots at the first refactor.

**5. The ledger stays ours, and the framework's state is a projection.** eino owns run
mechanics; ADR-0019 owns the record. Its checkpoints, message history and retries are
implementation detail of a run, never the authoritative transcript, and nothing in the
product reads them to answer "what happened".

**6. Credentials are the vault's.** An endpoint record holds an opaque secret reference
(ADR-0016, ADR-0017), never a key. Endpoints are OpenAI-compatible by default, on a base URL
the user sets, which reaches local models (Ollama, llama.cpp) — so a frame need never leave
the machine, which is `vision.md:75`.

## Rationale

Everything a framework offers here — provider adapters, SSE, streamed tool-call assembly,
the ReAct iteration — is work we would otherwise do badly and maintain forever. What is
specific to this product is not the loop; it is _who is allowed to do what_, and that turns
out to fit the seam the framework already exposes.

Writing our own would have bought exactly one thing over `ToolMiddleware` + `StatefulInterrupt`:
the feeling of ownership. It would have cost an SSE client, per-provider quirks, and a
second implementation of iteration that is already written and tested.

## Consequences

- **A real dependency, measured rather than argued.** `eino/compose` plus
  `flow/agent/react`, with **no provider adapter yet**, is 78 modules in the graph and 126
  packages compiled — including sonic, gonja, json-iterator, easyjson and **logrus**. The
  last one collides with our rule that structured logging goes through one `log/slog`-backed
  interface, and must be checked before adoption rather than after.
- **We inherit an upgrade cadence we do not control** on the most security-sensitive path in
  the product. The middleware and the interrupt are the two APIs we depend on; a change to
  either is a break, and the tests that prove refusal and narrowing are what will catch it.
- **No subscription logins.** pi offers Claude Pro/Max, ChatGPT via Codex and Copilot; we
  cannot, and the entry price is an API key or a local model.
- **No Node runtime, no bundled engine, nothing to install.** The assistant is a capability
  of the binary.
- **EXPLAIN and agent mode are one driver with two run modes** — differing in tools declared,
  termination and context assembly — rather than two engines.

## Alternatives considered

**Drive an external agent CLI (pi, omp) headlessly.** Rejected: authority cannot be enforced
across the process boundary, our tools would live in another language inside another
process, and the packaging cost is a Node prerequisite.

**Write our own loop over provider SDKs.** Rejected — and this is the reversal recorded at
the top. It was chosen on the false premise that a framework cannot refuse before execution
or suspend for approval. With `ToolMiddleware` and `StatefulInterrupt` verified, it buys
nothing and costs an SSE client, provider normalisation and a second implementation of
iteration.

**Use eino only as the model/provider adapter layer, with our own loop above it.** Rejected
for the same reason, one notch weaker: the loop is the part we would have had to write, and
the seams we needed are in the loop.

**Write no loop at all and ship only EXPLAIN.** Rejected by the owner: asking the assistant
to _do_ something is part of the product, and deferring it would mean two backends later.

## Not decided here

Whether `logrus` in the dependency graph is acceptable or must be contained. Which provider
adapters ship beyond the OpenAI-compatible one. The concrete approval UI. Multi-agent lanes.
Whether an endpoint's capabilities are probed on save, on first use, or both.

## Revisit when

eino changes `ToolMiddleware` or the interrupt API — those two are the whole of what this
decision leans on — or when its dependency graph grows into something a desktop binary
should not carry.
