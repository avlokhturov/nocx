# Notification system — design

- **Date:** 2026-08-13
- **Status:** Proposed
- **Brainstorming session:** `nocx-uz7f`
- **Epics to create:** A — "Что-то произошло, и ты об этом узнал"; B — "Нотификация
  догоняет тебя в телефоне"

## What a user can do that they could not before

**A.** Run something that takes a while — a build, an agent, a remote deploy — look
away, and be told when it wants you: a banner on the desktop, a click that lands on
the exact tab that raised it. Including when the thing that wants you is a program on
a machine you reached over ssh.

**B.** Get the same on your phone, through a service you already use (Bark, ntfy, a
Telegram bot), without nocx building an app, a relay or a push protocol.

## The boundaries this crosses, and what they already decided

Per AGENTS.md, a brief that crosses a boundary names it before it says what to build.

| Binding document           | What it already decided                                                                                                       | What this design does with it                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AD-1**                   | One WebSocket: raw binary data plane + JSON-RPC 2.0 control plane.                                                            | Notification events cross as JSON-RPC. No PTY bytes are wrapped.                                                                                                   |
| **AD-6**                   | Single-owner state; the backend never interprets the bytes a session produces. Terminal render state lives in the frontend.   | OSC parsing stays in xterm.js in the renderer. The backend never scans the stream for OSC 9. The round trip renderer → backend is a consequence, not an oversight. |
| **AD-2**                   | Go backend service as the one core.                                                                                           | Outbound HTTP and the OS notification call live in the backend. The renderer never sees a target URL or a secret.                                                  |
| **AD-8**                   | Interface-first + DI, one owner per behaviour.                                                                                | Source, router and sink are three interfaces wired at the composition root. One delivery path for all four HTTP presets.                                           |
| **ADR-0024** (`nocx-u7uh`) | The lifecycle left the byte stream; a program's output can no longer drive your terminal.                                     | Honoured, and the apparent conflict is resolved below (§3.1).                                                                                                      |
| **ADR-0017**               | A connection references a secret; nothing is called a credential.                                                             | A notification target references a secret the same way. Tokens are never inline.                                                                                   |
| **ADR-0003**               | No Developer ID, ever; ad-hoc signature only.                                                                                 | Does **not** block notifications — the macOS requirement is a bundle identifier, not a Developer ID (§8).                                                          |
| **ADR-0011**               | Storage capabilities and secret references.                                                                                   | Targets are a store; their secrets are references.                                                                                                                 |
| **`nocx-ywhp`**            | Program-scoped grants, OSC 52 clipboard as the first program-initiated action needing consent; the next one reuses the model. | Not reused, deliberately, and §7 says why: routing is a user-owned setting, not a per-program consent.                                                             |
| **`nocx-sb3f`**            | The transport has three delivery classes and models two; a fact with no successor rides the droppable queue.                  | Epic B depends on it (§6.3).                                                                                                                                       |

## 1. Decisions taken with the owner

| #   | Question                                | Decision                                                                                                                         |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Direction of "webhook"                  | **Outbound only.** Event → HTTP POST to a URL the user configured. No listening socket, no inbound endpoint.                     |
| 2   | Bark / ntfy / Telegram                  | **One sink, three presets.** URL template + method + headers + body template. Not three integrations.                            |
| 3   | History / notification centre           | **None.** A notification is transient: toast, banner, push, tab badge. No store, no inbox, no read/unread.                       |
| 4   | May a program-sourced event reach push? | **Yes** — the user chooses the route. Safety comes from the destination being user-configured, not from a per-program grant.     |
| 5   | Scope of the deliverable                | **The pipeline**, not a list of events. A new source is one registration.                                                        |
| 6   | Sinks in v1                             | **All four**: in-app toast, OS notification, push, sound. "v1" spans both epics — toast, OS and sound land in A, push in B (§9). |

## 2. Architecture: the pipeline

Three parts behind interfaces, wired at one composition root.

```
sources ──▶ Event ──▶ router ──▶ [sink, sink, …]
```

**Event** — a typed fact:

| field           | meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `kind`          | which source produced it (table in §3)                                                 |
| `title`, `body` | what to say                                                                            |
| `level`         | info / success / warning / danger                                                      |
| `attribution`   | session id, tab, host, program name — **stamped by nocx, never taken from the stream** |
| `at`            | timestamp                                                                              |

**Router** — the only place that holds the word "where". Maps `kind` to the enabled
targets (the user's standing rules) plus any ad-hoc subscriptions (§5), and returns
the sinks to deliver to.

**Sink** — delivers. Local: toast, OS notification, sound. Remote: one HTTP POST.

### 2.1 Where each part lives

- **OSC parsing: renderer.** `parser.registerOscHandler(9, …)` alongside the existing
  7, 52, 133, 636 and 1337 in `frontend/src/renderers/xterm.ts`. The renderer then
  raises `notify.raise` as a JSON-RPC **request** to the backend.
- **Router: backend.** It needs the target list and their secrets.
- **Local sinks:** toast is the renderer (`showToast`, already in the kit); OS
  notification and sound are the backend (Wails runtime, §8).
- **Remote sink: backend.** The token is in the vault; the vault is backend.

The renderer → backend → renderer round trip for a toast raised by OSC 9 looks
redundant right up to the moment somebody proposes parsing OSC 9 in Go. That is
exactly what AD-6 forbids and what `nocx-u7uh` closed. The round trip is the design.

## 3. Sources

| `kind`              | Origin                                                                                  | Reliability                                            |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `program.notify`    | OSC 9 (plain), OSC 777;notify, OSC 1337 RequestAttention — renderer                     | whatever the program printed                           |
| `block.finished`    | block ledger (ADR-0024): exit code and duration                                         | authenticated; **requires shell integration**          |
| `session.ended`     | `lifecycle.changed`                                                                     | authenticated; always available                        |
| `bell`              | BEL, via the existing `onBell`                                                          | always available                                       |
| `pane.workFinished` | `detectAgentStatus` (`frontend/src/agent-status.ts`): `working → idle` **held for 5 s** | a guess from the title; any spinner, not only an agent |

### 3.1 Why OSC 9 does not contradict `nocx-u7uh`

`nocx-u7uh` stopped a program **forging a fact of nocx's own** — an exit code,
ownership of the input, a record in the command history. A program that prints OSC 9
is **asking** for its own message to be shown. The message is attributed to the
program, displayed as the program's text, and never becomes a fact nocx asserts. Those
are different things, and the ADR for this design must say so — otherwise the next
reader concludes we walked the invariant back.

### 3.2 OSC 9 is overloaded — the parser must disambiguate

- `ESC ] 9 ; text` — a notification request (iTerm2, Windows Terminal, wezterm).
- `ESC ] 9 ; 4 ; state ; pct` — the ConEmu **progress** protocol.

A naive handler registered on 9 turns a progress update into a push to the user's
phone. OSC 9;4 is parsed and **produces no notification**; it exists in the parser
solely so it cannot be mistaken for the first form. Evidence: termic handles both,
separately (`~/repos/termic/src/components/task/TerminalPane.tsx`).

### 3.3 `pane.workFinished`: three rules bought by other people's bugs

1. **Only the `working → idle` edge.** Never `null → idle`. `agent-status.ts` states
   it directly: _"A title that never mentions an agent is not an idle agent."_ `null`
   means the title said nothing.
2. **Idle must be held for 5 seconds.** Claude Code's title oscillates ✳ ↔ spinner
   every 1–3 s between tool calls. A bare edge fires on every tool call. The 5 s
   settle window is termic's, with its reasoning recorded in their source: long
   enough to survive the oscillation, short enough to feel responsive.
3. **Name it honestly in the UI.** `BRAILLE_SPINNER` matches `⠀-⣿` in any title —
   `npm install` with ora, `docker pull`, half of all TUIs. The module answers "is
   something working", not "who". So the label is **"работа в панели завершилась"**,
   never "агент закончил".

### 3.4 Claude Code has a better path than the heuristic

Claude Code has a "Send notification" setting that emits **OSC 9**. Once the OSC 9
handler exists, Claude notifies with its own text and no Claude-specific code in nocx
— no heuristic, no settle timer, no false positive on `docker pull`.

**To verify in the first iteration** against a live Claude Code. If it holds, `3.5`
demotes to a fallback for agents that stay silent, rather than the primary path.

### 3.5 Deliberately not a source

- **Agent events (`agent.done`, `agent.needsInput`).** They belong to `nocx-dw3` and
  arrive as a child of that epic — one registration against this pipeline. This is
  what keeps epic A unblocked: `nocx-dw3` and this epic do not touch the same code,
  so a blocking edge between them would be exactly the "not yet" edge AGENTS.md had
  to strip 13 of 20 times.
- **Deeper title classification** (per-agent state registries, as termic keeps for
  Gemini/Codex). `agent-status.ts` is deliberately minimal — "kept to the markers we
  can actually verify" — and growing it is a separate decision.

## 4. Targets and the routing table

A `NotificationTarget` is **its own entity with its own store and surface**, not a
setting:

| field                                              | note                                                            |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `id`, `name`                                       |                                                                 |
| `kind`                                             | `bark` \| `ntfy` \| `telegram` \| `custom`                      |
| `urlTemplate`, `method`, `headers`, `bodyTemplate` | presets fill these; `custom` exposes them                       |
| `secretRef`                                        | reference into the vault (ADR-0017) — **never an inline token** |
| `accepts`                                          | the set of event `kind`s this target takes                      |

Template variables: `{{title}}`, `{{body}}`, `{{level}}`, `{{host}}`, `{{session}}`,
`{{tab}}`, `{{program}}`.

Local sinks (toast, OS, sound) are not targets — they are built-in rows of the same
table, with the same per-`kind` switches.

**Why not settings.** The registry knows exactly five control kinds — toggle, text,
number, select, secret (`internal/settings/settings.go:53-57`) — and one flat key per
setting. A list of targets, each with a URL, a secret and a set of events, is a
collection, and the registry has no collection. The alternative would be inventing a
sixth control kind and teaching the generated settings screen to render a table, which
also collides with `nocx-dej6`. A target is shaped exactly like a connection profile,
which already has a store, a CRUD surface and a secret reference — extend that answer
rather than write a second one.

## 5. Ad-hoc subscriptions

A user gesture attaches a one-shot notification to a specific block or tab, via the
kit's existing `ContextMenu` (`frontend/src/ui/context-menu.tsx`):

- on a **block** — "Уведомить, когда закончится"
- on a **tab** — "Уведомить, когда сессия завершится"

One-shot: the subscription disarms itself after it fires. It does not survive a
restart — there is no store, which follows from decision #3. It delivers through the
same router and the same sinks.

**If the signal does not exist, the menu item is absent — not disabled.** Tabby gates
"Notify when done" on `await tab.getCurrentProcess()` returning something
(`~/repos/tabby/tabby-core/src/tabContextMenu.ts:174`). Our equivalent: a block
subscription requires shell integration on that session; a tab subscription requires
only lifecycle, so it is always offered.

## 6. Suppression, rate and failure

### 6.1 Suppression

Nothing is delivered about the tab the user is currently looking at, in a focused
window. Both termic and iTerm2 gate this way; termic gates the whole focused task.

### 6.2 Rate

- **Debounce per source: 8 s to start** — termic's `DEBOUNCE_MS`, adopted rather than
  invented.
- **Coalescing:** several events from one source inside the window collapse into one
  notification naming the count.

Without these, `while true; do printf '\e]9;spam\a'; done` is ten thousand pushes and
a banned Bark key.

### 6.3 Failure paths

| Failure                                  | What the user sees                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push returns non-2xx, or times out       | A local toast at level `danger` naming the target. Since there is no history, this is the **only** place a failed delivery is visible — required by "a soft degrade must be visible in the product, not only in a log". |
| `CheckNotificationAuthorization` false   | Settings says "macOS не показывает нотификации", not silence.                                                                                                                                                           |
| `IsNotificationAvailable` false          | The OS-sink row is unavailable and states why.                                                                                                                                                                          |
| Vault locked when a push needs its token | The push fails loudly by the row above; it does not silently skip.                                                                                                                                                      |

**The transport dependency.** `notify.raise` travels renderer → backend as a
**request**, which the transport already never drops. The reverse direction — "the
push failed, show a toast" — is a backend → renderer notification with **no
successor**, which is precisely the class `nocx-sb3f` describes: today it would ride
the refreshable queue and be dropped under saturation, and the failure would vanish
silently. Epic B therefore depends on `nocx-sb3f`. This is a legitimate blocking edge
under the AGENTS.md rule: both live in the outbound queueing of
`internal/transport`.

## 7. Security

**The URL never comes from the byte stream.** A program chooses the _content_ of a
notification; the user chooses every _destination_. This is the invariant that makes
decision #4 safe, and it is not negotiable.

**Attribution is mandatory.** Because the content is program-chosen, the body carries
which tab, which host, which session it came from. Without it, `Ваш банк:
подтвердите вход` from a hostile MOTD arrives on the user's phone indistinguishable
from their own alert.

**Why not a program-scoped grant (`nocx-ywhp`).** That epic decides consent for an
action a program takes _on the user's behalf_ — writing their clipboard. Here the
program does not act; it asks, and a user-owned routing rule decides whether anyone
listens. Adding a per-program consent dialog on top of a routing rule the user already
set would be a second model for one decision. If `nocx-ywhp` later generalises to
"program-initiated requests" as a category, this is a candidate to fold in — the ADR
should say so, so the option is not lost.

**Residual risk, accepted by the owner:** once the user routes terminal-sourced events
to push, any host they ssh into can put text on their phone. Bounded by attribution,
the rate limit, and the fact that the destination is theirs.

**Redaction.** A body leaving the machine may carry a command line. `nocx-2x8x`
(secret lifecycle hygiene: orphan collection and redaction) owns redaction — extend
it, do not write a second redactor here.

## 8. macOS specifics — researched, not assumed

**The correct API today is `UNUserNotificationCenter`** (`UserNotifications.framework`).
`NSUserNotification` has been deprecated since macOS 11 and is the API that silently
drops the banner sound on modern macOS — the reason termic plays sound separately via
`afplay`.

**Wails v2.13.0 — already our dependency — implements it.**
`pkg/runtime/notifications.go` exposes `InitializeNotifications`,
`IsNotificationAvailable`, `RequestNotificationAuthorization`,
`CheckNotificationAuthorization`, `SendNotification` (with an `opts.Data` payload),
`SendNotificationWithActions`, `RegisterNotificationCategory`,
`OnNotificationResponse`, and the pending/delivered removal calls. Underneath,
`internal/frontend/desktop/darwin/WailsContext.m` imports
`<UserNotifications/UserNotifications.h>`, installs a `UNUserNotificationCenterDelegate`,
and calls `requestAuthorization` with `Alert|Sound|Badge` plus
`getNotificationSettingsWithCompletionHandler`.

Every wall the comparable products hit is already scaled by a dependency we ship:

| Their problem                                                                                                                       | Answer                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| termic: osascript has no click callback, so they keep a focus-edge heuristic                                                        | `OnNotificationResponse` + `opts.Data` — the same `{tab, session}` payload idea, without the heuristic                                                  |
| orca: wrote a native Swift binary purely to learn whether notifications are enabled (`native/notification-status-macos/main.swift`) | `CheckNotificationAuthorization`                                                                                                                        |
| termic: deprecated API swallows the banner sound                                                                                    | not applicable — this is not that API                                                                                                                   |
| Windows / Linux                                                                                                                     | Wails carries both. `go-toast/v2` is indirect in our `go.mod` because it **is** the Wails Windows backend; Linux is D-Bus, hence `CleanupNotifications` |

**Ad-hoc signing is sufficient.** The hard requirement is a **bundle identifier** —
Wails returns `"notifications require a valid bundle identifier"`, and
`UNUserNotificationCenter.current()` is what raises
`Invalid parameter not satisfying: bundleIdentifier != nil`. **ADR-0003 does not block
this feature.**

**The trap in the same module.** `pkg/mac/notification_darwin.go` exposes
`mac.ShowNotification`, the old osascript path: no authorization check, no click
callback, and it interpolates the message straight into an AppleScript string —

```go
command := fmt.Sprintf("display notification \"%s\"", message)
```

Our bodies come from the byte stream, so a body containing `"` escapes the AppleScript
literal. That is an injection, not a cosmetic flaw. **Use `runtime.SendNotification`;
never `mac.ShowNotification`.** Written down because the wrong function has the more
inviting name.

**Two nocx facts to fix before A ships:**

1. `build/darwin/Info.plist` and `Info.dev.plist` both carry the Wails template
   default `com.wails.{{safeBundleID .Name}}`. macOS keys notification authorization to
   the bundle identifier, so **taking our own identifier must land before the feature
   relies on it** — renaming later resets every user's permission.
2. Both plists carry the **same** identifier, so the dev stand and the shipped app are
   one identity to macOS. Notification permission does **not** follow the
   `nocx` / `nocx-dev` split that settings and the vault follow
   (`internal/storage/appdir.go`). Not a blocker; stated so it is not discovered.

## 9. Epic decomposition

### Epic A — "Что-то произошло, и ты об этом узнал"

The pipeline, the five sources, the local sinks (toast, OS, sound), suppression and
rate, and the ad-hoc subscriptions.

**DONE WHEN:** a program in a pane prints OSC 9 while the window is unfocused, a macOS
banner appears, and clicking it opens that exact tab — watched end to end by one
automated check driving a real pty through `cmd/devharness`.

### Epic B — "Нотификация догоняет тебя в телефоне"

The target entity, its store and CRUD surface, the vault-backed secret, the four
presets, the HTTP sink, and the visible delivery failure.

**DONE WHEN:** a `custom` target pointing at a local test HTTP server receives a POST
carrying the event and its attribution when a command fails — one automated check.

**Depends on:** A (they share the routing table) and `nocx-sb3f` (§6.3).

### Alongside

- Close `nocx-4clc` — the Toast primitive is delivered: `frontend/src/ui/toast.tsx`
  exists, `showToast` is imported by 22 files, `ToastHost` is mounted once, `.st-export-status`
  is gone. All three acceptance criteria are met.
- Re-parent `nocx-8yg.11` ("Notification when a long command finishes") out of the
  `nocx-8yg` area epic into A.
- New bead: own the bundle identifier (§8), landing before A's OS sink.

### Deliberately out

History and a notification centre; agent events (a child of `nocx-dw3`); deeper
per-agent title classification; an inbound webhook endpoint; per-program grants;
a second redactor (`nocx-2x8x` owns redaction).

## 10. Testing

- **The wire.** `notify.raise` gets its JSON Schema in `contracts/` in the same commit
  that adds the method, with `additionalProperties: false` and an explicit `required`,
  plus the `…_OverTheWireConformsToContract` test that validates the real result off
  the real socket.
- **Every external call has a failing test:** push returns 401; push times out;
  `SendNotification` returns an error; `CheckNotificationAuthorization` returns false;
  the vault is locked when the token is needed.
- **And each one is paired with "and on an ordinary machine it succeeds"** — the
  `contentkey` lesson, where every failure path was tested and the success path was
  never reachable.
- **Invariants as intervals.** A block subscription exists from the moment it is
  created until either the event is delivered or the tab is closed — both ends named.
- **Acceptance criteria written as assertions in the beads,** not prose, so the
  implementer is not the only author of the test.
- **The happy path is watched end to end** for each epic, by the checks in §9.

## 11. To verify during implementation

1. Does Claude Code's "Send notification" actually emit OSC 9 against a live run
   (§3.4)? If yes, `pane.workFinished` demotes to a fallback.
2. Does `wails dev` re-signing the binary on every run reset notification
   authorization, the way it re-triggers the keychain prompt (`nocx-o4hg`)? If it
   does, the dev loop needs a documented workaround and it is not a product defect.
3. Which of Bark, ntfy and Telegram need a non-JSON body or a path-segment secret, so
   the template covers all three without a special case.
