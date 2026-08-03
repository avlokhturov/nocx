# The command surface: activity ledger, memory, and semantic input — design

- **Date:** 2026-07-31 (v6: 2026-08-01)
- **Revision:** v6 — v3 after adversarial review (§15 records where this design rejects that
  review), then a pain-map pass that moved the centre of gravity to **before Enter** (§10), then re-sequenced in §12 around the owner's near-term goal: history, highlighting, hints; then v6 after an owner review that grepped the code and found §7 was solving a problem the product does not have
- **Status:** Accepted for the storage and capture decisions (§5, §7, §9); the rest remains
  the standing design
- **Session bead:** `nocx-w6oq` (Brainstorming: command blocks — history, syntax, semantic input)
- **Related epics:** `nocx-4ff` (command input & blocks), `nocx-2gf` (CM6 editor core),
  `nocx-de7` (authoritative output capture), `nocx-w7h` (semantic command line — re-scoped
  here), `nocx-dw3` (agent mode — not built here, but its seams are)
- **Binding contracts:** [ADR-0004](../../docs/decisions/0004-input-ownership-and-editor-abstraction.md)
  (input ownership + pluggable editor; **§8.2 obeys its rejection of magic prefixes**),
  [ADR-0006](../../docs/decisions/0006-marker-only-prompt-mode.md) (marker-only prompt),
  [ADR-0011](../../docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md)
  (three storage capabilities; secrets as opaque references),
  [ADR-0017](../../docs/decisions/0017-a-connection-references-a-secret.md) (a connection
  references a secret — and §9.2 here reuses its `sec:v1:…` reference verbatim),
  [ADR-0018](../../docs/decisions/0018-contentdb-engine-and-encryption-at-rest.md)
  (**SQLite + SQLCipher, its own key outside the vault's seal** — §5 defers to it),
  AD-6 (single-owner state), AD-7 (session model), AD-8 (interface-first + DI).
- **Requires an amendment:** **AD-1** — see §6.1. This design cannot be built without it,
  and it must be changed in `docs/architecture.md` deliberately rather than routed around.
- **Binding specs:** [2026-07-25-editor-core-codemirror6-design.md](2026-07-25-editor-core-codemirror6-design.md)
  (the CM6 swap — designed there, executed in `nocx-2gf`),
  [2026-07-24-warp-editable-command-input-design.md](2026-07-24-warp-editable-command-input-design.md)
  (input-ownership safe-enable).
- **Feeds:** `nocx-4ff.25` — the open ADR that ratifies the model. §16 is its invariant list.

### What changed in v6

Six changes. The first is the largest correction this document has taken, and it came
from doing what §13 says to do and this document did not: grep for the caller.

- **§7 is rewritten. Output is not captured from the byte stream.** `blocks.ts:671`
  already calls `serializeRange(snapshot, getLine, rec.startLine, endLine)` on OSC 133 D
  — the product has been producing each block's text from the xterm buffer, bounded by
  its own markers, since the DOM scrollback landed. Buffer and markers are on the _same_
  clock, so the two-clock problem of v5's §7.2 does not exist on that path; it was
  created by the choice to capture at `ipc.ts`. The streaming recognizer (§7.3) and the
  alt-screen special case (§7.4) were both solutions to that self-inflicted problem and
  are deleted. **Invariant 9 in §16 is withdrawn.**
- **Storage is decided, in an ADR.** SQLite with SQLCipher, one encrypted file holding
  metadata, chunks and the FTS index, and a ContentDB key of its own in the OS keychain
  that is **not** governed by the vault's auto-seal — because a sealed vault must never
  mean an amnesiac terminal. §5.5's "plaintext with 0600" is superseded;
  [ADR-0018](../../docs/decisions/0018-contentdb-engine-and-encryption-at-rest.md) holds
  the reasoning, the rejected engines and the honest threat model. §17.2 closes.
- **Secret bindings reuse `sec:v1:…`, they do not invent a format** (§9.2). The reference
  already exists in `internal/vault/id.go`, is persisted protocol, and is minted only by
  the Vault. What is new is two things: byte spans stored beside `intent` so substitution
  is never a text search, and a history entry counting as a referrer so retention cannot
  silently delete a secret still in use.
- **Privacy gets three levels, and the first one is thirty-five years old** (§9.1). A
  leading space suppresses the entry entirely — `HISTCONTROL=ignorespace` is already
  muscle memory, and it is exactly the "one keystroke for run privately" §9 asked for.
  A confident matcher asks; an unconfident one retains without indexing. §17.3 partly
  closes.
- **The budget is two numbers, not one** (§5.4). `DELETE` reduces logical content and not
  the file, and WAL can exceed the main database. A UI that promises 5 GB over a 12 GB
  file on disk has shipped a defect.
- **Capture is gated on `criticality`** (§3.5). The facet already exists and is already
  user-set for §10.2's guardrail; it now does double duty, so the most dangerous output
  never enters the store at all — by a decision made once on a connection profile rather
  than by a heuristic over text.

Four holes this revision names without closing, each now a bead: the FTS indexing unit
for chunked output, the loss policy when the outbox overflows, the durable watermark that
makes §5.4's coverage claim computable after eviction, and the schema-v1 defects in
§5.2's fine print.

**Then §8 was reviewed the same way, and it was in worse shape than §7.**

- **A capability that cannot be built was promised.** "`Tab` falls through to the shell as
  a real completion request" (§8.7) is impossible: the editor owns the text, ADR-0004 hands
  the line over atomically at submit, so the shell's buffer holds something else and a raw
  `\t` completes it. Withdrawn, replaced by three real options in §17.1. Nothing may promise
  shell-native completion until one is built.
- **Labelling a dangerous irrelevance is not safety** (§8.5). A local PATH candidate offered
  inside an SSH session is wrong even when it says "local". Applicability became part of the
  provider contract: a provider declares where it applies and is not consulted elsewhere.
- **§8 had no types.** `Candidate` was a word, provider merge had no rules, ranking features
  were named without semantics, and the overlay had no state machine or keyboard arbiter.
  §8.9 adds all four, because a worker given only §8.1–§8.8 builds a plausible popup that is
  wrong in multiline, remote and stale-async — which are the only cases that matter.
- **§12 contradicted itself about E6**, promising a session-scoped increment in the table
  and calling it shipped pain in the paragraph below. Resolved by the rung indicator: the
  surface ships early and says "this session only", because a history that states its scope
  is honest and one that looks complete is not.
- **The signature interaction is named** (§8.10): **Provenance Recall** — pick a past
  command and, before it runs, see why this one and what changed since. Outcome ranking
  alone is invisible, the guardrail alone is another warning, search over output is post-hoc;
  this is the one moment where `Environment`, `confidence`, `status` and `edges` pay off
  together, and it sits inside tracks E and M.
- **Highlighting does not justify CM6 on its own** (§8.6). A mirrored highlight layer behind
  the existing textarea delivers it with none of the prompt-line risk, and ADR-0010 must
  weigh both rather than inherit the answer.

### What changed in v4

Five changes, from mapping the pains against the model rather than reviewing the model
against itself:

- **Retention inverted and became a setting.** v3 kept derived text only for failed, slow,
  recent and pinned entries. That silently broke the strongest feature the model enables —
  search cannot find what retention discarded — so text is now retained for every entry,
  head-and-tail capped, inside a **budget the user owns** (§3.5, §5.4). Search states its
  coverage rather than answering "not found" for something it merely stopped keeping.
- **Search over output became a first-class item** (§10.7) and moved into the memory slice,
  which reordered §12: capture must precede it, and privacy must precede indexing.
- **§9 grew a second half.** Secrets arrive in _output_ that was never typed (`env`,
  `kubectl get secret`), which composition-time detection cannot see by construction — and
  retaining and indexing output is what makes that leak reachable (§9.1).
- **The guardrail** (§10.2): environment shown before a destructive command, with
  confirmation escalating on **where you are** — `criticality`, elevated privilege, unknown
  confidence — not on how the command looks. A warning that fires on the verb is trained away
  before it is needed. Adds `criticality` to `Environment`.
- **§10 reordered around the moment before Enter**, and the environment indicator promoted to
  first: without it, `confidence` is a field nobody benefits from.

### What changed in v3

Eleven changes, each because the previous revision was wrong rather than incomplete:
`internal/content` already exists as a stub and is now built on rather than invented (§1.4);
AD-1 is amended explicitly instead of quietly violated (§6.1); the durable context key drops
`sessionId` for a stable `Environment` with facets and confidence (§3.1); relations become a
first-class table (§3.4); artifacts split into raw and derived with selective durability
(§3.5); `status` gains `pending` so `phase='open'` stops claiming a command is running
(§3.7); every lifecycle event carries the immutable envelope, so an out-of-order close can
create its row (§6.2); ordering moves to a backend `seq` (§6.3); a client outbox survives
reconnect (§6.4); sigils are removed in favour of an explicit target switch (§8.2); privacy
is decided before PTY handoff rather than redacted at write (§9).

---

## 1. What is actually true today

### 1.1 The scrollback and the ledger are built, wired, and reachable

`frontend/src/scrollback/` holds `blocks.ts` (BlockManager: running and frozen blocks,
overflow menu, selection), `controller.ts` and `serializer.ts`, each with tests.
`frontend/src/command-ledger.ts` implements ADR-0008's landmark model — app-owned command
text, cwd, host, trust logic mirroring `input-state.ts`.

The reachability check this repo requires passes: `terminal-content.ts:232` constructs
`new CommandLedger(...)`, `terminal-content.ts:283` feeds it every OSC 133 marker, and the
editor's `submit` callback (~`terminal-content.ts:240`) calls `ledger.open(...)` and binds
an xterm `IMarker` to the record. This is not the vault situation — the ledger is in the
product.

What it is not, is durable. `CommandLedger` is an in-memory array with a `_nextId` counter,
scoped to one `TerminalContent`. Close the tab and the work is gone.

### 1.2 The editor exists only while the shell vouches for it

`input-state.ts:5` defines `RAW | PROMPT_READY | RUNNING_RAW | ALT_SCREEN`, and `reduce()`
grants `owned: true` only on a clean A→B (`input-state.ts:77-85`).
`terminal-content.ts:307-310` subscribes and calls `shouldShowEditor(m.owned, …)`.

No shell integration, no editor. That is correct for a command line — you cannot safely own
a line you cannot locate — and wrong for everything else the surface is about to do (§8.1).

### 1.3 The transport carries bytes, and `write()` is asynchronous

`internal/transport/ws.go:1246` writes `websocket.BinaryMessage` frames.
`frontend/src/ipc.ts:205-214` receives `ArrayBuffer`, counts `byteLength` for the AD-9
offset, and only then decodes through a `UTF8StreamDecoder`. Raw bytes exist at a real,
named point before xterm sees them.

Two facts that shape §7. The decoder is a _streaming_ decoder with an explicit `reset()`,
so the decoded path is lossless for valid UTF-8 and degrades only on invalid sequences —
"the string path loses bytes" is not the argument for capturing bytes. And `term.write()`
is **asynchronous**: xterm buffers and parses on a scheduled task, deliberately yielding
under load.

### 1.4 ContentDB is not a plan — it is a stub that already exists

`internal/content/` holds `content.go`, `stub.go` and `stub_test.go`. `content.go:36`
declares the capability:

```go
type ContentDB interface {
    Conversations() ConversationRepository
    CommandHistory() CommandHistoryRepository
    Close() error
}
```

with `ErrNotImplemented` returned by every stub method, and a `CommandStatus` string type
whose comment states it mirrors the closed set in `frontend/src/command-ledger.ts:10`.

This is ADR-0011 §5 executed exactly as written: the capability declared, the repository
interfaces present, the SQLite dependency absent until a feature needs it. **This design is
that feature**, and §5 fills in the stub rather than inventing a package. The earlier
revision of this document did not grep for it and proposed creating what already existed.

ADR-0011 §1 also settles the routing question the earlier revision got wrong: `DocumentStore`
is atomic JSON for bounded, human-repairable configuration; `SecretStore` is the keychain;
**`ContentDB` is the one SQLite database for unbounded, query-oriented private content**,
and the ADR's own diagram names its two tenants — _Conversations_ and _History_.

### 1.5 The known tension, unchanged

ADR-0008 (accepted) says "a ledger of landmarks, not cards"; the code implements DOM cards
_and_ the ledger. The pivot is recorded on `nocx-4ff`, but the ratifying ADR (`nocx-4ff.25`)
is still open. This design treats the DOM card model as settled and widens what
`nocx-4ff.25` must ratify (§16).

---

## 2. The north star

### 2.1 The one thing

> **nocx is the terminal that remembers the work, not the screen.**

The signature moment, which no competitor's data model can produce: close every tab, come
back tomorrow, and ask — _what did I run on prod in `/srv/api` before the deploy failed?_ —
and get the environment, the command, the useful output, the failure, the correction that
worked, and a guarded rerun in the right place.

Everything else in this document is either that, or a seam that keeps that possible.

The reason a local-first product wins here is not ideology. It is that the memory can be
**complete** precisely because it never has to leave the machine: no account, no upload path,
no "we promise not to sync this field". A cloud-shaped competitor cannot match completeness
on production infrastructure, because its customers' security teams will not let it.

### 2.2 What that implies about build order

Syntax highlighting, Spotlight-style actions and ambitious completion are not the first
increment. Durable contextual memory is, shipped as one vertical feature: recall, search,
the attention queue, and rerun with provenance (§12). An agent built on top of that inherits
a coherent model of the user's work; an agent built first is another clever panel beside a
terminal that still forgets.

### 2.3 The editor is an intent surface, not a command line

The surface will accept shell commands, hold a dialogue with an agent, and plausibly invoke
application actions. The primitive is therefore not "a command" but an **intent** the user
submits, which the application resolves to a target, executes under a lifecycle, and records.

### 2.4 One timeline, many kinds — and the limit of that claim

Every submitted intent becomes an **Entry** with one identifier, one lifecycle vocabulary,
one payload seam and one query surface. Blocks render entries; recall returns entries;
search finds entries; the agent's context is a slice of entries.

The honest limit, and the correction that v3 makes: **a flat chronology is a projection, not
an ontology.** "This success is the edited successor of that failure", "this agent answer
cites those two outputs", "this restart was caused by that alert" are _relations_, and a
list of rows cannot hold them. v3 adds edges as a first-class table (§3.4). The timeline,
the session view, an incident view and a conversation are then all projections over
`entries + edges`.

### 2.5 What is deliberately not built

Agent mode, actions, FTS and search UI, remote completion, job control. Seams only. §14 is
the full list, and §12 is where each one would land.

### 2.6 The seam test, and its limit

> When the second kind arrives, which module changes?

If the answer is _the terminal controller_, _the BlockManager_, _the RPC namespace_ or _the
table schema_, the seam is missing. This is a heuristic, not a law: a genuinely new kind
should sometimes make the shared model grow, and forcing agent tool hierarchies through an
interface shaped by OSC markers would buy a leaky abstraction at the price of a good one.
The target is **localised, intentional evolution** — not zero evolution.

---

## 3. Domain model

### 3.1 `Environment` — durable context identity, with stated confidence

The earlier revision keyed context on `(sessionId, host, cwd)`. That is wrong twice over.
`sessionId` is server-authoritative and dies with the session (AD-7), so filtering durable
recall by it defeats the entire point of durability. And `host` collapses user, port, jump
route, connection profile, container, and every nested execution environment into one
string.

An **Environment** is a stable identity for _where work happens_:

| Field         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | stable, derived from the facets below — never from a session                   |
| `kind`        | `local \| ssh \| container \| unknown`                                         |
| `endpoint`    | canonical `user@host:port` for ssh; null for local                             |
| `profileId`   | the connection profile, when the session came from one                         |
| `facets`      | `repoRoot`, `branch`, `containerId`, `k8sContext`, `namespace`, `privilege`, … |
| `confidence`  | `asserted \| derived \| unknown`, **per facet**                                |
| `criticality` | `routine \| sensitive \| critical` — user-set, or inherited from the profile   |

`cwd` stays on the entry — the environment is _where_, cwd is _where within_.

`criticality` is a separate column rather than a facet because it is the only field that
_gates_ behaviour rather than describing it: §10.2's confirmation escalates on it, and a
value buried in a JSON blob cannot be queried or indexed. It is user-owned — a checkbox on a
connection profile and a menu item on an environment — because no derivation can reliably
tell a production host from a staging one, and guessing wrong in either direction is worse
than asking once.

**Confidence is not decoration, it is the honest half of the model.** With marker-only shell
integration (ADR-0006), `ssh → container → sudo → kubectl` is a stack nocx can only partly
see. OSC 7 yields a path and a host-shaped claim, not an environment. The surface must be
able to say "known outer SSH host; inner context unknown" rather than assert a precision it
does not have — and recall that silently pretends otherwise is worse than no recall, because
it invites running the right command in the wrong place.

`sessionId` survives as one optional execution facet on the entry. It is never a recall key.

### 3.2 `Entry`

| Field                                  | Meaning                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `id`                                   | client-minted UUIDv7 — identity and the idempotency key                     |
| `seq`                                  | backend-assigned monotonic sequence — **the only total order** (§6.3)       |
| `environmentId`                        | §3.1                                                                        |
| `sessionId`                            | runtime execution facet, nullable, never a recall filter                    |
| `cwd`                                  | from OSC 7 at submit                                                        |
| `kind`                                 | `shell \| agent \| action` (§3.3)                                           |
| `intent`                               | app-owned submitted text — never scraped from the screen                    |
| `phase`                                | `open \| bound \| closed` — owned by the driver (§4)                        |
| `status`                               | `pending \| running \| success \| failure \| interrupted \| unknown` (§3.7) |
| `conversationId`                       | agent grouping; null otherwise (§3.6)                                       |
| `submittedAt`                          | backend wall clock, for display only                                        |
| `startedAt` / `endedAt` / `durationMs` | frontend monotonic clock — durations only                                   |
| `sensitivity`                          | `normal \| sensitive`, decided **before** handoff (§9)                      |
| `payload`                              | kind-specific, schema-versioned JSON (§3.3)                                 |

Two decisions worth stating. **`exitCode` and `trusted` are not top-level fields** — they
are shell facts, and hoisting them makes every other kind carry nulls. **Time comes from two
clocks on purpose**: durations from the frontend's monotonic clock (`command-ledger.ts`
already injects `performance.now()` and forbids `Date.now()`), because a wall clock that
jumps produces negative durations; ordering from `seq`, because two windows can submit in
the same millisecond and wall time is not a key.

### 3.3 Kind payloads

```ts
type EntryPayload =
  | { kind: 'shell'; v: 1; exitCode: number | null; trusted: boolean; markers: MarkerTrace }
  | {
      kind: 'agent'
      v: 1
      model: string
      tokensIn: number
      tokensOut: number
      toolCalls: ToolCallRef[]
    }
  | {
      kind: 'action'
      v: 1
      actionId: string
      effect: EffectLevel
      approval: ApprovalState
      result: Json | null
    }
```

Only the `shell` arm is implemented. The others are shown because a union with one arm is
indistinguishable from a struct, and the point is that adding an arm is a local change.

Each payload carries a schema version `v`. The discriminator stays a closed set on purpose —
see §15 for why this design declines the "open type-id" alternative.

`action` carries `effect` and `approval` because "opened a file" and "deleted a deployment"
are not the same object with different JSON, and a receipt that cannot distinguish them is
not a receipt.

### 3.4 `Edge` — the relation primitive

```ts
type Relation = 'rerun-of' | 'supersedes' | 'caused-by' | 'cites' | 'in-span'
interface Edge {
  from: EntryId
  to: EntryId
  rel: Relation
}
```

This is the addition that makes §10 possible and without which most of it is not:

- `rerun-of` / `supersedes` — command lineage: a failure, its edited retry, the variant that
  worked. Recall can then offer the _best known_ member of a family instead of the most
  frequent one, which is how frequency-ranked history reliably promotes mistakes.
- `caused-by` / `cites` — an agent answer that cites the output it read; a command run
  because of a failure above it.
- `in-span` — grouping across sessions and hosts, which is what an "incident" is.

Edges are cheap (one narrow table), and they are the difference between a log and a memory.

### 3.5 Artifacts: raw, derived, and selectively durable

An artifact is what an entry _produced_, as opposed to the facts about it.

```ts
interface Artifact {
  id: ArtifactId
  entryId: EntryId
  mediaType: 'application/vt' | 'text/plain' | 'text/markdown' | 'application/json'
  derivedFrom: ArtifactId | null
  state: 'open' | 'sealed'
  truncated: { reason: 'cap' | 'gap' | 'suppressed' } | null
}
```

Three rules, and the second and third are corrections to v2.

**1. Durability is a policy on the media type, not a global property.** `text/markdown` and
`application/json` are durable — an agent turn whose text is discarded on restart is not a
transcript, and there the artifact _is_ the content. `application/vt` is session-local by
default: VT byte streams are large, secret-bearing, and meaningful only replayed into a
terminal.

**2. Raw VT is not what consumers want, and pretending otherwise was a mistake.**
`blockOutputText`, copy, search, diff and agent context all need _normalized text_, not an
escape-sequence stream. So the normalization is explicit: `application/vt` →
`text/plain` via a derived artifact carrying `derivedFrom`, produced on the frontend (AD-6
holds — the backend never parses the stream). Derived text is what §10's lenses,
comparisons and search consume.

**3. Retention is the user's budget, and the per-entry cap is what makes it predictable.**

v2 retained derived text only for failed, slow, recent and pinned entries. That looked
frugal and quietly broke the feature that justifies the whole design: **search cannot find
what retention threw away** (§10.7). "Where did I see that `EACCES`?" answers _nowhere_
precisely when the command succeeded, ran fast, and was three weeks ago — which is the
common case for the question.

So the rule inverts. Derived text is retained **by default for every entry**, and how much
and for how long is a **setting the user owns** (§5.4). What keeps that affordable is not a
class filter but a **per-entry cap: the head and the tail are kept, the middle is dropped**,
sealed with `truncated='cap'`. Errors live in the tail, the invocation and its first
diagnostics in the head, and a million lines of progress bar in between are of no value to
anyone. This bounds the budget almost independently of what the user runs, which a
line-count cap does not.

| Artifact                                              | Default                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `text/plain`                                          | **durable for every entry**, head+tail capped, user budget |
| serialized block HTML                                 | session-local; promoted to durable only by an explicit pin |
| `text/markdown`, `application/json`                   | durable — there the artifact _is_ the content              |
| leading space, sensitive, `do-not-record`, alt-screen | not captured at all (`truncated='suppressed'`)             |
| environment marked `critical`                         | **not captured** — intent and metadata only (§7.4)         |

_v6 note: the pinned row was `application/vt` in v5. With capture happening at block
freeze rather than in the byte stream (§7.1), there is no durable raw-VT artifact to
promote — a pin retains the serialized HTML with its theme snapshot, which is what the
frozen block already holds. Alt-screen needs no rule of its own any more; it is excluded
by construction._

A pinned entry's artifacts are exempt from eviction: a capsule whose content can be evicted
underneath it is a broken promise, not a bounded cache.

### 3.6 An Entry is not a Conversation

ADR-0011 lists _Conversations_ and _History_ as separate tenants with separate repositories,
and the stub at `internal/content/content.go:36` already exposes them as two accessors. They
are different levels: an **entry** is a unit of the timeline; a **conversation** is a thread
over agent entries with ordering for model context, a title and a branch point. Agent entries
carry `conversationId`; the conversation table owns threading.

Stating this prevents both failure modes a worker would otherwise pick: collapsing threads
into the timeline, or standing up a second timeline for the agent.

### 3.7 `phase` and `status`

| phase    | meaning                                      | shell trigger      |
| -------- | -------------------------------------------- | ------------------ |
| `open`   | intent accepted, execution **not** confirmed | Enter pressed      |
| `bound`  | execution confirmed and attributed           | OSC 133 C          |
| `closed` | outcome known, artifacts sealed              | OSC 133 D, or §4.3 |

`status` starts **`pending`** — not `running`, which v2 asserted while simultaneously
defining `open` as "execution unconfirmed", and which the existing `command-ledger.ts`
already gets right by starting at `unknown`. It becomes `running` at `bound` and takes its
final value at `closed`. Nothing named `submitted` enters the status vocabulary.

---

## 4. Lifecycle is owned by a driver

### 4.1 The interface

Today the cycle lives inside `terminal-content.ts:283`'s marker callback, which knows about
OSC 133, the ledger, the scrollback and the input machine at once — exactly the module §2.6
says must not change when the second kind arrives.

```ts
export interface EntryDriver {
  readonly kind: EntryKind
  /** Accept an intent. Returns a PROVISIONAL entry synchronously — the UI shows it now. */
  open(intent: string, ctx: EnvironmentRef): ProvisionalEntry
  /** Phase transitions in the driver's own vocabulary. */
  onPhase(cb: (id: EntryId, phase: Phase, facts: Partial<EntryPayload>) => void): void
  /** Close everything still open. Session exit, teardown, timeout, interrupt. */
  abandon(reason: 'session-exit' | 'teardown' | 'timeout' | 'interrupt'): void
}
```

`open()` returns a **provisional** entry, and that word is load-bearing. v2 had it return the
durable record, whose `seq` and `submittedAt` are backend-assigned and therefore arrive
later; the only way to honour that signature is to await the store before running the
command, which §4.5 forbids outright. A provisional entry has its client-minted `id` and its
local timestamps, renders immediately, and is reconciled when acceptance returns.

The terminal controller's remaining job is one line: forward markers to `ShellDriver`.

### 4.2 `ShellDriver` is the existing cycle, moved

`command-ledger.ts` already solves submit→C correlation correctly: `open()` at submit, L2
("open while a record is still running finalizes the old one"), trust bound at C from
`sawCleanA && sawB`, finalization at D, L1 ("D with no exit code → `unknown`, not
`failure`"), B3 (`finalizeOpen`). That logic is kept verbatim and re-homed behind
`EntryDriver`. `CommandLedger` becomes the live cache — it does not grow a second writer.

### 4.3 Every interval has two ends

Durability creates a failure the in-memory version never had: an entry that opens and never
closes is now permanent.

> An entry is `open` from the moment its intent is accepted until exactly one of: its driver
> reports an outcome; its session ends; the app shuts down; or a per-kind timeout expires.
> No fourth exit exists, and every one of those four writes `phase='closed'`.

Three obligations follow:

1. `abandon()` closes open entries `interrupted` when the cycle was trusted and `unknown`
   when it was not — the existing `_finalizeRunning` rule.
2. **Startup reconciliation.** On ContentDB open, every entry with `phase != 'closed'` is
   closed as `status='unknown'`. A partial index (§5.2) makes the sweep cheap.
3. **A close for an unknown id creates its row**, which is possible only because every event
   carries the immutable envelope (§6.2).

### 4.4 Fail-open is unchanged

No C after submit → the entry closes `unknown`, `trusted=false`, no block, and the editor
never takes the shell line. Orphan C → an entry with empty intent, `trusted=false`, execution
actions disabled (ADR-0008). The nested-shell gate (`NOCX_SESSION_ID`) is unchanged: only
the top-level integrated session mints entries.

### 4.5 The ledger never blocks execution

**A command runs before it is recorded, always.** If ContentDB is slow, locked, corrupt or
absent, the PTY handoff still happens and the entry queues in the outbox (§6.4). Memory is
the product's value; it is not permitted to become its failure mode. The one thing decided
_before_ handoff is sensitivity (§9), and that decision is local and synchronous.

---

## 5. Persistence

### 5.1 The stub that exists

`internal/content` already declares `ContentDB`, `ConversationRepository` and
`CommandHistoryRepository` with `ErrNotImplemented` (§1.4). This design implements the
SQLite backing for `CommandHistory` and widens the repository to the entry/edge/artifact
model below; `Conversations` stays stubbed until agent mode. The capability is chosen at the
composition root per AD-8, and the stub keeps working for anything that does not need it.

It stores no authenticators. Those remain in `SecretStore` behind opaque references
(ADR-0011 §2).

**The engine and its encryption are decided in
[ADR-0018](../../docs/decisions/0018-contentdb-engine-and-encryption-at-rest.md)**, which
this section defers to rather than restates. Three consequences bind the rest of §5:

- **SQLite, via SQLCipher, encrypted at rest.** Metadata, chunks and the FTS index live
  in one encrypted file — splitting them would break the same-transaction rule in §5.2.
- **ContentDB has its own 32-byte key in the OS keychain**, read once at start and
  **not** governed by the vault's auto-seal. A sealed vault means "re-authorise before I
  use your SSH password"; it must never mean "I have forgotten yesterday".
- **v5's claim that this design does not touch the keychain is withdrawn.** It does, for
  exactly one item, and that item's absence and failure paths need tests in which they
  fail.

Adoption is gated on ADR-0018 §2's spike: a packaged build on macOS and Linux proving
`STRICT`, JSON1 and FTS5 under encryption, with WAL and crash recovery intact.

### 5.2 Schema v1

```sql
CREATE TABLE environments (
  id          TEXT PRIMARY KEY,          -- derived from facets, never from a session
  kind        TEXT NOT NULL,             -- local | ssh | container | unknown
  endpoint    TEXT,                      -- canonical user@host:port, NULL for local
  profile_id  TEXT,
  facets      TEXT NOT NULL DEFAULT '{}',-- JSON: repoRoot, branch, k8sContext, privilege…
  confidence  TEXT NOT NULL DEFAULT '{}',-- JSON, per facet: asserted|derived|unknown
  criticality TEXT NOT NULL DEFAULT 'routine', -- routine|sensitive|critical (§10.2)
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
) STRICT;

CREATE TABLE entries (
  id              TEXT PRIMARY KEY,      -- client-minted UUIDv7
  seq             INTEGER NOT NULL UNIQUE, -- backend monotonic; the only total order
  environment_id  TEXT NOT NULL REFERENCES environments(id),
  session_id      TEXT,                  -- execution facet; never a recall filter
  cwd             TEXT NOT NULL,
  kind            TEXT NOT NULL,         -- shell | agent | action
  intent          TEXT NOT NULL,
  phase           TEXT NOT NULL,         -- open | bound | closed
  status          TEXT NOT NULL,         -- pending|running|success|failure|interrupted|unknown
  conversation_id TEXT,
  submitted_at    INTEGER NOT NULL,      -- display only
  started_at      INTEGER, ended_at INTEGER, duration_ms INTEGER,
  sensitivity     TEXT NOT NULL DEFAULT 'normal',
  reviewed_at     INTEGER,               -- attention queue (§10.8)
  payload         TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE edges (
  from_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  rel     TEXT NOT NULL,                 -- rerun-of|supersedes|caused-by|cites|in-span
  PRIMARY KEY (from_id, to_id, rel)
) STRICT;

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  media_type   TEXT NOT NULL,
  derived_from TEXT REFERENCES artifacts(id),
  state        TEXT NOT NULL,            -- open | sealed
  byte_len     INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  truncated    TEXT                      -- NULL | cap | gap | suppressed
) STRICT;

CREATE TABLE artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  body        BLOB NOT NULL,
  PRIMARY KEY (artifact_id, seq)
) STRICT;

CREATE INDEX entries_by_env    ON entries(environment_id, cwd, seq DESC);
CREATE INDEX entries_by_status ON entries(status, seq DESC);
CREATE INDEX entries_open      ON entries(phase) WHERE phase != 'closed';
```

Decisions embedded above, not commentary:

- **`STRICT` tables.** SQLite's default affinity would accept a string in `duration_ms`, and
  the reason to have a schema is that it says no.
- **Chunks, not a BLOB.** v2 declared an append-only chunked artifact and then gave it a
  single `body BLOB`, which would rewrite the whole blob per streamed chunk. Chunks also make
  `truncated` meaningful: the artifact records which end was lost.
- **FTS arrives with search, not before.** The index covers `intent` **and derived text**
  (§10.7), and it is created by the increment that queries it — but its two consequences are
  designed here, not discovered there. It uses external-content tables so the text is not
  duplicated a third time, and **eviction must delete the index row in the same transaction
  as the artifact**, or search keeps answering with content the store no longer has. Nothing
  doubtful is indexed (§9).
- **`entries_open`** exists solely to make §4.3's startup sweep cheap.

### 5.3 One write path

WAL, one writer goroutine, short transactions, concurrent readers, `foreign_keys=ON`. Every
mutation goes through a single serialized channel; no handler opens its own transaction.
This is what makes two tabs — and later two windows — safe, and it is the mechanism
ADR-0011 §5 already called for.

### 5.4 Retention belongs to the user, and the default still belongs to us

**Retention is a setting**, not a policy this document fixes. Four knobs, in the settings
surface as ordinary public config:

| Knob                    | What it bounds                                               |
| ----------------------- | ------------------------------------------------------------ |
| retained content size   | **logical** retained bytes — see below                       |
| age                     | drop entries older than N days                               |
| per-entry output cap    | the head+tail budget from §3.5                               |
| output retention on/off | metadata-only mode, for users who want commands without text |

**"Total size" is two numbers, and v5 conflated them.** `DELETE` reduces live content and
does not shrink the file; WAL can exceed the main database; SQLCipher changes neither.
A UI that promises 5 GB over a file that stands at 12 GB after eviction has shipped a
defect, and the user is right to call it one. So:

- **Retention budget** — logical retained content. This is the knob above, the number the
  user reasons about, and what eviction acts on.
- **Disk ceiling** — physical: main database plus WAL, with hysteresis and a maintenance
  path. Exceeding it triggers compaction rather than more deletion.

Reclaiming physical space under encryption is its own problem: a full `VACUUM` rewrites
the whole database, needs substantial free space, and takes time proportional to years of
history — and it must never run on a path the PTY depends on. `auto_vacuum=INCREMENTAL`
is the likely answer and is **decided at database creation**, which makes it one of the
few choices here that cannot be deferred. ADR-0018 lists it as not-yet-decided; it must
be settled before the first database is created in anger.

Whoever wants a 90-day 5 GB memory and whoever wants seven days of commands and no output
are both right about their own machine, and neither should have to argue with us.

**The default is still ours, and it is the one users live with.** It leans toward memory
being useful: output retained, a generous total size, age unbounded until the size cap
bites. Eviction is oldest-first by `seq`, `DELETE` with cascade, index row in the same
transaction (§5.2); pinned artifacts are exempt.

Two honesty constraints follow, and both are testable:

- **Search states its coverage** — and **coverage cannot be computed from the rows that
  remain.** This is the defect in v5's promise: once eviction has deleted the rows, there
  is nothing left to count, so "searched 4 200 of 31 000 entries" is not derivable from
  the store's contents. It requires a **durable retention watermark** — a small journal
  recording what was evicted and to what horizon — written in the same transaction as the
  eviction. Without it the sentence is unimplementable and search silently reports full
  coverage over a partial store, which is precisely the failure this constraint exists to
  prevent.
- Per ADR-0011 §5, the UI says "removed from nocx", never "securely erased", until
  checkpoint and vacuum behaviour is designed deliberately.

### 5.5 Local-first is not private-at-rest

`content.db` holds every command the user has run, with hosts and cwds, and a retained
slice of what those commands printed. Local-first means no upload path; it does not by
itself mean unreadable.

**v5 concluded "plaintext with `0600`, and encryption is an open question". That
conclusion is superseded — the database is encrypted (ADR-0018).** The warning it was
attached to survives verbatim, because encryption with an automatically-available key
buys a specific set of protections and not a general one:

- **Closed:** a powered-off machine; a copy of the file without the keychain — which is
  what a backup, a Time Machine snapshot, a cloud-synced home directory or a support
  bundle actually is; another local account; casual inspection with the `sqlite3` CLI.
- **Not closed:** a process running as the same user while logged in, which can ask the
  keychain for the same key; a compromised nocx; forensics against an unlocked session.

The most common way this data leaves a machine is a copy of the file, and that path is
now closed. **The UI must not claim more than that.** Encryption is not a licence to
relax anything else here: `0600` on the file and `0700` on the directory stay, exclusion
from any diagnostic bundle stays, and export remains an explicit user action that names
what it contains.

For comparison, and because it is the baseline users actually live with: `~/.bash_history`
is plaintext at `0600` and holds command lines only — no output, no exit codes, no cwd.
That norm does not license us, because we store roughly two orders of magnitude more per
command; it does mean this decision puts nocx above the baseline rather than level with
it.

### 5.6 What does not move

Settings, profiles, groups, credential metadata and tab restore stay in `DocumentStore`.
ADR-0011 §5 forbids configuration migrating into SQLite for the sake of consistency, and
this design agrees.

---

## 6. Control plane

### 6.1 AD-1 must be amended, deliberately

AD-1 currently states, in `docs/architecture.md`:

> cwd/OSC/prompt markers do **not** cross the control plane — they stay frontend-side (see
> AD-6, Data Flow) and only feed UI + the next `open{cwd}`.

`ledger.bind` and `ledger.close` carry cwd, marker-derived trust and exit status. That is a
direct conflict with a binding invariant, and per this repo's rules the answer is to change
the AD in the document rather than route around it in one module.

The proposed amendment, narrower than it first appears — note that AD-1 _already_ permits cwd
to cross in `open{cwd}`, so this generalises an existing allowance rather than opening a new
one:

> Raw OSC/VT sequences never cross the control plane, and the backend never parses them
> (AD-6 unchanged). Typed facts **derived** by the frontend — cwd at submit, marker-derived
> trust, exit status — may cross as explicit, schema-checked ledger events. The test is that
> the backend receives a value it could not have inferred, never a byte stream it must
> interpret.

AD-6 survives verbatim: the backend stays byte-blind, and nothing here gives it the stream.
This amendment is a bead of its own (§12), and no ledger event ships before it lands.

### 6.2 Methods, and the immutable envelope

The namespace is `ledger.*`: history is one _query_ over the timeline, not the timeline
itself, and the wire name is the hardest thing to change later — the renderer's types are
generated from it (`contracts/`).

Every lifecycle event carries the same **immutable envelope**:

```
envelope = { id, environment, cwd, kind, intent, sensitivity, clientSeq }
```

- `ledger.open   { envelope }` → `{ seq, submittedAt }`
- `ledger.bind   { envelope, facts }`
- `ledger.close  { envelope, status, facts, durationMs }`

v2 sent `{id, status, facts, durationMs}` on close and claimed it could upsert a missing row
— impossible, since the row needs `environment_id`, `cwd`, `kind` and `intent`, all NOT NULL,
and "create it with empty intent" supplies one of four. Repeating the envelope costs a few
hundred bytes per command and removes an entire class of lost-entry failure. That trade is
obviously worth taking.

**Queries:**

- `ledger.query { environmentId?, cwd?, kind?, status?, since?, before?, limit, scope }` →
  `{ entries: Entry[] }`, ordered by `seq DESC`. `scope` selects the recall ladder rung
  (§10.6).
- `ledger.search { text, scope, limit }` → `{ entries, coverage }` — full-text over intent
  and derived output (§10.7). `coverage` states what retention still holds, and is not
  optional (§5.4).
- `ledger.get { id }` → `{ entry, edges, artifacts: ArtifactMeta[] }`.
- `ledger.attention { limit }` → the unreviewed queue (§10.8).

`ledger.query` is the **only** ordering implementation. The frontend cache renders what it
holds; it never answers a recall query with its own ordering, or the same keystroke returns
different results depending on which tab it came from.

### 6.3 Idempotency and ordering

- **`seq` is the total order**, assigned by the backend writer. Wall-clock milliseconds are
  not a key: two windows submit in the same millisecond, and UUIDv7 is identity rather than
  authority.
- **Phase is monotonic**: `open → bound → closed`. An event that would move it backwards is
  dropped and logged, never applied.
- **Out of order.** A `close` for an unknown id creates the row, closed, from its envelope.
- **Replay.** Re-delivery of any event for a row already in that phase is a no-op.

### 6.4 The outbox

AD-9 replays PTY bytes; it says nothing about control-plane events. A socket that drops
between submit and `ledger.open` would silently lose the entry — and a memory product that
loses entries when the network hiccups is not a memory product.

The frontend keeps a **bounded outbox** of unacknowledged events, ordered by `clientSeq`,
replayed on reconnect and drained in order. Backend dedup is by `(id, phase)`. The outbox is
capped; on overflow it drops oldest and records that it did, because a queue that grows
without bound to preserve history is how the renderer runs out of memory.

### 6.5 Streaming is a capability that does not exist yet

Server→client notifications exist and have precedent (`exit`, `settings.changed`,
`vault.changed` at `ws.go:3220` / `ws_vault.go:828`) but are **broadcasts**. An agent turn
needs per-entry streamed chunks — `ledger.chunk { entryId, seq, data }` — with ordering and
backpressure of its own. Two consequences, named now though agent mode is out of scope:

1. **The binary data plane stays PTY-only.** Agent output is control-plane JSON-RPC.
   Wrapping model tokens in binary frames would put a second protocol on a plane whose entire
   contract is "these bytes go to a terminal".
2. Per-entry streaming is a real new transport capability with its own bead (§12), so agent
   mode does not discover it mid-epic.

### 6.6 Contracts

Every method gets a JSON Schema in `contracts/` in the same commit that adds it, with the
three checks `contracts/README.md` requires. Two specifics, both defects this repo has
already shipped once: `entries` marshals as `[]` and never `null` when empty, and every
object carries `additionalProperties: false` plus an explicit `required`, or the check is
theatre.

---

## 7. Output capture

### 7.1 The capture point is the freeze, and the code is already there

**Output is serialized from the xterm buffer when the block freezes.** Not from the byte
stream.

`frontend/src/scrollback/blocks.ts:671` already does this:

```ts
const outputHtml = serializeRange(snapshot, getLine, rec.startLine, endLine)
```

called from `controller.ts:301` — _"Called on OSC 133 D: serialize output, freeze the
block."_ The DOM scrollback has been producing each block's text from the buffer, bounded
by that block's own marker range, since it landed. The spike measured it at 6.4 µs/line.
Capture is therefore not a new pipeline: it is **the same `serializeRange` pass in a text
mode**, and the durable artifact is its output.

### 7.2 Why the previous revision's two-clock problem does not exist here

v5 opened with a real observation — `term.write()` is asynchronous, so OSC 133 handlers
fire on the **parser's** clock while `ipc.ts` receives frames on the **network's** clock,
and under load the parser lags the socket by many frames. v5 concluded that artifact
boundaries must therefore be cut in the byte stream.

That conclusion inverts cause and effect. The mismatch exists **only because v5 chose to
capture at `ipc.ts`.** Read the text from the buffer instead, using the markers that
already bound the block, and both sides are on the parser's clock: `rec.startLine` and
`endLine` index the same buffer whose contents the parser wrote. There is nothing to
reconcile.

Deleting that premise deletes three sections of machinery:

- **the streaming recognizer** over OSC 133, `BEL`/`ST` terminators and alt-buffer
  toggles — not needed, because nothing is being cut out of a byte stream;
- **the alt-screen special case** — solved by construction: the alternate buffer is a
  separate buffer and no block is frozen out of it;
- **`truncated='gap'` for ambiguous boundaries** — a boundary derived from a marker range
  is not ambiguous.

This is the second time this document proposed building something the repository already
had; §1.4 records the first. The rule in `AGENTS.md` is one `grep` for the caller, every
time, and the cost of skipping it here was three sections and the riskiest component in
the design.

### 7.3 What the buffer path costs, stated plainly

Two real losses, and neither is the one v5 was worried about.

**Raw VT fidelity is gone from the durable path.** Byte-exact replay into a terminal is
no longer possible from storage. This costs less than it sounds: §3.5 already made raw
`application/vt` session-local, durable only by explicit pin, precisely because a VT
stream is large, secret-bearing and meaningful only when replayed. The durable artifact
was always going to be text. A pin now means "keep the serialized HTML with its theme
snapshot", which is what the frozen block already holds.

**The head of a very long output can be lost.** xterm's scrollback is bounded, so for a
command that prints far more than the buffer holds, `rec.startLine` may have been trimmed
before the block freezes. The tail is reliable; the head is not. Byte capture would have
kept both.

That second loss interacts badly with §3.5's head-and-tail cap, which assumes both ends
are available, and **this is the open item of this section**: either the scrollback is
sized to cover the cap, or the head is serialized incrementally once the block has
produced enough lines — still the same pass, still the same clock, still no second
mechanism. Which one is a measurement, not a preference. What is not acceptable is a cap
that silently returns a tail and calls it head-and-tail.

### 7.4 Capture is gated on where you are

`criticality` (§3.1) is already user-set and already gates §10.2's confirmation. It gates
capture too:

| `criticality` | Captured                         |
| ------------- | -------------------------------- |
| `routine`     | intent + metadata + derived text |
| `sensitive`   | intent + metadata + derived text |
| `critical`    | **intent + metadata only**       |

A production host marked once on its connection profile therefore never contributes
output to the store — by a decision the user made deliberately, not by a matcher guessing
at text. This is strictly better than detection for the case that matters most, and it
composes with §9: detection still runs on what is captured.

### 7.5 Derived text is what consumers actually want

Copy, `blockOutputText`, search, diff, comparison and agent context read the
**`text/plain` artifact** (§3.5), subject to §9.1's redaction before it is written.

One simplification falls out of §7.1: with capture happening at freeze rather than in the
byte stream, `derivedFrom` no longer points at a durable raw-VT artifact, because there
usually is not one. The text artifact is produced directly by the same pass that produces
the block's HTML. `derivedFrom` survives for the pinned case — where the serialized HTML
_is_ retained — and for future transformers (§10.11), which derive from the text.

### 7.6 Consumers

Copy and `blockOutputText` read derived text when present and fall back to the serialized DOM
in its absence. "Data from a block" is `ledger.get(id)` plus its artifacts — one API across
kinds, which is what the typed media types buy.

---

## 8. The editor

The CM6 swap is **not designed here** — binding spec
`2026-07-25-editor-core-codemirror6-design.md` (epic `nocx-2gf`, W1–W5; the `nocx-hi2`
submit-path contest and `nocx-0oc` z-index landmines belong to that epic). This design is the
first real consumer of the extension seam that spec left open, and nothing here changes the
submit path.

### 8.1 Reachable always; inline only when the shell vouches

v2 said the editor is "always present", which is wrong in the states that matter: a persistent
inline editor competes with `vim`, a debugger, `less` and a password prompt for both keys and
screen space, and ADR-0006's full-viewport alt-screen takeover exists for a reason.

The correct split is three-way:

- **Inline, as today** — when the shell target is owned (`PROMPT_READY` + `owned`). Unchanged.
- **Reachable by a deliberate shortcut, as an overlay** — in every other state, including
  `RAW`, `RUNNING_RAW` and `ALT_SCREEN`. The application's intent surface does not vanish
  because the shell could not be located; it stops occupying the screen.
- **Never inline in alt-screen.** Raw keyboard behaviour and the full viewport are preserved
  verbatim.

`input-state.ts` keeps its states, transitions and fail-open semantics untouched — what
changes is who consumes `owned`, and ADR-0004 §1's invariant (nocx owns the keyboard _line_
only in `PROMPT_READY`) survives word for word.

### 8.2 An explicit target switch — no sigils

v2 proposed `>` for actions, `@` for agent, `/` for search. ADR-0004 rejects exactly this, in
those words:

> …an explicit command/agent switch plus a keyboard shortcut, never a magic prefix such as
> `?` — prefixes collide with valid shell syntax and obscure submission intent.

And it is right on the merits: `>` is redirection, `/` begins an absolute path, `@` is valid
in arguments. "Explicit sigils always win" would hijack valid shell input, which is the worst
possible failure for a terminal.

So: **a visible target chip with a keyboard shortcut to cycle it**, and the current target
rendered in the surface at all times. The resolver survives, but it resolves the _active
target_ to a submission, not the user's prefix to an intention. `Enter` is never a surprise
because the target is on screen before it is pressed — that requirement is unchanged, only
the mechanism is honest.

### 8.3 No implicit non-shell fallback

When the shell target is unavailable, `Enter` does **not** silently become an agent question
or an action. A user typing into a terminal expects terminal semantics; a surface that
reinterprets their keystroke by rank has broken the contract that makes a terminal usable.
The overlay (§8.1) requires deliberate activation, and the target is explicit once inside it.

### 8.4 Suggestions: resolve the target, then rank within it

```ts
export interface SuggestionProvider {
  readonly id: string
  readonly targetId: string
  suggest(query: string, env: EnvironmentRef, signal: AbortSignal): Promise<Candidate[]>
}
```

v2 said "one ranker over all providers". That is right against the failure it was aimed at —
concatenating four pre-sorted lists produces ordering nobody can tune — and wrong as stated,
because a shell command, a destructive action and an agent prompt must not compete for a slot
merely because their text matches. Ranking across kinds does not reorder results, it changes
what `Enter` does.

The rule: **the active target selects the provider set; one scoring function ranks within
it.** Cross-target candidates, when shown at all, are visually segregated and never win a
default.

The scoring function's features are named and therefore testable: prefix quality, recency,
frequency, environment match, **outcome** (§10.4), and provider prior. _Given two candidates
identical but for recency, the more recent ranks first_ is an assertion; "feels right" is not.
Providers are cancellable, because a keystroke invalidates the query in flight.

### 8.5 What the shipped providers may truthfully claim

Ledger history (`ledger.query`, environment-scoped), **local** PATH, **local** cwd paths, and
aliases (port the `nocx-c2ym.4` prototype).

v2 promised "host-aware PATH — a remote session's PATH is its own" while also deferring the
listing channel that would make it possible. That is a promise the code cannot keep. Remote
knowledge ships when the channel does, and until then every candidate is **labelled with its
source and freshness**, so a local path never masquerades as a remote one.

**v6 correction: a label is not enough, and applicability is part of the contract.** v5
concluded that a local candidate offered inside a remote session is acceptable as long as
it says "local". It is not. `rm` found on this laptop may not exist on the host you are
typing at, or may be a different binary with different flags — and a candidate that is
merely mislabelled is still a candidate the ranker can promote and ghost text can offer.
The honest rule:

> **A provider declares which environments it applies to, and is not consulted outside
> them.** The local PATH and local-path providers are inactive in a remote environment.
> They may appear in an explicitly non-executable reference section, never in ghost text
> and never as a default selection.

Disabling an inapplicable provider is a smaller failure than labelling a dangerous
irrelevance. This also makes `confidence` load-bearing rather than decorative: a provider
cannot claim applicability for an environment whose facets are `unknown`.

### 8.6 Highlighting

Shell mode via CM6 legacy-modes (versioned in `nocx-2gf` W1) over the composed intent, and the
same highlighter re-run as a static pass on frozen block headers. When the active target is
not the shell, the shell highlighter is off — highlighting an agent prompt as shell syntax is
worse than no highlighting.

**But highlighting does not by itself justify CM6, and ADR-0010 must weigh that.** The
tokenizer is the cheap half of this section; what is expensive and unproven is CM6 _in the
prompt line_ — focus interplay with xterm, `defaultKeymap` shadowing Enter/Escape/Ctrl-C,
IME, measurement under `visibility:hidden` — and the de-risk spike W0 that would have
measured it in our own WebKitGTK webview was removed (§12). If highlighting is the whole
near-term want, a **mirrored highlight layer behind the existing textarea** delivers it
without any of that risk: the same tokenizer output painted into a positioned layer, with
the textarea keeping the caret, selection, IME and keymap it already has.

That is a genuinely different cost curve, and it is a real decision rather than a fallback:
the mirrored layer is cheaper for highlighting alone and pays nothing toward ghost text,
the completion dropdown or the recall overlay, which all want a real editor. ADR-0010 must
carry both, plus one measurement, before W1 — otherwise the choice will have been made by
whoever starts first.

### 8.7 Ghost text and Tab

Ghost text is an inline decoration from the top-ranked candidate, environment-scoped.
Acceptance must not fight W2's `Prec.highest` keymap (Enter / Shift-Enter / Escape / Ctrl-C):
the accept binding lives inside that same layer.

Acceptance has preconditions, and v5 stated none of them. `→` accepts only when the caret
sits at the end of the candidate's replacement range, the selection is empty, no IME
composition is active, the keystroke would not otherwise move the caret, and the suggestion
still belongs to the current document revision. `End` has the same conflict: with the caret
mid-line it stays a caret movement and does not accept. A stale asynchronous suggestion is
discarded, never applied. Per §9, an entry marked sensitive is never eligible to become
ghost text — and the `Candidate` contract in §8.9 has to express that, because a rule the
type cannot state is a rule the next provider will break.

#### Tab: v5 promised something the architecture cannot do

v5's default read: "`Tab` opens the dropdown when candidates exist and otherwise **falls
through to the shell** as a real completion request." **That is withdrawn — it is not
implementable, and it would have been built.**

The editor owns the text in the DOM, and per ADR-0004 the line reaches the shell only as
an atomic write at submit. The shell's `readline`/`zle` buffer therefore does not contain
what the user is looking at. A raw `\t` forwarded to the PTY asks the shell to complete an
empty or stale buffer — which will appear to work often enough to ship and be wrong in a
way nobody can reproduce. The motivation was sound (only the shell knows remote paths, git
subcommands and every dynamic completer, which is exactly what §8.5 cannot ship); the
mechanism does not exist.

Three real options, and choosing between them is what §17.1 now asks:

1. **Tab opens our dropdown; with no candidates it sends nothing** and offers an explicit
   route into a native-input mode. Cheapest, honest, and gives up dynamic completion.
2. **A per-shell completion adapter** that synchronises the buffer with the shell and
   retrieves its completions. Real capability, real per-shell cost, and a second thing that
   can desynchronise.
3. **An explicit native-input mode** in which the shell genuinely owns the line, entered
   deliberately, with the editor stepping aside.

**Until 2 or 3 exists, no document and no UI may promise shell-native completion.** Naming
a capability we cannot deliver is how a worker builds a feature that is correct in tests
and broken in a terminal.

### 8.8 The `InputTarget` seam grows extensions

`input-target.ts:9` is already the right shape (`id`, `label`, `submit`). This design adds one
optional member, and is the first real consumer of the CM6 extension list:

```ts
editorExtensions?(): Extension[]   // allow-listed; cannot override the W2 keymap
```

`ShellInputTarget` supplies shell mode and its providers. `AgentInputTarget` later supplies its
own and mints `kind='agent'` entries through the same contract. ADR-0004 §3's "never edit the
editor to add a target" is preserved, and now exercised.

### 8.9 Four contracts before any pixel

Everything above §8.9 describes behaviour. None of it says what the pieces _are_, and a
worker handed §8.1–§8.8 would build a plausible popup that is wrong in exactly the cases
that matter: multiline, remote, and stale-async. **The editor work starts here, not with a
dropdown.**

**1. `Candidate` is a type, not a word.** §8.4 returns `Candidate[]` and never says what
one holds. At minimum:

```ts
interface Candidate {
  id: string // stable — dedup across providers depends on it
  targetId: string
  providerId: string
  displayText: string // what is shown
  insertText: string // what is inserted — deliberately not the same field
  replacement: { from: number; to: number } // where it goes; ghost text needs this
  matchRanges: Array<{ from: number; to: number }> // why it matched, for highlighting
  source: CandidateSource
  scope?: RecallScope // which rung of §10.6 this came from
  freshness?: Freshness
  outcome?: OutcomeEvidence // §8.10's evidence column
  environment?: EnvironmentEvidence
  eligibleForGhostText: boolean // §9 sensitivity, expressed in the type
}
```

Display text and insert text are separate fields on purpose: the evidence column (§8.10)
is displayed and must never be inserted.

**2. Provider applicability and merge.** "One ranker within the active target" (§8.4) does
not answer: when the first results render; whether a slow provider is waited for; whether a
late arrival may move the selection (**it may not** — a list that shifts under the fingers
is worse than a slow one); how the same command arriving from history and from aliases is
deduplicated; what a provider's error does to the others; the latency budget; and whether a
provider may return after abort (it may not). Applicability from §8.5 belongs to this
contract too.

**3. Ranking features have semantics or they have none.** §8.4 names prefix quality,
recency, frequency, environment match, outcome and provider prior — and defines none. The
one that decides correctness: **what "environment match" means when a facet is `unknown`.
Unknown is never a wildcard**, or the exact rung becomes a lie. This needs golden ranking
cases in the bead, as assertions, or every worker writes a different heuristic.

**4. Two state machines and one keyboard arbiter.** The completion dropdown and the recall
overlay (§8.10) are separate surfaces with separate lifecycles, and nothing currently says
which owns a keystroke when both could be open, what `↑` does inside an open dropdown, what
`Tab` does inside the overlay, or whether the palette may open above either. Without an
ownership rule this becomes competing keymaps and z-index defects — the failure already
listed in `nocx-2gf`'s risk table and the reason `nocx-0oc` exists.

### 8.10 Recall is a surface, and its signature is provenance

The near-term goal is history, highlighting and hints. This section is what makes the first
of those something a competitor cannot copy by adding a column.

**`↑` opens an overlay; it does not cycle the line.** Not for novelty — because a cycled
line has nowhere to show which rung of the ladder (§10.6) the result came from, no room for
provenance, and no way to restore the draft. But the rule needs a boundary v5 never drew:
in a multiline document `↑` stays caret movement first, and recall opens on an empty line
or when there is no further movement upward; an explicit shortcut opens it from anywhere;
`Esc` restores the draft, selection and scroll exactly as they were.

**Enter inserts. It never executes.** A history of destructive commands crossed with an
environment that may have changed since makes running straight from a list unacceptable.
This is an acceptance assertion, not a preference.

**The signature interaction — Provenance Recall.** Pick a past command and, _before it
runs_, see why this one and what has changed since:

```
make dep␣↑

  ⌂ prod/api · /srv/api                                    8 results
    exact environment

    make deploy                              ✕  failed twice
    └─ make deploy REGION=eu                 ✓  worked next · 3 weeks ago

  THEN                     NOW
  staging                  prod                changed
  deploy@10.0.0.4          deploy@10.0.0.8     changed
  /srv/api                 /srv/api
  main                     release/4.2         changed
  privilege: yes           unknown             uncertain
```

Four rules that make this honest rather than clever:

- **The failure stays visible.** Defaulting the selection to the successor is allowed;
  hiding the command that failed is not. The user must see that nocx offered a substitute,
  never that it rewrote what happened.
- **Unknown renders as unknown** — never as absent, never as a guess (§10.1).
- **The rung is shown, and relaxing it is the user's move**: "no more here · search same
  host › · repository › · everywhere ›". Never an automatic widening.
- **Accepting inserts; a significant context diff makes the next Enter open a short review**
  rather than run silently — by §10.2's rule, escalating on where you are.

Why this and not the alternatives, since all of them are reachable on §3's model: outcome
ranking on its own is _invisible_ — it looks like odd sorting and earns no credit; the
guardrail on its own reads as one more warning; search over output is powerful and is
post-hoc investigation. Provenance Recall is the only one that puts `Environment`,
`confidence`, `status` and `edges` together at the single moment with immediate value —
**the instant before re-running a real command.** Its promise fits in a sentence: _nocx does
not merely remember the command; it remembers where it worked, and says what has changed
since._

It is also reachable inside tracks E and M (§12): it needs `status`, durable entries,
`edges` and the recall overlay. No output capture, no FTS, no agent.

**The evidence column replaces descriptions.** Warp's dropdown says what a command _is_,
from a curated specification database we do not have and will not build. Ours says what
happened when **you** ran it — which no curated database can ever know:

```
make deploy REGION=eu      ✓ worked here · 3 weeks ago · /srv/api · main
kubectl logs api-7c9…      ✓ ran 6× here · last 2 days ago · exact environment
ssh deploy@api             history · last exit unknown · context partly known
./scripts/release          path · local cwd · seen just now
```

Not poorer than a description — a different and more useful axis, answering _why is nocx
offering this, and can I trust it here?_ What it must never be is a manufactured substitute:
no "ssh — a command named ssh", no `--help` parsing on the keystroke path, no generated
prose. If local man pages ever supply real descriptions, that is an optional provider with
a named source, not an authoritative column.

---

## 9. Privacy is decided before handoff, not redacted after

v2 redacted at write. That is too late by one whole step: the row is not where the secret
leaks — the PTY echoes it, and the artifact captures it, before any row exists.

The rule: **sensitivity is determined at composition time, before the intent reaches the
PTY**, and it governs intent recording, artifact capture, suggestion eligibility, export and
agent context atomically. One decision, five consequences, no window in which one of them has
happened and the others have not.

**Three levels, and the strongest one is thirty-five years old.** v5 asked for "one
keystroke for run privately" without saying which. There is already an answer, and every
developer's hands know it:

| Signal                            | Behaviour                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Leading space**                 | The entry is **not recorded at all** — no intent, no metadata, no capture. Silent, no prompt, no confirmation.        |
| **Matcher fires with confidence** | Ask, before Enter: offer to bind the value into the vault (§9.2) so rerun keeps working, or to run without recording. |
| **Matcher fires weakly**          | Record and capture; **do not index** (§9.1 rule 2). No prompt.                                                        |

`HISTCONTROL=ignorespace` has been the convention in bash since forever, `HIST_IGNORE_SPACE`
is its zsh spelling, and people already type a space before `export TOKEN=…` reflexively.
Honouring it costs nothing, teaches nobody anything, and violating it would be a betrayal
of an expectation users arrive with. Honest caveat: it is not set in a bare bash — the
distribution skeletons set it — so the convention is widespread rather than universal.
That does not affect us: the command line is app-owned (ADR-0008), so nocx sees the
leading space itself and never depends on the user's shell configuration.

The middle row is where prompting lives, and it is deliberately narrow. A question on
every git SHA and UUID is trained away within a week and then stays silent on the one
occurrence that mattered — the same failure §10.2 designs around. **Ask only when
confident; stay silent otherwise.**

- **Detection before Enter.** Likely-secret shapes in the composed text (a bearer token in a
  `curl -H`, `-p<password>`, a connection string, a long high-entropy argument) flip the
  pending entry to `sensitive` **visibly**, so the user sees it before submitting.
- **Prior art to read rather than reinvent.** Atuin — the closest existing analogue, a
  SQLite-backed replacement for shell history storing cwd, exit code, duration and host —
  ships a `history_filter` regex list and a `secrets_filter` for common key shapes. Its
  pattern set should be read from its source before we write our own; ours differ only
  where we have evidence.
- **`sensitive` means:** intent stored redacted or not at all (per setting), capture
  suppressed with `truncated='suppressed'`, excluded from suggestions and export by default.
  Exclusion from suggestions is the main point: an accidental token should not be offered
  back as ghost text during a screen share.
- **`do-not-record` has a defined scope**, which v2 left open: per-session, toggled from the
  surface, does not survive restart, suppresses `ledger.open` and capture together. A global
  default lives in settings as public config.
- **Redaction is best-effort and says so.** It catches common shapes. It is not a boundary,
  and the document does not pretend otherwise — the boundary is ADR-0011 §2, which keeps
  actual credentials out of this path entirely.

### 9.1 The other half: secrets arrive in the output

Composition-time detection cannot see `env`, `kubectl get secret -o yaml`, a script that
echoes a token, or a CI log replayed into the terminal. The secret was never typed, so
nothing in the paragraph above can catch it — and §3.5 now retains derived text for every
entry and §10.7 makes it searchable by substring. That combination is what turns an old
tolerable leak into a reachable one, so this half is designed here rather than discovered
later.

Three rules:

1. **Derived text is redacted as it is derived**, by the same matchers, before it is written
   or indexed. The raw VT artifact is left alone — it is session-local and replay must stay
   faithful — but the durable, searchable copy is the redacted one.
2. **Doubtful text is retained but not indexed.** When a matcher fires with low confidence,
   the entry keeps its output and stays out of FTS. Search that cannot find something is a
   smaller failure than search that surfaces a token by substring.
3. **A user can mark output sensitive after the fact.** The composition-time flag cannot
   predict what a command prints; a one-action "forget this output" that drops the artifact
   and its index row in one transaction is the escape hatch, and its existence is the reason
   rule 1 is allowed to be imperfect.

### 9.2 A secret in a command becomes a binding, using the reference that already exists

Redaction and binding answer different questions. Redaction makes an entry safe to keep;
**binding makes it safe to keep _and still runnable_.** `curl -H "Authorization: Bearer
sk-…"` redacted is a permanent record of a command that can never be rerun — and rerun
with provenance (§10.5) is a shipped goal.

**The reference format is not designed here, because it exists.** `internal/vault/id.go`
mints `sec:v1:<provider>:<32 hex>` — `sec:v1:system:f00a7d92…` — and three of its
properties are load-bearing for this section:

- the provider tags are **persisted protocol**, already embedded in `profiles.json`
  (ADR-0017), and can never be renamed;
- **only the Vault mints**, because minting selects a provider and that is the Vault's
  policy, not a caller's — the ledger asks the Vault to store and receives a reference;
- `parseID` judges syntax only, so a reference whose provider is absent from this build
  stays a valid record.

Beside it, `credential.Secret` already **fails `json.Marshal`** rather than emitting a
value, and renders `[REDACTED]` through every formatter and logger. Inventing a second
format for the ledger would be a second vocabulary for one concept — the exact defect two
kit epics were spent unwinding.

Two things are genuinely new, and they are the whole of this section's work.

**1. Bindings are byte spans, not a text search.** In a profile the reference sits in a
typed field, so the resolver knows what it is. In a command line it would sit inside free
text, and substituting by searching for `sec:v1:…` in a string is unsafe: the same shape
can arrive in a command's _output_, or be typed by the user. So the entry stores its
`intent` **plus the byte ranges that are bindings**, and substitution applies known spans.
Text that merely looks like a reference is never resolved.

**2. A history entry is a counted referrer.** A profile's secret dies with the profile;
a history entry dies by _retention_, which is a different clock. If eviction silently
deleted the secret, cleaning up old history would revoke a credential still in use; if it
never did, the vault would accumulate orphans. Neither is acceptable as a default, so an
entry that holds a binding counts as a referrer in the same usage accounting the
connection surface already has — the secret survives eviction of the entry, and is deleted
deliberately from the vault inventory, which already shows who refers to it.

Note what this buys on the other side: **the reference itself is not sensitive.**
`sec:v1:system:f00a7d92…` is safe to store, display, export and index. For a _bound_
intent there is nothing to redact. Redaction is then needed for exactly two cases — output
(§9.1), and a command where the user declined to bind.

---

## 10. What the model makes possible

This section is not a feature list to build now. It is the evidence that §3's model is the
right one — each item is either nearly free on the seams above, or names the seam it still
needs. Build order is §12.

They are ordered by how much they change the daily experience, and the first four all live
in the same neglected moment: **before Enter.** Most of a terminal's memory is spent showing
you what already happened; the leverage is in what it can tell you while you can still
change your mind.

### 10.1 The environment indicator

`prod · deploy@10.0.0.4 · sudo · main` in the surface, always, with **explicit "context
unknown"** on any facet that is not actually known. The moment: the two seconds before you
press Enter on the wrong machine.

_Seam:_ `Environment` + per-facet `confidence` (§3.1), rendered. This is the cheapest item
here and arguably the highest-value, because without it `confidence` is an internal field
nobody benefits from and every other environment-aware feature appears out of nowhere. It is
also the honest one: a terminal that shows what it does not know beats one that projects
false precision — and false precision is exactly what a decorated shell prompt gives you
when it wraps, scrolls off, or lies after an `ssh` inside an `ssh`.

### 10.2 Guardrail: context before a destructive command

A command that would destroy something shows the environment diff **before** Enter — cwd,
endpoint, privilege, branch — without blocking. The moment: `rm -rf` typed one tab away from
where you thought you were.

The rule that keeps it from becoming wallpaper, and it is the whole design: **show always,
confirm rarely.**

- **Passive, always:** the affected facets are surfaced next to the pending command. No
  modal, no keystroke, no interruption.
- **Confirmation only when the situation is unusual**, not merely when the command is scary:
  `criticality != 'routine'` (§3.1), privilege elevated relative to the session's norm, or a
  key facet at `confidence='unknown'`.

Without that second rule this fires on every local `rm -rf node_modules`, is trained away
within a week, and then fails to fire on the one that mattered — which is precisely the
failure mode of a generic "are you sure?". The escalation condition is not about the verb,
it is about **where you are**, and that is a sentence only a design with `Environment` can
write.

_Seam:_ `criticality` + `confidence` + a destructive-shape classifier over the composed text
(CM6 shell mode already parses it). §10.5 covers rerun; this covers the first run, which is
where the damage actually happens.

### 10.3 Outcome annotation while typing

"This failed here twice; the variant that worked was `… REGION=eu`" — shown as you compose,
scoped to the environment and saying which rung it means. The moment: you are one keystroke
from repeating last week's mistake.

_Seam:_ §10.4's data, rendered at composition time rather than only inside the ranker.
Frequency-ranked history reliably promotes mistakes, because a command you got wrong three
times is frequent; outcome is the feature that fixes it, and showing it is cheaper than
being subtle about it in the ordering.

### 10.4 History that remembers outcomes, not just text

If `make deploy` failed twice in this environment and `make deploy REGION=eu` is its
successor that worked, recall offers the successor and annotates the failure.

_Seam:_ `status` + `edges` (`rerun-of`, `supersedes`) + the outcome feature in §8.4's scorer.

### 10.5 Rerun with provenance

Re-running an entry shows a diff of the environment then versus now — endpoint, user,
privilege, branch, k8s context — and demands confirmation only when a meaningful facet
changed. The moment: the command that was safe on staging does not silently become a prod
command.

_Seam:_ `Environment` facets + confidence. Unavailable to any design whose context is a
`host` string.

### 10.6 Recall as a ladder, not a filter

`↑` searches the exact environment first, then the host, then the repository, then globally,
**showing which rung it is on** and letting the user relax it. The moment: `↑` on prod
returns the last prod command, not yesterday's laptop command.

_Seam:_ `Environment` (§3.1) + `ledger.query{scope}`. This supersedes v2's open question
about scoping recall to exact cwd: neither answer was right, because the answer is a ladder.

### 10.7 Search over output

`Ctrl-R` searches what commands **printed**, not only what was typed. "Where did I see that
`EACCES`?" is a question every developer asks weekly and no terminal answers.

_Seam:_ derived text (§3.5) + FTS over it (§5.2). This is the single strongest item in this
section and the reason §3.5's retention rule inverted: search cannot find what retention
threw away, and the class filter v2 proposed would have discarded exactly the successful,
fast, three-week-old command the question is about. It is also why §9.1 exists — making
output searchable by substring is what turns a tolerable leak into a reachable one.

Coverage is stated in the result (§5.4), because a memory that silently forgets is worse
than one that admits a horizon.

### 10.8 The attention queue

A keyboard-reachable list of what actually needs the user: running too long, failed,
disconnected, finished while unfocused, unreviewed. The moment: come back from lunch, press
one shortcut, see the three things that matter instead of scrolling four tabs.

_Seam:_ lifecycle + status + `reviewed_at`. Nearly free. "Resolved" must be an explicit act —
inferring it from "a later command ran" is how such queues become noise.

### 10.9 Ask about this failure, in place

Focus a failed entry, invoke explain/fix; the agent's answer becomes the **next entry**,
cites the derived text artifact, and proposes a successor whose eventual shell result lands
on the same rails. Not a panel that reads your terminal — a participant in the same timeline.

_Seam:_ one timeline + `cites`/`caused-by` edges + derived text. This is the payoff that
justifies §2.4, and it is why the agent must not get its own transcript.

### 10.10 Reopening yesterday

Reopening an environment shows a reconstructed journal — commands, outcomes, retained
output, unresolved items — before a fresh PTY starts.

_Seam:_ durable entries + §3.5. v2's blanket session-locality made this impossible, which is
why §3.5 changed.

### 10.11 Lenses, and diffing two runs

Raw VT stays authoritative while registered transformers derive views: JSON tree, failing
tests, compiler diagnostics, changed files, URLs — including as a per-block inspector panel
rather than a separate surface.

The same seam gives **diff of two runs**: select two entries, compare their derived text or
the same lens over both. The moment: "what changed between the run that worked and the one
that didn't?" Diffing raw VT is meaningless — cursor moves and colour resets swamp the
signal — so this is a capability §3.5's derived text creates rather than exposes.

Manual A/B selection ships first; automatic pairing follows the `rerun-of` family for free.

_Seam:_ typed artifacts + `derivedFrom` + a transformer registry.

### 10.12 Export, and copy that knows where it came from

Export an entry as a markdown report — command, environment, status, duration, selected
output — honouring §9's sensitivity rules. This is the local-first answer to a cloud share
link, and it is what actually gets pasted into an issue or a chat.

Copy carries a **provenance edge**: text pasted into a later entry can record `cites` back to
the entry it came from, so "where did this ID come from?" has an answer months later.

_Seam:_ derived text + `cites`. Note the deliberate limit: the edge, **not** a clipboard
history surface — see §14.

### 10.13 Spans

An "incident" collects entries across sessions and hosts, exportable with redaction. _Seam:_
the `in-span` edge exists; the span row does not. `conversationId` is too agent-specific and
`sessionId` far too narrow.

Deferred — but note it now has **two** consumers, not one: incidents, and recalling a
procedure ("how did I do X?" is usually three commands, not one). Two consumers is the
threshold at which a deferred primitive should be reconsidered rather than re-deferred.

---

## 11. Blocks are views over entries

`BlockManager` consumes entries: `phase != 'closed'` renders the running block, `closed` the
frozen block with header, overflow menu and selection. `scrollback/controller.ts` keeps its DOM
work and forwards markers to `ShellDriver` — it stops owning the lifecycle. The live region and
alt-screen takeover are unchanged.

One product note carried from the review, and worth honouring: **blocks should not impose
visual weight on uninteresting work.** Hundreds of successful `ls` and `git status` calls
becoming manipulable cards is how a transcript turns into feed furniture. Emphasis belongs on
running, slow, failed, sensitive, pinned and unresolved entries; routine success should recede.
That instinct is already in ADR-0008's "landmarks, not cards", and it survives the pivot to DOM
rendering.

---

## 12. Work breakdown — two tracks that do not collide

The near-term goal, set by the owner on 2026-08-01, is **history, syntax highlighting, and
hints** in the command line. That is a different question from "which feature is the north
star", and the answer to it is the owner's.

The three decompose differently, which is what makes this order possible:

- **Highlighting and hints** depend on nothing in §3–§7. They need a decoration layer and a
  candidate source, and that is all.
- **History is a staircase.** Up/Down over the current session works on `command-ledger.ts`
  as it exists today. Surviving a restart is the ledger spine. Being scoped to where you are
  is `Environment`. Each step is a separate, shippable thing.

**The two tracks are disjoint by file** — the editor track lives in `editor.ts`, the CM6
extensions and the input surface; the memory track lives in `internal/content`,
`internal/transport` and `contracts/`. Their one collision is `terminal-content.ts`, which
E0 resolves before either track lands in it.

### Track E — the editor (the near-term goal)

| #   | Increment                                                                                              | Bead                         |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| E0  | `EntryDriver` extraction — frontend-only refactor that de-tangles the controller CM6 is about to enter | `nocx-rtg0.5`                |
| E1  | **ADR-0010** — a real decision with alternatives and one measurement in our own WebKitGTK webview      | `nocx-x5p`                   |
| E2  | CM6 swap W1–W5, behaviour-preserving                                                                   | `nocx-2gf`                   |
| E3  | **Highlighting** — composed intent + frozen headers; off when the target is not the shell              | `nocx-dgs`                   |
| E4  | **Provider registry + one ranker per target** (§8.4)                                                   | `nocx-w7h.2`                 |
| E5  | **Ghost text + dropdown** over that registry (§8.7)                                                    | `nocx-4ff.23`                |
| E6  | **Up/Down bound to recall** — session ledger first, the ladder when it exists (§10.6)                  | `nocx-w7h.1`                 |
| E7  | Overlay reachability (§8.1) and the explicit target chip (§8.2)                                        | `nocx-4ff.30`, `nocx-4ff.31` |

### Track M — durable memory (runs alongside, mostly Go)

| #   | Increment                                                        | Bead          |
| --- | ---------------------------------------------------------------- | ------------- |
| M0  | **Amend AD-1** (§6.1). No `ledger.*` method ships before it      | `nocx-m64b`   |
| M1  | ContentDB behind the existing stub — SQLite, WAL, one write path | `nocx-rtg0.1` |
| M2  | Schema v1 + `seq` as the only total order                        | `nocx-rtg0.2` |
| M3  | `ledger.*` with the immutable envelope, schemas in `contracts/`  | `nocx-rtg0.3` |
| M4  | The client outbox                                                | `nocx-rtg0.4` |
| M5  | Both ends of every interval + the startup sweep                  | `nocx-rtg0.6` |
| M6  | `command-ledger.ts` as cache, not a second writer                | `nocx-rtg0.7` |

**The tracks meet at E6** — and v5 said two incompatible things about it. The table promised
"session ledger first, the ladder when it exists", while the paragraph below said Up/Down
over a session-only history would ship the exact pain the domain ranks first — _I closed the
tab and lost it_ — dressed as a feature. Both positions stood in the document at once.

**v6 resolves it, and the resolution is the rung display.** E6 ships the _surface_ — the
overlay, the contracts of §8.9, the draft/preview/insert-not-execute state machine — before
Track M lands, and the scope indicator from §10.6 is what makes that honest: the overlay
says **"this session only"** at its head, in the same place it will later say "exact
environment". A history that states its scope is not pretending; a history that silently
returns one tab's worth while looking complete is. So the surface is not blocked on M, and
the _claim_ is bounded by what the store can back.

Track M is still what makes E6 worth having, which is why it runs alongside rather than
after — but the dependency is on the honesty of the label, not on the order of the work.

### Then, in order

| #   | Increment                                                                              | Bead          |
| --- | -------------------------------------------------------------------------------------- | ------------- |
| 1   | **Environment + indicator** (§3.1, §10.1) — makes recall and hints know where they are | `nocx-uahp`   |
| 2   | Ratify the model — ADR from `nocx-4ff.25` with §16's invariants                        | `nocx-4ff.25` |
| 3   | Capture and derived text (§7)                                                          | `nocx-2f0f`   |
| 4   | Privacy, both halves (§9, §9.1) — before anything indexes output                       | `nocx-jrdy`   |
| 5   | Search, attention queue, rerun with provenance (§10.5–§10.8)                           | `nocx-ms7v`   |
| 6   | The before-Enter surface — guardrail, outcome annotation (§10.2, §10.3)                | `nocx-euze`   |
| 7   | **Files and diffs as a viewer surface** — second CM6 consumer, `@codemirror/merge`     | _file_        |
| 8   | Lenses, diff of two runs, export, paste provenance (§10.11, §10.12)                    | `nocx-wp76`   |
| 9   | Streaming notifications, then agent mode                                               | `nocx-dw3.1`  |

Three constraints that survive the reordering, because they are about correctness rather
than priority:

- **Capture precedes search**, because search over output cannot be built over text that was
  never derived.
- **Privacy precedes anything that indexes output**, because an index built before redaction
  exists is an index that has to be discarded, and §9.1's leak is only reachable once search
  exists.
- **AD-1 precedes every `ledger.*` method.** M0 is not paperwork; without it the wire
  contradicts a binding invariant.

### A note on CodeMirror, and why the evidence changed the plan twice

The v3 plan front-loaded CM6 at increment 2 while §2.2 said highlighting and completion were
not the first increment — the document contradicted itself, deferring the features that need
CM6 while front-loading CM6 itself.

The evidence that settled it came from the neighbouring repos. **termic** — Tauri + React +
xterm, the closest analogue — uses CM6 heavily (13 language modes, `legacy-modes`, `lint`,
`search`, and `@codemirror/merge` for diffs) and uses it **entirely outside the terminal
input**: `DiffPane`, `EditorPane`, `MarkdownPane`, `RaceCompare`. **orca** chose Monaco, but
it is Electron + React with IDE-shaped panes, which nocx is not.

So the risky, unproven part is precisely what Track E does — CM6 _in the prompt line_, where
every risk in the `nocx-2gf` table lives (focus interplay with xterm, `defaultKeymap`
shadowing Enter/Escape/Ctrl-C, IME, measurement under `visibility:hidden`). None of those
exist for a read-only viewer.

That is why E1 is a real decision and not a formality: the de-risk spike W0 was **removed**,
so no measurement of CM6 in our own WebKitGTK webview exists — and ADR-0005's forced refresh
pump is evidence that this webview has opinions. ADR-0010 must carry the alternatives
(including textarea plus a mirrored highlight layer, which is genuinely cheaper if only
highlighting is wanted) and one measurement, before W1.

Eight beads need filing (marked _file_), plus one edit: `nocx-4ff.25`'s scope widens from
"DOM scrollback rendering" to the model in §16.

---

## 13. Testability

Two green suites can disagree about the wire, and an implementer's tests encode the
implementer's model. Both failure modes are documented in `AGENTS.md`, and both apply here
with force.

**Acceptance criteria are written as assertions, in the bead, before implementation:**

- After `ledger.open`, exactly one row; after a repeat with the same id, still exactly one.
- After `ledger.close` for an id never opened, exactly one row exists, `phase='closed'`, and
  its environment, cwd, kind and intent come from the envelope.
- A `bind` arriving after `close` leaves phase `closed` and is logged.
- On store open, a row with `phase='open'` is closed `unknown`.
- Two entries submitted in the same millisecond have distinct `seq`, and `ledger.query`
  returns them in submission order.
- With the socket dropped between submit and `open`, the entry appears after reconnect with
  its envelope intact.
- Entry A's text artifact contains every line between A's start marker and A's end marker
  and no line belonging to B — asserted by freezing two blocks back to back, not by
  feeding frames. _(v5 asserted this over a byte frame containing A's tail, `OSC 133 D`, a
  prompt and B's first bytes. That test described a mechanism §7.2 withdrew.)_
- A command run while the alternate buffer is active produces no text artifact, and the
  assertion holds without any alt-screen-specific code in the capture path.
- A command whose output exceeds the scrollback buffer seals with `truncated='cap'` and
  the artifact's first retained line is **reported honestly** — either the true head or a
  declared loss. Returning a tail while claiming head-and-tail fails this test (§7.3).
- A command typed with a leading space produces no row, no artifact and no suggestion —
  asserted by querying the store afterwards, not by inspecting a flag.
- An intent with a bound secret stores `sec:v1:…` plus its byte span; rerun substitutes
  from the span and produces the original command. Text in the _output_ that matches the
  `sec:v1:` shape is never resolved.
- Evicting the entry that holds a binding does not delete the secret from the vault, and
  the vault inventory still counts that reference.
- After eviction, `ledger.search` reports coverage derived from the retention watermark —
  asserted by evicting rows and then reading a number that could not have been computed
  from the rows that remain.
- Opening the database with the ContentDB keychain item absent: the PTY still starts, the
  UI says durable memory is unavailable, and no command is blocked.
- A command whose text matches a secret shape is `sensitive` **before** submission, produces
  no artifact, and never appears as a suggestion.
- With ContentDB returning an error on every write, the command still runs.
- `ledger.query` with no matches returns `{"entries": []}` over the real socket, asserted
  against the schema rather than a fixture.
- With no shell integration, the overlay is reachable by shortcut and no inline editor appears.
- An entry whose output is 10× the per-entry cap seals with `truncated='cap'`, and both its
  first and last retained lines are present — the cap drops the middle, not the tail.
- After eviction removes an artifact, `ledger.search` for a string that was only in that
  artifact returns no hit **and** a `coverage` that reports the entry as unsearchable. A hit
  pointing at absent content fails this test.
- Eviction deletes the artifact and its FTS row in one transaction: after a forced crash
  mid-eviction, no index row survives without its artifact.
- Output containing a token-shaped string is redacted in the derived artifact before it is
  written, and a substring search for the token returns nothing.
- "Forget this output" drops the artifact and its index row, and the entry survives.
- A destructive command in a `routine` environment with no elevated privilege shows the
  context and requires **no** confirmation; the same command with `criticality='critical'`
  requires one. Both assertions are needed — the first is what keeps the second effective.
- A facet at `confidence='unknown'` renders as unknown in the indicator, never as absent and
  never as a guess.

**Dependency-failure paths are exercised.** For every external call — store write, store read,
RPC send, keychain (none here, by design) — there is a test where it fails. The vault review
found five of ten defects in exactly the paths nobody made fail.

**The implementer does not author the acceptance criteria.** They are assertions in the bead so
nothing is left to interpret, and the wire tests drive the real method through the real socket.

**Reachability is checked.** One `grep` for the caller of every new symbol, and the composition
root read to confirm ContentDB is wired. §1.4 exists because that check was skipped once
already in this document's own history.

---

## 14. Deliberately out

- **Agent mode, actions/Spotlight providers.** Seams only.
- **Remote PATH and remote path completion.** Needs a listing channel (§8.5).
- **Spans as a stored primitive** (§10.13) — the edge exists, the row does not. Now with two
  waiting consumers (incidents, procedure recall), so it is a re-decision rather than a
  standing deferral.
- **Chain recall — "how did I do X?" as a sequence.** Blocked on spans, above. Recall returns
  one entry until a span can return several.
- **A clipboard history surface.** The provenance _edge_ ships (§10.12); a clipboard manager
  does not. It would be a second secret-bearing store with its own retention, privacy and UI,
  duplicating what every OS already provides, to buy the 5% of the value the edge does not
  already capture.
- **"Select text → explain"** — travels with agent mode; the `cites` seam is already there.
- **A block inspector as a separate surface.** It is §10.11's lenses with a panel; building it
  as its own thing would create a second vocabulary for one concept, which is the defect two
  kit epics were spent unwinding.
- **Job control / durable remote job handles.** OSC markers cannot prove remote process
  identity; doing this honestly needs an explicit job protocol or a Tier-B helper, and
  pretending `cmd &` is manageable would be worse than not offering it.
- **HISTFILE import.** A deferred option; the ledger is the source of truth either way.
- **Database encryption at rest.** Named in §5.5, decided in §17.
- **Configuration migrating into ContentDB.** ADR-0011 §5 forbids it.
- **Secure erasure.** "Removed from nocx" is the wording until vacuum behaviour is designed.

---

## 15. Where this design disagrees with its review

The adversarial review that produced v3 was right about the eleven things listed at the top.
It was also wrong, or premature, about four, and recording that is part of the design:

**1. Splitting `Entry` into Intent / Attempt / Observation is rejected for now.** The
motivating cases are real — a retry, a fan-out across five hosts, an intent rejected before
execution — but `edges` (§3.4) expresses all of them at a fraction of the cost, and a
three-table activity model with no consumer is speculative structure of exactly the kind this
repo forbids. The trigger to revisit is concrete: **the first kind that produces more than one
attempt per intent**, which is fan-out, and which is not in scope. Until then a retry is a new
entry with a `rerun-of` edge, which is also what the user sees.

**2. The `kind` discriminator stays a closed set.** Open type-ids with schema-versioned
payloads sound more extensible and mean, in practice, that nothing validates a payload. Adding
an arm to a union is a one-line change plus a contract; that is a cost worth paying to keep the
model checkable. `v` on each payload (§3.3) handles evolution within an arm.

**3. "One ranker" was not abandoned, it was scoped.** The review was right that ranking across
kinds changes behaviour rather than order. It does not follow that each provider sorts its own
list — that is the failure the original rule targeted. §8.4's resolution keeps one scoring
function and confines it to the active target.

**4. The seam test survives, softened.** "Only one module may change" is too rigid; §2.6 now
states the goal as localised, intentional evolution. But the test is kept, because the
alternative — no test at all — is how a design ends up with the lifecycle inside an OSC
handler.

---

## 16. Invariants for `nocx-4ff.25`

The ADR that ratifies this model must state these, because each is a decision a later change
would silently reverse:

1. **One timeline, with relations.** Every submitted intent is an entry with one id, one
   lifecycle vocabulary and one query surface, regardless of kind; causality lives in edges,
   and the timeline, a session, a conversation and an incident are all projections.
2. **Context identity is stable and confidence-bearing.** Recall keys on an `Environment`,
   never on a session id, and every facet carries how well it is known.
3. **Kind facts live in the payload.** No kind-specific field is hoisted onto the entry.
4. **The lifecycle is owned by a driver.** The terminal controller forwards markers and knows
   nothing else about phases.
5. **Every interval has two ends.** An entry is `open` until its driver reports an outcome,
   its session ends, the app shuts down, or a timeout expires — and nothing else.
6. **The ledger never blocks execution.** A command runs before it is recorded.
7. **Order comes from a backend sequence.** Wall time is presentation.
8. **Output is retained as text, within a budget the user sets**, head-and-tail capped —
   and not at all for an environment the user marked `critical` (§7.4).
9. **Output is serialized from the buffer at block freeze, on the parser's clock** — never
   cut out of the byte stream. _(v5's invariant 9 said the opposite and is **withdrawn**:
   it fixed a mechanism that existed only to solve a problem the buffer path does not
   have. §7.2.)_
10. **Privacy is decided before handoff** and governs intent, capture, suggestions, export and
    agent context as one decision — **and again on the way out**, because secrets arrive in
    output that was never typed (§9.1).
11. **A memory states its horizon**, and can only do so because eviction leaves a durable
    watermark behind (§5.4). Search reports what retention still covers; it never answers
    "not found" for something it simply no longer keeps.
12. **Target selection is explicit.** No prefix reinterprets shell input, and no unavailable
    shell target silently becomes something else.
13. **Editor presence is reachability, not occupancy.** Inline only when the shell vouches;
    reachable by shortcut always; never inline in alt-screen.
14. **Warnings escalate on where you are, not on how the command looks.** A guardrail that
    fires on the verb alone is trained away before it is ever needed.
15. **Derived facts may cross the control plane; bytes may not** (AD-1 as amended, §6.1).
16. **The store is encrypted, and its key is not the vault's** (ADR-0018). A sealed vault
    withholds authenticators; it never withholds memory.
17. **A secret in a command is bound, not retyped or invented.** The `sec:v1:…` reference
    is reused verbatim, the Vault remains the only minter, substitution applies stored
    byte spans rather than searching text, and a history entry counts as a referrer
    (§9.2).
18. **A leading space means the entry does not exist.** Not redacted, not stored
    unindexed — not recorded (§9).
19. **Recall inserts; it never executes.** Enter in the overlay puts the command in the
    editor and stops there (§8.10).
20. **Unknown is never a match.** A facet at `confidence='unknown'` cannot satisfy a rung
    of the recall ladder, cannot make a provider applicable, and renders as unknown rather
    than as absent (§8.5, §8.9, §10.1).
21. **A provider declares where it applies, and is silent elsewhere.** Labelling a
    candidate that does not apply to the current environment is not a substitute for not
    offering it (§8.5).
22. **Recall shows a substitute as a substitute.** When outcome evidence promotes a
    successor over the command the user reached for, the original stays visible (§8.10).

---

## 17. Open — needs the owner's decision

1. **Tab** (§8.7) — **re-posed in v6, because the previous proposal was impossible.** v5
   offered "`Tab` opens the dropdown or falls through to the shell". The fall-through cannot
   be built: the editor owns the text and the shell's line buffer does not have it, so a raw
   `\t` completes a stale buffer. The question is now which of three we take — (1) our
   dropdown only, sending nothing when there are no candidates, with an explicit route into
   a native-input mode; (2) a per-shell completion adapter that syncs the buffer; (3) an
   explicit native-input mode where the shell owns the line. Proposal: **(1) now, (3) next**
   — (2) is a per-shell maintenance surface that should not be entered without evidence
   users want it. Until (2) or (3), nothing may promise shell-native completion.
2. ~~**Database encryption at rest**~~ — **CLOSED 2026-08-01, ADR-0018.** Encrypted, via
   SQLCipher. The objection recorded here (a sealed-vault dependency on every read,
   including recall at startup) was correct and is what forced the resolution: the
   ContentDB key is **not** a vault secret and is not governed by auto-seal. Remaining
   sub-decision, and it cannot be deferred past database creation: `auto_vacuum`
   (§5.4).
3. **Redaction patterns** (§9, §9.1) — **partly closed.** The three levels are decided
   (leading space suppresses; confident match asks; weak match retains but does not
   index), which answers the "indexing only or retention as well" half. What remains is
   the pattern set itself, and the first move there is to read Atuin's `secrets_filter`
   rather than to invent one.
4. **Retention defaults** (§5.4). The knobs are the user's; the defaults are ours and are what
   most people will live with. Proposal: output retained, total size the primary cap,
   head+tail per entry, age unbounded until size bites. The numbers need measuring against a
   real week of use rather than assuming.
5. **Attention-queue resolution** (§10.8). Explicit dismissal only, or also a rule (e.g. a
   successful successor auto-resolves a failure). Auto-resolution risks hiding what matters.
6. **Who sets `criticality`** (§3.1). Proposal: a checkbox on the connection profile plus a
   per-environment override, and never derived. The alternative — inferring "production" from
   a hostname — is wrong in both directions and unfixable by the user when it is.
   **Raised in weight by v6:** this field now also decides whether output is captured at
   all (§7.4), so it is no longer only a warning threshold.
7. **Frontend byte memory.** Bounded by the artifact caps; the number needs measuring. The DOM
   half is already bounded by the spike's 6.4 µs/line serialization.
8. **The head of an over-long output** (§7.3). Size the xterm scrollback to cover the
   per-entry cap, or serialize the head incrementally once the block has produced enough
   lines. A measurement, not a preference — but §3.5's cap is dishonest until it is
   answered.
9. **The loss policy** (§4.5, §6.4). "The ledger never blocks execution" forces a choice
   between losing entries, unbounded memory, and a local spool; backpressure on the
   terminal is forbidden. Which one, how much, and how the user is told, is a product
   contract rather than a property of the writer goroutine — and v5 left it unstated.
10. **The full-text indexing unit** (§5.2, §10.7). External-content FTS does not index
    `artifact_chunks` as one document by itself. One row per chunk breaks ranking,
    snippets and phrases spanning a boundary; one row per artifact means rebuilding the
    document on append. Proposal: **index at seal, not per chunk** — live output stays
    visible to the UI, durable search becomes complete once the block freezes. Related and
    unanswered: FTS5 matches tokens and prefixes, not arbitrary substrings, so a promise
    of substring search needs trigrams and their cost in index size, reindex time and
    privacy surface.

---

## 18. References

- ADR-0004 — input ownership + pluggable editor (and its rejection of magic prefixes);
  ADR-0006 — marker-only prompt; ADR-0008 — command blocks as a keyboard-first ledger
  (revised by `nocx-4ff.25`); ADR-0011 — persistence capabilities and secrets as opaque
  references.
- `docs/architecture.md` — AD-1 (amended by §6.1), AD-6, AD-7, AD-8, AD-9.
- `2026-07-25-editor-core-codemirror6-design.md` — the CM6 swap (epic `nocx-2gf`).
- `2026-07-24-warp-editable-command-input-design.md` — input-ownership safe-enable.
- `spike/dom-scrollback/REPORT.md` — the rendering spike this model came from.
- `contracts/README.md` — the wire-contract convention and its three checks.
- `internal/content/content.go`, `internal/content/stub.go` — the ContentDB capability, stubbed.
- `frontend/src/command-ledger.ts`, `frontend/src/input-state.ts`,
  `frontend/src/input-target.ts`, `frontend/src/scrollback/*`, `frontend/src/ipc.ts` — current
  implementation.
