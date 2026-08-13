# ADR-0029 — A program may ask for a notification; it may never choose where it goes

- **Status:** Proposed
- **Date:** 2026-08-13 (revised 2026-08-14 after a third review round)
- **Related:** AD-1 (this amends it), AD-6 (unchanged — see §4.4), AD-8 (one owner per
  behaviour), ADR-0024 (this carves out of it), ADR-0017 (a connection references a
  secret), ADR-0011 (§4, delete-cascade ordering), ADR-0003 (no Developer ID), beads
  `nocx-uz7f` (the brainstorming session), `nocx-ywhp` (program-scoped grants —
  deliberately not reused, §4.5), `nocx-sb3f` (the transport's third delivery class).
- **Design:** `.internal/specs/2026-08-13-notification-system-design.md`
- **Consulted:** an adversarial review (codex, three rounds, 2026-08-13/14) and the owner.
  §5 records what was taken and what was left, because the parts left out were left out on
  purpose and the next reader should not have to re-litigate them.

## 1. Context

A program running in a pane can print `OSC 9` or `OSC 777` to ask its host terminal to
raise a notification. This is how a TUI notifies you from a machine you reached over
ssh — it is bytes on the pty, so it survives ssh, tmux and any nesting. nocx is the host
terminal, and today it registers OSC 7, 52, 133, 636 and 1337 and neither 9 nor 777, so
the request does nothing.

The design that consumes this (`nocx-uz7f`) has five sinks. Two of them — the macOS banner
through the Wails runtime, and an outbound HTTP push to a service like Bark, ntfy or a
Telegram bot — live in the Go backend, because the OS API and the vault both do. **So the
program's message text must reach the backend.** Toast could stay in the renderer; those
cannot. There is no arrangement of the feature that avoids it.

Two binding documents stand in the way, and both were right when they were written:

- **AD-1** says `cwd/OSC/prompt markers do not cross the control plane — they stay
frontend-side`. It was amended once already (2026-08-02, `nocx-m64b`) to let typed ledger
  facts cross.
- **ADR-0024** says `PTY output is render-only`. Raising a banner or issuing an HTTP request
  is an effect caused by output, even when it forges no lifecycle state.

Claiming compliance with either would be false. The repository's own rule applies: if an
invariant is wrong, change it deliberately rather than route around it.

## 2. Decision

**A program may request a notification. It may never influence where that notification
goes.** Two documents change.

### 2.1 AD-1 — new bullet, alongside the ledger-facts amendment

> **A notification request may cross the control plane** (amended 2026-08-14, ADR-0029).
> A program may ask the terminal to raise a notification (OSC 9, OSC 777). The renderer
> parses the sequence — the backend never receives the escape — and MAY send a
> schema-checked `notify.raise` record with `additionalProperties: false`. Five rules bound
> it, and none is optional:
>
> **Provenance is structural, not validated.** The wire record carries **only** the fields
> the renderer is authorised to originate: `title` and `body`. `kind`, `trust`, `level`,
> attribution and timestamp are **absent from the wire** and stamped by the backend from the
> method invoked and the authenticated session context of the connection. A schema proves
> the shape of a record, never who assigned a field — so the protected fields are not on the
> wire to be forged.
>
> **Noninterference, stated differentially because that is what a test can check.** For any
> two **schema-valid** payloads differing only in `title` or `body`, route resolution MUST
> produce the same sinks, the same target identifiers, the same credentials, the same
> request destination and the same method. Route resolution completes **before** any
> sink-level validation; a sink that then rejects a payload for size or encoding records an
> attempted delivery that failed, and never removes itself from the resolved set. Payload
> content may affect only validation outcomes, redaction, context-specific encoding, and the
> bytes handed to a selected sink.
>
> **Destination.** Stream-derived fields — `title` and `body` — MUST NOT participate in URL
> construction in any position: scheme, userinfo, host, port, path, query or fragment. This
> rule is absolute and admits no per-provider exception; a provider whose only endpoint
> places message content in the URL is out of scope until it offers one that does not.
> Redirects are refused. The request URL derives only from user configuration, trusted target
> metadata, and secrets (below).
>
> **Secret-bearing URLs.** A user-configured secret MAY occupy a URL position where the
> provider requires it (a Telegram bot token is a path segment). The composed URL is then
> secret-bearing, and: it is never persisted composed — the stored `endpoint` is a template
> with a slot resolved from the vault per request; it is never written to a log, a
> diagnostic, or an error surface; a delivery failure names the **target by name**, never its
> URL; and it is never followed across a redirect, which is the second and independent
> reason redirects are refused.
>
> **Retention, with a closing event and not merely a predicate.** nocx MUST NOT write a
> notification instance, its `title`/`body`, or a composed secret-bearing URL to its
> databases, its configuration, a durable queue or a structured log. **Every sink invocation
> carries a finite deadline, and expiry converts to failure** — so the instance exists in
> bounded memory from creation until every selected sink has completed, failed, or timed out,
> which is an event that always occurs. No retry survives process exit: delivery is
> at-most-once. Retention performed by an external sink the user selected, or by the
> operating system's notification centre, is outside nocx's storage ownership and is
> disclosed in that sink's UI.

### 2.2 ADR-0024 — carve-out

> A parsed terminal sequence MAY request a bounded, attributed presentation effect that has
> been expressly registered for that sequence. The authorised effects are exactly: rendering
> a message in nocx's own surfaces, delivering it to a notification destination the user
> configured, raising an operating-system notification, and — on the user activating that
> notification — focusing the originating tab. Obtaining the destination's secret and
> performing the network I/O that delivery requires are consequences of the above, not
> additional authorities. The request remains untrusted program output: it cannot assert
> nocx state, authenticate a lifecycle event, grant authority, alter input ownership, or
> select a destination.

### 2.3 The value's category, and who may encode it

The backend treats `title` and `body` as **untrusted presentation data** — never as control
data, and never as an opaque blob it may concatenate.

**Routing is resolved once, in the router, before any sink is invoked.** A sink receives an
immutable resolved destination together with the presentation fields. A sink MUST NOT select
a target, a credential, a method, a retry policy, an alternate destination, or a redirect
target. This is stated here rather than left to AD-8 because destination work — redirect
handling, provider-specific path construction — otherwise settles naturally inside sink code.

A sink MAY validate size and Unicode, redact under the single redaction policy, and encode
the fields for one fixed, sink-declared payload position. A sink MUST use a context-specific
encoder — JSON string encoding, HTTP field-value validation, raw-body writing, or
percent-encoding — and MUST NOT concatenate either field into protocol syntax, nor parse it
as a URL, template, header set, method, credential, routing key or configuration. **CR, LF
and NUL are rejected in every position, in every sink**, and an invalid payload fails
visibly rather than falling back to concatenation.

## 3. What this does not authorise

**An inferred state transition is not a notification request.** `frontend/src/agent-status.ts`
classifies an OSC 0/2 terminal title into `working` / `idle`. Turning a `working → idle`
transition into nocx asserting that work finished is precisely what ADR-0024 forbids — and it
is a worse offence than OSC 9, because OSC 9 at least asks. This amendment covers explicit
requests only.

Consequently every event carries a `trust` class, stamped by the source adapter and absent
from the wire:

| `trust`          | Sources                              | May reach                                                          |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `attested`       | `block.finished`, `session.ended`    | every sink; and completion subscriptions (below)                   |
| `programRequest` | `program.notify` (OSC 9/777), `bell` | every sink; never a completion subscription                        |
| `heuristic`      | `pane.workFinished`                  | local attention only — toast, badge, tab dot. Never the push sink. |

**Only an `attested` event may match, activate, deliver through, or disarm a completion
subscription.** Stating only that a heuristic event cannot _close_ one leaves a hole: the
event still matches the subscription, adds its sinks, inherits the explicit-gesture
suppression override, delivers — and leaves the subscription armed, so the real completion
delivers again. A guess must not reach a privileged route at all, not merely fail to
terminate it.

The routing table is **default-deny**: a `(kind, trust)` pair reaches a sink only where a row
says so, and the same table governs the ordinary route and the ad-hoc subscription route.
That is the enforcement boundary, and it is one table rather than an accept-declaration
protocol on every sink.

## 4. Rationale

**4.1 Why not keep everything in the renderer.** The OS banner needs the Wails host and a
push token lives in the vault. A renderer-only design delivers in-window toasts and nothing
else, which is neither the "notify through the terminal" case nor the phone.

**4.2 Why the differential test, and not "the backend never interprets the value."** That was
the first version, and it failed twice: unenforceable, because no test proves the absence of
semantic interpretation across all future code; and false inside its own design, because
coalescing and redaction must inspect the value. Stating noninterference as an equivalence
over pairs makes it a property test that can fail. Two details are load-bearing. The property
ranges over every **schema-valid** input, not every input a sink would accept — otherwise the
generator excludes oversized and invalid-UTF-8 cases, which are exactly the ones that could
diverge. And it compares **route resolution**, which is ordered before sink validation, so a
size rejection is a failed delivery rather than a changed sink set.

**4.3 Why the destination rule is absolute, and what it costs.** "The destination is
user-configured" sounds sufficient and is not, because _where_ is undefined. Naming every URL
component makes it checkable. The first revision then granted Bark a payload-derived path
segment and contradicted itself in the same document — percent-encoding prevents injection,
it does not make the destination independent of the payload. The resolution is not to weaken
the rule but to change the endpoint: Bark's JSON `POST /push` carries `device_key`, `title`
and `body` in the body, so nothing stream-derived touches the URL. Telegram already fits —
its bot token is a _secret_ in the path, not stream-derived — and ntfy fits with the topic in
the path and the message in the body. An absolute rule is worth more than a rule with one
exception, because only the first can be tested by construction.

**4.4 Why AD-6 does not change.** AD-6 forbids the backend to interpret the **bytes a session
produces**, and it still does not: the escape sequence is parsed in the renderer and the
backend never sees it. What the backend does with the resulting typed value — validate,
redact, coalesce, bound, encode — is interpretation of a value, which AD-6 never spoke to. An
earlier revision defended this as "it receives a string and does not parse it", which was the
same overclaim the rewrite existed to remove. AD-6 is untouched because it is about a
different object, not because the backend is inert.

**4.5 Why not a program-scoped grant (`nocx-ywhp`).** That epic decides consent for an action
a program takes _on the user's behalf_ — writing their clipboard. Here the program takes no
action; it asks, and a routing rule the user set decides whether anything listens. Layering a
per-program consent dialog over a routing rule the user already configured would be a second
model for one decision, which is the failure AD-8 exists to prevent. Recorded rather than
assumed, per the repository's reuse rule: it was considered and did not fit. If `nocx-ywhp`
later generalises from "clipboard" to "program-initiated requests" as a category, this is a
candidate to fold in.

**4.6 The residual risk, accepted deliberately.** Once a user routes terminal-sourced events
to push, any host they ssh into can put text on their phone. It is bounded by three things
and no more: the destination is theirs, the rate limit is per session and kind, and every
notification carries nocx-stamped attribution naming the tab, host and session it came from.
Without attribution, `Ваш банк: подтвердите вход` from a hostile MOTD is indistinguishable
from the user's own alert — which is why attribution is stamped by the backend and is not on
the wire.

## 5. What the reviews supplied, and what was left

**Round two** supplied the differential noninterference test, the enumerated destination rule,
"untrusted presentation data" in place of "opaque string", per-context encoders, the clause
fixing who owns `kind`/`level`/attribution, and the demotion of `pane.workFinished`.

**Round three** caught three defects in the result and was right about all of them: the Bark
path segment contradicted the destination rule in the same document (§4.3); "only an attested
event closes a subscription" left the privileged route reachable by a guess (§3); and "until
every sink completed or failed" was a predicate with no guaranteed closing event (§2.1). It
also correctly rejected `additionalProperties: false` as proof of authorship, narrowed the
property test's escape hatch, and found the residual overclaim in §4.4.

**The owner** supplied the one thing no review round found: a provider secret can itself
occupy a URL position — Telegram's bot token is a path segment — which is a third category
neither "stream-derived" nor "ordinary configuration", with its own consequences for logging,
error surfaces, storage and redirects (§2.1).

Left, on purpose:

- **A per-sink accept-declaration protocol.** Replaced by one default-deny routing table
  authoritative for both the ordinary and the ad-hoc route (§3), which is the enforcement
  boundary the recommendation was actually asking for.
- **Amending AD-6.** §4.4. The reasoning changed; the conclusion did not.
- **A twenty-item partial-failure enumeration** from round one. The demand is legitimate and
  is AGENTS.md rule 3; the list was not, because half of it described secret-rotation flows
  this design does not have. The design enumerates its own intervals.

## 6. Consequences

- **`notify.raise` gets a JSON Schema in `contracts/` in the commit that adds the method**,
  with `additionalProperties: false` and an explicit `required` — carrying `title` and `body`
  and nothing else, because that is what makes provenance structural rather than validated.
- **A property-based differential test gates the router**, ranging over schema-valid inputs
  and comparing resolution before sink validation. It is the executable form of §2.1.
- **The push sink cannot be built from a generic template engine.** Each preset declares its
  payload position, its encoder, and where its secret goes. Bark uses `POST /push`; Telegram's
  token is a path secret; ntfy's topic is a path non-secret and its token a header secret.
- **`pane.workFinished` cannot reach a completion subscription or the push sink.**
- **`mac.ShowNotification` is forbidden** — it interpolates the body into an AppleScript
  string literal, and our bodies are program-chosen. `runtime.SendNotification` is the only
  path.
- **A dock badge and a single attention bounce need our own cgo.** Wails v2.13 exposes neither
  (`dockTile`, `badgeLabel` and `requestUserAttention` are absent from the whole module). They
  are the only surface that persists until the user looks, since there is no notification
  centre — and the badge counts tabs with unseen activity, which is existing state.
- **The packaged-build experiment is an acceptance condition, not a note.** Whether an
  ad-hoc-signed bundle keeps its notification authorization across an update, and whether a
  `wails dev` re-sign resets it, must be answered on a real bundle before the epic that ships
  the OS sink can close. A green automated suite over a fake host adapter would otherwise
  report a working feature across a platform seam nobody exercised.
