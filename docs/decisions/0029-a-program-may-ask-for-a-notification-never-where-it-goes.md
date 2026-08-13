# ADR-0029 — A program may ask for a notification; it may never choose where it goes

- **Status:** Proposed
- **Date:** 2026-08-13
- **Related:** AD-1 (this amends it), AD-6 (unchanged — see §4.4), AD-8 (one owner per
  behaviour), ADR-0024 (this carves out of it), ADR-0017 (a connection references a
  secret), ADR-0003 (no Developer ID), beads `nocx-uz7f` (the brainstorming session),
  `nocx-ywhp` (program-scoped grants — deliberately not reused, §4.5), `nocx-sb3f`
  (the transport's third delivery class).
- **Design:** `.internal/specs/2026-08-13-notification-system-design.md`
- **Consulted:** an adversarial review (codex, two rounds, 2026-08-13). Its second round
  broke the first version of the amendment on three counts and supplied better wording
  for each; §5 records what was taken and what was left, because the parts left out were
  left out on purpose and the next reader should not have to re-litigate them.

## 1. Context

A program running in a pane can print `OSC 9` or `OSC 777` to ask its host terminal to
raise a notification. This is how a TUI notifies you from a machine you reached over
ssh — it is bytes on the pty, so it survives ssh, tmux and any nesting. nocx is the host
terminal, and today it registers OSC 7, 52, 133, 636 and 1337 and neither 9 nor 777, so
the request does nothing.

The design that consumes this (`nocx-uz7f`) has four sinks. Two of them — the macOS
banner through the Wails runtime, and an outbound HTTP push to a service like Bark, ntfy
or a Telegram bot — live in the Go backend, because the OS API and the vault both do.
**So the program's message text must reach the backend.** Toast and sound could stay in
the renderer; those two cannot. There is no arrangement of the feature that avoids it.

Two binding documents stand in the way, and both were right when they were written:

- **AD-1** says `cwd/OSC/prompt markers do not cross the control plane — they stay
frontend-side`. It was amended once already (2026-08-02, `nocx-m64b`) to let typed
  ledger facts cross, ending with `no frontend-derived fact may carry or reconstruct the
output it was derived from`.
- **ADR-0024** says `PTY output is render-only`. Raising a banner or issuing an HTTP
  request is an effect caused by output, even when it forges no lifecycle state.

Claiming compliance with either would be false. The repository's own rule applies: if an
invariant is wrong, change it deliberately rather than route around it.

## 2. Decision

**A program may request a notification. It may never influence where that notification
goes.** Two documents change.

### 2.1 AD-1 — new bullet, alongside the ledger-facts amendment

> **A notification request may cross the control plane** (amended 2026-08-13, ADR-0029).
> A program may ask the terminal to raise a notification (OSC 9, OSC 777). The renderer
> parses the sequence — the backend never receives the escape — and MAY send a
> schema-checked `notify.raise` record with `additionalProperties: false`. Four rules
> bound it, and none is optional:
>
> **Provenance.** Only `title` and `body` may originate in the parsed OSC payload. `kind`
> is fixed by the source adapter; session identity comes from the authenticated transport
> context; host, tab, program attribution, timestamp, trust class and severity are stamped
> or validated by nocx and can never be supplied by the value.
>
> **Noninterference, stated differentially because that is what a test can check.** For
> any two valid payloads differing only in `title` or `body`, the router MUST select the
> same sinks, the same target identifiers, the same credentials, the same request
> destination, the same method and the same delivery policy. Payload content may affect
> only validation, bounded-size handling, redaction, context-specific encoding, and the
> bytes handed to the selected sink.
>
> **Destination.** Stream-derived fields MUST NOT participate in URL construction —
> scheme, userinfo, host, port, path, query or fragment — and MUST NOT select a redirect
> target. The complete request URL derives only from user configuration and trusted target
> metadata. Redirects are refused, or every redirect target is revalidated under this same
> rule.
>
> **Retention, with both ends of the interval named.** nocx MUST NOT write a notification
> instance or its `title`/`body` to its databases, its configuration, a durable queue or a
> structured log. An instance exists in bounded memory from the moment it is created until
> every selected sink has completed or failed, and no retry survives process exit —
> delivery is at-most-once. Retention performed by an external sink the user selected, or
> by the operating system's notification centre, is outside nocx's storage ownership and
> is disclosed in that sink's UI.

### 2.2 ADR-0024 — carve-out

> A parsed terminal sequence MAY request a bounded, attributed presentation effect that
> has been expressly registered for that sequence. The request remains untrusted program
> output: it cannot assert nocx state, authenticate a lifecycle event, grant authority,
> alter input ownership, or select an external destination. Presentation is the whole of
> what it may cause.

### 2.3 The value's category

The backend treats `title` and `body` as **untrusted presentation data** — never as
control data, and never as an opaque blob it may concatenate. A sink MAY validate size
and Unicode, redact under the single redaction policy, and encode the fields for one
fixed, sink-defined payload position. A sink MUST use a context-specific encoder — JSON
string encoding, HTTP field-value validation, raw-body writing, or percent-encoding of
exactly one path segment — and MUST NOT concatenate either field into protocol syntax, nor
parse it as a URL, template, header set, method, credential, routing key or configuration.

## 3. What this does not authorise

**An inferred state transition is not a notification request.** `frontend/src/agent-status.ts`
classifies an OSC 0/2 terminal title into `working` / `idle`. Turning a `working → idle`
transition into nocx asserting that work finished is precisely what ADR-0024 forbids — and
it is a worse offence than OSC 9, because OSC 9 at least asks. This amendment covers
explicit requests only.

Consequently every event carries a `trust` class, owned by the source adapter and
unreachable from payload content:

| `trust`          | Sources                              | May reach                                                          |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `attested`       | `block.finished`, `session.ended`    | every sink; may close a one-shot subscription                      |
| `programRequest` | `program.notify` (OSC 9/777), `bell` | every sink; may **not** close a completion subscription            |
| `heuristic`      | `pane.workFinished`                  | local attention only — toast, badge, tab dot. Never the push sink. |

Three values, one field, and one column in the routing table. Not a declaration protocol
on every sink: the outcome needed is a rule, and a rule is what this is.

## 4. Rationale

**4.1 Why not keep everything in the renderer.** Two of the four sinks are backend-only by
construction — `runtime.SendNotification` needs the Wails host, and a push token lives in
the vault. A renderer-only design delivers in-window toasts and nothing else, which is
neither the herdr "notify through the terminal" case nor the phone.

**4.2 Why the differential test, and not "the backend never interprets the value."** That
was the first version, and it fails twice. It is unenforceable — no test can prove the
absence of semantic interpretation across all future code. And it is false inside its own
design: coalescing and redaction both inspect the value by necessity. Stating
noninterference as an equivalence over pairs of payloads makes it a property-based test
that can actually fail: generate hostile pairs differing only in `title`/`body`, assert
identical routing traces and request metadata, allow differences only in the encoded
payload bytes.

**4.3 Why the destination rule enumerates URL components.** "The destination is
user-configured" sounds sufficient and is not, because _where_ is undefined — authority?
initial URL? redirect target? The design's first draft gave targets a free-form
`urlTemplate` accepting `{{body}}`, so `https://{{body}}/notify` handed the authority to
program output, and `https://gateway/?next={{body}}` did the same through a query
parameter. Naming every component, plus redirects, is what makes the rule checkable.
It also settles the design: `{{title}}` and `{{body}}` are removed from URL construction
entirely, and Bark — which wants content in a path segment — gets a preset that appends
exactly one percent-encoded segment rather than a licence to template.

**4.4 Why AD-6 does not change.** AD-6 says the backend never interprets the bytes a
session produces. It still does not: it receives a string that was parsed elsewhere, and
it does not parse it. Nothing in AD-6 became false, and amending a correct invariant to
restate a neighbouring one costs clarity for nothing. Two documents change, not three.

**4.5 Why not a program-scoped grant (`nocx-ywhp`).** That epic decides consent for an
action a program takes _on the user's behalf_ — writing their clipboard. Here the program
takes no action; it asks, and a routing rule the user set decides whether anything
listens. Layering a per-program consent dialog over a routing rule the user already
configured would be a second model for one decision, which is the failure AD-8 exists to
prevent. Recorded rather than assumed, per the repository's reuse rule: it was considered
and did not fit. If `nocx-ywhp` later generalises from "clipboard" to "program-initiated
requests" as a category, this is a candidate to fold in.

**4.6 The residual risk, accepted deliberately.** Once a user routes terminal-sourced
events to push, any host they ssh into can put text on their phone. It is bounded by three
things and no more: the destination is theirs, the rate limit is per source, and every
notification carries nocx-stamped attribution saying which tab, host and session it came
from. Without attribution, `Ваш банк: подтвердите вход` from a hostile MOTD is
indistinguishable from the user's own alert — which is why attribution is a schema
requirement here and not a nicety.

## 5. What the review supplied, and what was left

Taken: the differential noninterference test (§2.1), the enumerated destination rule and
the removal of payload variables from URL construction (§2.1, §4.3), "untrusted
presentation data" in place of "opaque string" (§2.3), per-context encoders with CR/LF/NUL
rejection and size bounds (§2.3), the schema clause fixing who owns `kind`, `level` and
attribution (§2.1), and the demotion of `pane.workFinished` (§3).

Left, on purpose:

- **A three-class provenance taxonomy with per-sink accept declarations.** The outcome
  needed is one rule; §3 is that rule as a field and a column. A declaration protocol on
  every sink is machinery for a single instance.
- **Amending AD-6.** §4.4.
- **A separate invariant that sinks do not own routing.** That is AD-8 restated; the design
  already makes the router the only holder of "where".
- **A twenty-item partial-failure enumeration** from the first round. The demand is
  legitimate and is AGENTS.md rule 3; the list was not, because half of it described secret
  rotation flows this design does not have. The design enumerates its own intervals.

## 6. Consequences

- **`notify.raise` gets a JSON Schema in `contracts/` in the commit that adds the method**,
  with `additionalProperties: false` and an explicit `required` — and the
  `…_OverTheWireConformsToContract` test, because the schema is what makes the provenance
  rule enforceable rather than advisory.
- **A property-based differential test becomes a gate** for the router. It is the executable
  form of §2.1 and the reason that clause is not decoration.
- **The push sink cannot be built from a generic template engine.** Each preset declares
  its payload position and its encoder. Bark, ntfy and Telegram differ in where the secret
  and the content go, and that is schema, not configuration.
- **`pane.workFinished` cannot satisfy "notify me when this block finishes."** A user
  attaching a one-shot subscription on a session without shell integration is offered
  nothing, rather than offered a guess.
- **`mac.ShowNotification` is forbidden** — it interpolates the body into an AppleScript
  string literal, and our bodies are program-chosen. `runtime.SendNotification` is the only
  path.
- **A dock badge and a single attention bounce need our own cgo.** Wails v2.13 exposes
  neither (`dockTile`, `badgeLabel` and `requestUserAttention` are absent from the whole
  module). They are the only surface that persists until the user looks, since the design
  has no notification centre — the badge counts tabs with unseen activity, which is
  existing state, not new bookkeeping.
