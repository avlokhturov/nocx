# ADR-0028 — The agent loop is ours; the model client is replaceable

- **Status:** Accepted
- **Date:** 2026-08-13
- **Related:** ADR-0020 (the agent gets a lane, authority is granted per run — this decision
  is what makes its rules 5 and 6 executable), ADR-0019 (one authoritative ledger), AD-1
  (binary data plane + JSON-RPC control plane), AD-8 (one owner per behaviour), beads
  `nocx-x8s2` (the assistant surface), `nocx-dw3` (agent mode), `nocx-reoe` (the
  brainstorming session), `nocx-6jb7` (the stress test).
- **Design:** `.internal/specs/2026-08-13-ai-assistant-surface-design.md` §4.
- **Consulted:** an adversarial review (codex, 2026-08-13) over two rounds, which supplied
  the refusal-is-not-a-tool-result argument, the capability-narrowing correction, and the
  observation that a framework arrives owning run state the ledger already owns.

## Context

The product is gaining an assistant that reads what is on the terminal and, at the next
rung, acts — by calling **our** tools: read a block from the ledger, run a command in the
agent's lane, look at a connection, reach the vault.

The obvious move is to take an existing agent engine and drive it. Four were considered
seriously, and each was eliminated by a fact rather than a preference.

**`pi --mode rpc`** — a Node subprocess speaking JSONL. Its RPC protocol has a
**client-callable `bash` command that executes even under `--no-tools`**; verified by
running pi 0.84.1 locally with every isolation flag set. The flag bounds what the _model_
may call, not what the _client_ may request. And pi "intentionally does not include
built-in MCP, sub-agents, permission popups" (`docs/usage.md:303`), so our tools would have
had to live as a TypeScript extension **inside pi's process**, calling back into the Go
backend over an IPC channel we would have had to invent. It also costs a Node ≥ 22
prerequisite and a 307 MB package.

**pi's Node SDK in a sidecar we author** — better, because tools, resource loading and
in-memory sessions become structural rather than flags. Same Node cost, and our domain
tools would still be TypeScript calling back into Go.

**`google.golang.org/adk/v2`** — Go and in-process, but its model implementations are
`gemini`, `openaimodel` and `apigee`: no Anthropic, no Ollama.

**`cloudwego/eino`** — Go, Apache 2.0, streaming central, and `eino-ext` has `claude`,
`ollama`, `openai`, `openrouter` and more. It fails on the part that matters: its stock
ReAct loop treats a policy refusal as an ordinary tool result, and offers no way to
**suspend before a domain call** while a human approves. ADR-0020 requires both.

That last point generalises past eino, and it is the whole of this decision.

## Decision

**1. nocx owns the agent loop.** `internal/agent` holds the run modes, the policy, the
attempts and the tool dispatcher. No agent framework is a dependency.

The reason is that ADR-0020 puts the loop **inside the security boundary**:

- **A refusal is a control decision, not a value returned to a model.** Handing back
  "permission denied" as a tool result lets the model improvise around it — retry, pick a
  broader tool, or encode the same effect as a shell command. So a refusal **terminalizes
  the run**, with a recorded reason the user sees.
- **An escalation must stop the loop before any domain call**, obtain approval, and then
  **mint a new attempt with a new grant** — because approval may not mutate an executing
  run's grant (ADR-0020 §5).

A framework would also arrive owning what the ledger owns: when a run is finished, retries,
conversation memory. And retrying a failed model request is not the same as retrying a tool
whose effect may already have happened.

**2. The grant is over resources and effects, never over tool names.** A grant that says
"may call `run-command`" permits nothing in particular and everything in general: one
command tool reaches files, the network, ssh, other processes and the vault. A grant names
environments, lanes, paths, destinations and effect classes — the lattice ADR-0020 §6
already defines.

**3. The dispatcher narrows; it does not check.** A check before the call is advisory,
because the tool still holds a full session manager, the vault and the filesystem. Instead
the dispatcher resolves the run's grant into a **scoped capability** and hands the tool
that, so the tool cannot exceed the grant because it never holds more than it. Package
privacy is not a substitute: Go's `internal` stops another package naming a symbol, not code
in the same package calling it, and such a test rots at the first refactor.

**4. Underneath the loop is one `Model` interface, and its first implementation speaks
OpenAI Chat Completions over HTTPS + SSE.** It is given messages and declared tools and
returns a stream; it knows nothing about the ledger, grants or frames. One protocol reaches
local models (Ollama, llama.cpp, LM Studio, vLLM) — so a frame need never leave the machine,
which is `vision.md:75` — and any hosted provider on a base URL the user sets.

The interface is not as narrow as "text deltas and proposed calls": the loop cannot decide
whether a response completed, whether a proposed call is whole, or whether a retry is safe
without the finish reason, tool-call ids, usage, the model actually served, the provider's
request id, and whether an error is retryable.

**5. A second implementation goes behind that interface, and the expected one is Anthropic
Messages at the agent rung** — chosen for the shape of the wire rather than the provider: it
halts at `tool_use` and waits for `tool_result`, so the protocol itself pauses exactly where
policy must take control. Any third-party adapter set is judged by measurement —
`go list -deps`, module size, stripped binary size — not by argument.

**6. Credentials are the vault's.** An endpoint record holds an opaque secret reference
(ADR-0016, ADR-0017), never a key.

## Rationale

The engine question looked like "which framework", and it was not. For the EXPLAIN rung an
agent is not needed at all — one call and a stream. For the agent rung, everything a
framework offers is the easy half; the hard half is refusal, escalation, attempts, grants
and durable run state, and all of it is specific to this product. A framework cannot erase
that work, only hide it until the first edge case.

The deciding constraint was the tools. If the tools are our domain objects, then a loop in
another process turns every tool call into an invented IPC boundary, with the grant check on
the far side of a pipe from the thing it protects. In Go the check is a function call next
to the thing it protects — or, better, no check at all, because the tool holds only what it
is allowed to reach.

## Consequences

- **No subscription logins.** pi offers Claude Pro/Max, ChatGPT via Codex and Copilot; we
  cannot, and the entry price is an API key or a local model. This is the real cost of the
  decision and it was accepted deliberately.
- **We own an SSE client**, including framing across chunk boundaries, incremental tool-call
  assembly, deadlines, cancellation, bounded buffers and backpressure. It is the most likely
  thing to be underestimated.
- **"OpenAI-compatible" is not one protocol.** Endpoints differ on streamed tool arguments,
  parallel calls and usage. Capability is verified per endpoint, not assumed from a single
  readiness probe.
- **No Node runtime, no bundled engine, nothing to install.** The assistant is a capability
  of the binary.
- **EXPLAIN and agent mode are one driver with two run modes** — differing in tools declared,
  termination and context assembly — rather than two engines.

## Alternatives considered

**Drive an external agent CLI (pi, omp) headlessly.** Rejected: authority cannot be enforced
across the process boundary, our tools would live in another language inside another
process, and the packaging cost is a Node prerequisite.

**Adopt a Go agent framework and use its loop.** Rejected for the same reason in a nicer
package: the loop is where this product's security semantics live, so it cannot be the
framework's.

**Use a framework only as the model/provider adapter layer.** Not rejected — deferred to
measurement. It remains available behind the `Model` interface, and nothing above that
interface would change.

**Write no loop at all and ship only EXPLAIN.** Rejected by the owner: asking the assistant
to _do_ something is part of the product, and deferring the loop would mean two backends
later.

## Not decided here

Which providers ship beyond the first OpenAI-compatible client. The concrete approval UI.
Multi-agent lanes. Whether an endpoint's capabilities are probed on save, on first use, or
both.

## Revisit when

A provider we need speaks a protocol the `Model` interface cannot express without leaking
provider concepts upward — at which point the interface is what widens, not the loop.
