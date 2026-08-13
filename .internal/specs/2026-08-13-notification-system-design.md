# Notification system — design

- **Date:** 2026-08-13 (revised the same day after two adversarial review rounds)
- **Status:** Proposed
- **Brainstorming session:** `nocx-uz7f`
- **Depends on:** **ADR-0029** — the AD-1 amendment and the ADR-0024 carve-out that make
  `notify.raise` legal at all. This design is not buildable until that ADR is Accepted.
- **Epics to create:** A1, A2, A3, B (§9)

## What a user can do that they could not before

Run something that takes a while — a build, an agent, a remote deploy — look away, and be
told when it wants you. On the desktop as a banner, on the dock as a number that stays
until you look, and on your phone through a service you already use. Including when the
thing that wants you is a program on a machine you reached over ssh, which is the case no
amount of local process-watching can cover.

## The boundaries this crosses, and what they already decided

Per AGENTS.md, a brief that crosses a boundary names it before it says what to build.

| Binding document           | What it already decided                                                                                                    | What this design does with it                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **AD-1**                   | OSC markers stay frontend-side; ledger facts may cross as typed records; no fact may carry the output it was derived from. | **Amended by ADR-0029** — a `notify.raise` record may cross under four named rules. Compliance is not claimed; the AD changes. |
| **AD-6**                   | The backend never interprets the bytes a session produces; render state lives in the frontend.                             | **Unchanged.** OSC parsing stays in xterm.js; the backend receives a parsed string it does not parse (ADR-0029 §4.4).          |
| **AD-2**                   | Go backend service as the one core.                                                                                        | Outbound HTTP and the OS calls live in the backend, behind a host port with a Wails adapter (§2.2).                            |
| **AD-3**                   | Wails v2 as the MVP desktop shell — thin and swappable.                                                                    | The Wails runtime is reached only through that port. devharness and any future host bind an unavailable or fake adapter.       |
| **AD-8**                   | Interface-first + DI, one owner per behaviour.                                                                             | Source, router and sink are three interfaces at one composition root. The router is the only holder of "where".                |
| **ADR-0024** (`nocx-u7uh`) | PTY output is render-only; a program's output cannot drive your terminal.                                                  | **Carved out by ADR-0029** for a bounded, attributed presentation effect — and nothing more.                                   |
| **ADR-0017**               | A connection references a secret; nothing is called a credential.                                                          | A notification target references a secret the same way. Tokens are never inline.                                               |
| **ADR-0003**               | No Developer ID, ever; ad-hoc signature only.                                                                              | Does not block this: the macOS requirement is a bundle identifier (§8). To be proven on a packaged build, not assumed.         |
| **`nocx-ywhp`**            | Program-scoped grants; OSC 52 is the first program-initiated action needing consent, and the next one reuses the model.    | Deliberately not reused — ADR-0029 §4.5 records why, as the reuse rule requires.                                               |
| **`nocx-sb3f`**            | The transport has three delivery classes and models two.                                                                   | Epic B depends on it (§6.4).                                                                                                   |
| **`nocx-2x8x`**            | Redaction covers scrollback, ledger and clipboard — for secrets **injected from the vault**.                               | Insufficient here, and §7 says so rather than cross-referencing past the problem.                                              |

## 1. Decisions taken with the owner

| #   | Question                                | Decision                                                                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Direction of "webhook"                  | **Outbound only.** Event → HTTP POST to a URL the user configured. No listening socket.                                   |
| 2   | Bark / ntfy / Telegram                  | **One sink, typed presets.** Not three integrations, and not one free-form template either (§4).                          |
| 3   | History / notification centre           | **None.** A notification is transient. The dock badge is what replaces it (§4.3).                                         |
| 4   | May a program-sourced event reach push? | **Yes** — the user chooses the route. Safety is the destination being user-configured, enforced by ADR-0029, not a grant. |
| 5   | Scope of the deliverable                | **The pipeline**, not a list of events. A new source is one registration.                                                 |
| 6   | Sinks                                   | **Five**: in-app toast, OS banner, sound, dock badge + bounce, push. Push is epic B; the rest are A1–A3.                  |
| 7   | Trust                                   | Every event carries a `trust` class owned by its source adapter (§3.1). A guess cannot do what an attested fact can.      |
| 8   | Dock badge                              | Counts **tabs with unseen activity**, reusing the existing `hasActivity`. No new state, no new lifecycle.                 |

## 2. Architecture: the pipeline

```
sources ──▶ Event ──▶ router ──▶ [sink, sink, …]
```

**Event** — a closed record. Who may set each field is the point, not decoration:

| field           | set by                            | note                                                         |
| --------------- | --------------------------------- | ------------------------------------------------------------ |
| `kind`          | the source adapter                | never from payload                                           |
| `trust`         | the source adapter                | `attested` \| `programRequest` \| `heuristic` (§3.1)         |
| `title`, `body` | the source; may be stream-derived | untrusted presentation data (ADR-0029 §2.3)                  |
| `level`         | nocx                              | a program cannot forge `danger`                              |
| `attribution`   | nocx                              | session, tab, host, program — stamped, never from the stream |
| `at`            | nocx                              |                                                              |

**Router** — the only place holding the word "where". Maps `(kind, trust)` to the enabled
sinks and targets, plus any ad-hoc subscription (§5). **Destination selection happens once,
here, before any sink is invoked**; a sink receives an immutable resolved destination and
the presentation fields, and can never select a target, credential, method or retry.

**Sink** — delivers, and only encodes (§4.2).

### 2.1 Where each part lives

- **OSC parsing: renderer.** `parser.registerOscHandler(9, …)` beside the existing 7, 52,
  133, 636 and 1337 in `frontend/src/renderers/xterm.ts`. The renderer raises
  `notify.raise` as a JSON-RPC **request**.
- **Router: backend.** It holds the targets and their secrets.
- **Toast: renderer** (`showToast`, already in the kit). Everything else: backend.

### 2.2 The host port

`runtime.SendNotification`, the dock badge and the attention bounce are all
host-context-bound. They are reached through one `AttentionHost` interface with a Wails
adapter; `cmd/devharness` and any future web host bind an adapter that reports itself
unavailable. Without this seam the "one core" of AD-2 is welded to the AD-3 shell, and the
pipeline becomes untestable outside a desktop build.

## 3. Sources

| `kind`              | `trust`          | Origin                                                                    |
| ------------------- | ---------------- | ------------------------------------------------------------------------- |
| `block.finished`    | `attested`       | block ledger (ADR-0024) — exit code and duration; needs shell integration |
| `session.ended`     | `attested`       | `lifecycle.changed`                                                       |
| `program.notify`    | `programRequest` | OSC 9 (plain), OSC 777;notify — renderer                                  |
| `bell`              | `programRequest` | BEL, via the existing `onBell`                                            |
| `pane.workFinished` | `heuristic`      | `detectAgentStatus`: `working → idle` held for 5 s (§3.4)                 |

### 3.1 What each trust class may reach

| `trust`          | May reach                                                          |
| ---------------- | ------------------------------------------------------------------ |
| `attested`       | every sink; may close a one-shot completion subscription           |
| `programRequest` | every sink; may **not** close a completion subscription            |
| `heuristic`      | local attention only — toast, dock badge, tab dot. **Never push.** |

One field on the event and one column in the routing table. Content cannot choose or
upgrade its own class, because the source adapter sets it and the schema rejects it from
the payload.

### 3.2 OSC 9 is overloaded — the parser must discriminate

- `ESC ] 9 ; text` — a notification request.
- `ESC ] 9 ; 4 ; state ; pct` — the ConEmu **progress** protocol.

OSC 9;4 is recognised and **produces no event**; it exists in the parser only so it cannot
be mistaken for the first form. A naive handler on 9 turns a progress tick into a push.

### 3.3 OSC 1337 is not a new source

`xterm.ts:388` already owns 1337 and its comment states the rule: _"One handler owns OSC
1337 (ADR-8): the recovery fence is the same ident with a different payload kind, so it
dispatches from here."_ If iTerm2's `RequestAttention` is ever wanted, it discriminates
**inside** that handler. Registering a second handler for 1337 is two owners for one input.
Out of scope for now — OSC 9 and 777 cover the case.

### 3.4 `pane.workFinished` is new work, not an existing signal

An earlier draft called this "a subscription to an existing signal". That was wrong.
`detectAgentStatus` (`frontend/src/agent-status.ts`) is a **stateless classifier**, and its
caller (`frontend/src/tabs.ts:271`) has no timer and calls `markActivity()` whenever the new
value is `idle`, regardless of the previous one — so `null → idle` fires today. Three rules,
all of them new state machine:

1. **Only the `working → idle` edge.** Never `null → idle`. The module says why: _"A title
   that never mentions an agent is not an idle agent."_
2. **Idle held for 5 s.** Claude Code's title oscillates ✳ ↔ spinner every 1–3 s between
   tool calls; a bare edge fires on each one. The 5 s settle window is termic's, with its
   reasoning recorded in their source. Cancel on `idle → working`, on the title going
   `null`, on tab close and on session replacement.
3. **Named honestly.** `BRAILLE_SPINNER` matches `⠀-⣿` in any title — `npm install` with
   ora, `docker pull`, half of all TUIs. The label is **"работа в панели завершилась"**,
   never "агент закончил", and its `trust` is `heuristic` for exactly this reason.

### 3.5 Claude Code has a better path than the heuristic

Claude Code has a "Send notification" setting that emits **OSC 9** (termic handles it as
the first entry in their dialect list). Once the OSC 9 handler exists, Claude notifies with
its own text and no Claude-specific code in nocx — and at `programRequest` rather than
`heuristic`. **To verify in the first iteration** (§11); if it holds, §3.4 is a fallback for
agents that stay silent rather than the primary path.

### 3.6 Deliberately not a source

- **Agent events (`agent.done`, `agent.needsInput`)** — they belong to `nocx-dw3` and arrive
  as a child of that epic, one registration against this pipeline. This is what keeps these
  epics unblocked: they touch no common code, so a blocking edge would be the "not yet" edge
  AGENTS.md had to strip 13 times out of 20.
- **Deeper per-agent title classification.** `agent-status.ts` is deliberately minimal —
  "kept to the markers we can actually verify". Growing it is a separate decision.

## 4. Sinks and targets

### 4.1 The push target

A `NotificationTarget` is its own entity with its own store and surface:

| field                | note                                                       |
| -------------------- | ---------------------------------------------------------- |
| `id`, `name`         |                                                            |
| `preset`             | `bark` \| `ntfy` \| `telegram` \| `custom`                 |
| `endpoint`           | scheme + host + port + fixed path — **user-supplied only** |
| `secretRef`          | reference into the vault (ADR-0017); never inline          |
| preset-specific keys | Telegram `chatId`; ntfy `topic`; Bark `deviceKey`          |
| `accepts`            | which `kind`s and which `trust` classes this target takes  |

**There is no `urlTemplate` and no payload variable in URL construction.** An earlier draft
had one, accepting `{{body}}`, which handed the URL authority to program output —
`https://{{body}}/notify`, and `https://gateway/?next={{body}}` through a query parameter.
ADR-0029 now makes that an AD violation rather than an oversight. Bark, which wants content
in a path segment, gets a preset that appends **exactly one percent-encoded segment**; it
does not get a licence to template.

The presets differ in schema, not configuration: Telegram needs a `chatId` distinct from
the bot token, ntfy needs a topic distinct from the server, Bark puts both key and content
in the path. One generic string-substitution engine cannot represent all three safely, so
each preset declares its payload position and its encoder.

### 4.2 Encoding is the sink's only freedom

Each sink declares maximum encoded sizes and permitted presentation characters. Header
fields reject CR, LF and NUL; a path field percent-encodes exactly one segment; a JSON
field goes through a JSON encoder; a raw body sets a fixed content type; OS fields are
bounded before the platform call. **An invalid payload fails visibly and never falls back
to string concatenation.** Injection vectors to test: CRLF, `%2F`, `?`, `#`, invalid UTF-8,
NUL, bidi controls, oversized payloads.

### 4.3 Local sinks

Toast, OS banner, sound, and **dock badge + bounce** are built-in rows of the same routing
table with the same per-`kind` switches.

The badge and the bounce need **our own cgo** — Wails v2.13 exposes neither (`dockTile`,
`badgeLabel` and `requestUserAttention` are absent from the entire module, and
`NotificationOptions` has no badge field). About thirty lines of ObjC behind the
`AttentionHost` port of §2.2.

They earn it: with no notification centre, they are the **only** surface that persists until
the user looks. The badge counts **tabs with unseen activity** — `hasActivity` already
exists, is already set, and already clears when the tab is visited, so there is no new state
and no new lifecycle. Zero such tabs, no badge. The bounce fires once
(`NSInformationalRequest`) on a `danger` event while unfocused; never `NSCriticalRequest`,
which bounces until you come, and a terminal that does that is Clippy.

## 5. Ad-hoc subscriptions

A user gesture attaches a one-shot notification to a block or a tab, through the kit's
existing `ContextMenu`:

- on a **block** — "Уведомить, когда закончится"
- on a **tab** — "Уведомить, когда сессия завершится"

**Only an `attested` event closes one.** A `heuristic` guess cannot satisfy "notify me when
this finishes" — that is the whole point of §3.1.

**If the signal does not exist, the menu item is absent — not disabled.** A block
subscription needs shell integration on that session; a tab subscription needs only
lifecycle, so it is always offered. Tabby does exactly this, gating on
`await tab.getCurrentProcess()` (`~/repos/tabby/tabby-core/src/tabContextMenu.ts:174`).

The subscription does not survive a restart — there is no store, which follows from
decision #3.

## 6. Suppression, rate and failure

### 6.1 Suppression, and its interaction with an explicit request

Nothing is delivered about the tab the user is looking at, in a focused window.

**An ad-hoc subscription is an explicit user gesture and outranks suppression.** If the user
asked to be told when this block finishes and is looking at it when it does, the
subscription fires to the local sinks and disarms. Silently disarming a suppressed
subscription would defeat the gesture; leaving it armed would make it fire on some unrelated
later event. Neither is acceptable, so the rule is stated rather than left to fall out.

### 6.2 Rate

- **Debounce, keyed `{sessionId, kind}`** — 8 s to start, termic's number, adopted rather
  than invented. Keyed by session and not by kind alone, so two tabs never collapse into one
  notification and lose their attribution.
- **Coalescing** within the window produces one notification naming the count, carrying the
  attribution of the session it was keyed on. Memory is bounded.

Without these, `while true; do printf '\e]9;spam\a'; done` is ten thousand pushes and a
banned Bark key.

### 6.3 Failure paths, as intervals

AGENTS.md rule 3 wants both ends named, not a list of terminal errors.

| Interval                                                 | What is true throughout, and how the next start recovers                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target creation: secret written, target document not yet | The secret is an orphan from the vault write until the document commits. On failure the secret is deleted; if that delete fails, the orphan is `nocx-2x8x`'s janitor's problem and the target does not exist. **Never a document with a dangling `secretRef`.** |
| Target deletion: document removed, secret not yet        | ADR-0011 §4 already prefers a brief unreachable orphan over metadata pointing at nothing. Same order here: document first.                                                                                                                                      |
| Target edited while the router holds it                  | The router resolves destinations once per event from an immutable snapshot. An edit mid-flight affects the next event, never a delivery in progress.                                                                                                            |
| Store committed, in-memory routing not refreshed         | The refresh is part of the commit's publication, as settings already do. Disk and runtime never disagree past the commit.                                                                                                                                       |
| One sink succeeds, another fails                         | Each sink's outcome is independent; a failure never retries a sink that succeeded. At-most-once (ADR-0029 §2.1).                                                                                                                                                |
| Subscription armed → fired                               | It exists from the gesture until either every selected sink has completed or failed, or the tab closes. Disarm happens **after** delivery is attempted, not before, so a failed delivery does not silently consume the gesture.                                 |
| Vault locked when a push needs its token                 | The push fails loudly by §6.4, and does not silently skip.                                                                                                                                                                                                      |

Independently failing and each needing a test: template rendering, URL parsing, header
validity, JSON encoding, DNS, TLS, redirect refusal, oversized payload, response read,
cancellation; and `InitializeNotifications`, the authorization request, the send, the click
callback decode, the tab lookup, the focus call, and the sound invocation.

### 6.4 A failed delivery must be visible, and the transport can eat it

A push returning non-2xx or timing out raises a local toast at `danger` naming the target.
With no history, this is the **only** place a failed delivery is visible — required by "a
soft degrade must be visible in the product, not only in a log".

But that toast is a backend → renderer notification with **no successor**, which is exactly
the class `nocx-sb3f` describes: today it rides the refreshable queue and is dropped under
saturation, so the visible failure vanishes silently. **Epic B depends on `nocx-sb3f`** — a
legitimate blocking edge, since both live in the outbound queueing of `internal/transport`.

Permission failures are not one state but three: `IsNotificationAvailable` false (the row is
unavailable and says why), authorization never requested (the settings control requests it),
and authorization denied (the control says macOS is suppressing display and points at System
Settings, because nocx cannot re-prompt after a denial).

## 7. Security

The invariants now live in **ADR-0029** and are binding rather than aspirational: provenance,
differential noninterference, the enumerated destination rule, and retention with both ends
named. §4.1 and §4.2 are their design-level consequences.

**Redaction is not covered by `nocx-2x8x` and saying so is the point.** That epic masks
secrets _injected from the vault_, in scrollback, ledger and clipboard — not an HTTP body,
and not a secret that was never nocx's to know. Program-chosen text can carry anything. So
epic B must either extend the redaction contract to the push sink explicitly, or state in
the target UI that unredacted terminal content leaves the machine. A cross-reference does
neither, and this design does not pretend otherwise.

**Residual risk, accepted deliberately:** ADR-0029 §4.6.

## 8. macOS specifics — researched, not assumed

**`UNUserNotificationCenter`** (`UserNotifications.framework`) is the correct API.
`NSUserNotification` has been deprecated since macOS 11 and is what silently drops the
banner sound — the reason termic plays sound separately via `afplay`.

**Wails v2.13.0 already implements it.** `pkg/runtime/notifications.go` exposes
`InitializeNotifications`, `IsNotificationAvailable`, `RequestNotificationAuthorization`,
`CheckNotificationAuthorization`, `SendNotification` (with an `opts.Data` payload),
`SendNotificationWithActions`, `RegisterNotificationCategory`, `OnNotificationResponse`, and
the removal calls. Underneath, `internal/frontend/desktop/darwin/WailsContext.m` imports
`<UserNotifications/UserNotifications.h>`, installs a `UNUserNotificationCenterDelegate`, and
calls `requestAuthorization` with `Alert|Sound|Badge` plus
`getNotificationSettingsWithCompletionHandler`.

| Comparable product's wall                                                     | Answer here                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| termic: osascript has no click callback, so they keep a focus-edge heuristic  | `OnNotificationResponse` + `opts.Data` — the same payload idea, without the heuristic                                     |
| orca: a native Swift binary purely to learn whether notifications are enabled | `CheckNotificationAuthorization`                                                                                          |
| termic: the deprecated API swallows the banner sound                          | not applicable — this is not that API                                                                                     |
| Windows / Linux                                                               | Wails carries both; `go-toast/v2` is indirect in `go.mod` because it **is** the Wails Windows backend, and Linux is D-Bus |

**What Wails does not give us:** the dock badge and the attention bounce (§4.3).

**Ad-hoc signing is expected to suffice** — the hard requirement is a bundle identifier, and
Wails returns `"notifications require a valid bundle identifier"`. **This is not yet
established**: the Wails check proves only what Wails rejects, not that macOS preserves
authorization across `wails dev` re-signs or ad-hoc release updates. §11 makes it an
experiment on a packaged build, not an assumption.

**Two nocx facts to fix before A1 ships:**

1. `build/darwin/Info.plist` and `Info.dev.plist` both carry the Wails template default
   `com.wails.{{safeBundleID .Name}}`. macOS keys notification authorization to the bundle
   identifier, so **taking our own identifier must land first** — renaming later resets
   every user's permission.
2. Both carry the **same** identifier, so the dev stand and the shipped app are one identity
   to macOS. Notification permission does not follow the `nocx` / `nocx-dev` split that
   settings and the vault follow (`internal/storage/appdir.go`).

## 9. Epic decomposition

The first draft had one epic A carrying the pipeline, five sources, four sinks, native
notification lifecycle, permissions, bundle identity, suppression, debounce and two context
menu features. That is an area, not a deliverable. Four epics:

### A1 — "Программа из панели дозвалась до тебя"

The pipeline (event, router, sink interfaces, the `AttentionHost` port), the OSC 9 / 777
receiver, `program.notify` and `bell`, the toast / OS banner / sound sinks, attribution,
suppression, debounce and coalescing. Plus the bundle identifier.

**DONE WHEN — automated:** a program on a real pty through `cmd/devharness` prints OSC 9;
`notify.raise` crosses the real socket conforming to its contract; the router selects the
expected sinks; and the `AttentionHost` fake is invoked with the exact title, body and
nocx-stamped attribution. Plus the differential noninterference property test of
ADR-0029 §2.1.

**DONE WHEN — manual, and named as manual:** on a packaged build, the banner appears and
clicking it focuses the originating tab. **Clicking a native macOS banner cannot be
automated — from Playwright or anything else.** Recording it as a manual step is honest;
claiming an automated check that cannot exist is what the first draft did.

### A2 — "Ты видишь, что пропустил, не открывая ничего"

Dock badge (counting tabs with unseen activity) and the single attention bounce, behind the
`AttentionHost` port; plus `pane.workFinished` at `trust: heuristic`, which can reach only
these surfaces.

**DONE WHEN:** with the window unfocused, a spinner in a background tab settling to idle for
5 s raises the tab dot and increments the badge; visiting the tab clears both. Automated
against the port's fake, with the badge value asserted.

### A3 — "Скажи мне, когда вот это закончится"

`block.finished` and `session.ended` at `trust: attested`, and the one-shot subscriptions on
a block and on a tab, including the absent-not-disabled rule and the suppression override.

**DONE WHEN:** with shell integration, right-clicking a running block and choosing "уведомить,
когда закончится" produces exactly one notification when it exits and no second one; and on a
session without shell integration the menu item is absent.

### B — "Нотификация догоняет тебя в телефоне"

The target entity, its store and CRUD surface, the vault-backed secret, the four typed
presets, the HTTP sink with its per-context encoders, and the visible delivery failure.

**DONE WHEN:** a user creates a `custom` target through the UI, its secret goes to the vault,
the app restarts, a command fails, and the local test HTTP server receives a POST carrying
the event and its attribution. Driving the UI is the point — a test that pokes the store
directly proves the sink, not the feature.

**Depends on:** A1 (the pipeline) and `nocx-sb3f` (§6.4).

### Alongside

- Close `nocx-4clc` — delivered: `frontend/src/ui/toast.tsx` exists, `showToast` is imported
  by 22 files, `ToastHost` is mounted once, `.st-export-status` is gone.
- Re-parent `nocx-8yg.11` out of the `nocx-8yg` area epic into A1.

### Deliberately out

History and a notification centre; agent events (a child of `nocx-dw3`); deeper per-agent
title classification; OSC 1337 RequestAttention (§3.3); an inbound webhook endpoint;
per-program grants (ADR-0029 §4.5); a durable retry queue (ADR-0029 §2.1 — adding one is a
deliberate amendment, not an HTTP implementation detail).

## 10. Testing

- **The wire.** `notify.raise` gets its JSON Schema in `contracts/` in the same commit as the
  method, `additionalProperties: false` plus explicit `required` — the schema is what makes
  ADR-0029's provenance rule enforceable rather than advisory — with the
  `…_OverTheWireConformsToContract` test off the real socket.
- **The differential property test** for noninterference (ADR-0029 §4.2): hostile payload
  pairs differing only in `title`/`body`, asserting identical routing traces and request
  metadata.
- **Injection vectors** per §4.2.
- **Every external call has a failing test, and each is paired with "and on an ordinary
  machine it succeeds"** — the `contentkey` lesson, where every failure path was tested and
  the success path was never reachable.
- **Invariants as intervals** — §6.3 is written that way so the tests can be.
- **Acceptance criteria as assertions in the beads**, not prose, so the implementer is not the
  only author of the test.

## 11. To verify during implementation

1. Does Claude Code's "Send notification" actually emit OSC 9 against a live run (§3.5)? If
   yes, `pane.workFinished` demotes to a fallback.
2. **On a packaged, ad-hoc-signed build:** does notification authorization survive an update,
   and does a `wails dev` re-sign reset it the way it re-triggers the keychain prompt
   (`nocx-o4hg`)? §8 depends on this and currently assumes it.
3. Exact request shapes for Bark, ntfy and Telegram, to fix each preset's schema (§4.1).
