# W8 — the `files.*` control plane, and the guard that makes §0 true on the wire

## Where you are

Your OWN git worktree. **Run `pwd` first.** Never write to
`/home/dev/orca/workspaces/nocx/feat-file-manager-2`.

The issue tracker is NOT in your worktree; `bd` finds nothing. Everything is here.

## Read these, in this order

1. **`internal/filesystem/`** — committed and complete. `Registry`, `Binding`, `Handle`,
   `Caller`, `Acquire`. Read `binding.go` in full; it is the thing you are exposing.
2. **`internal/transport/ws.go`** — `connState` (~line 652), `handleResize` (~line 1361) for the
   `state.has(sid)` pattern, `handleSettingsMethod` for a method table, and
   `broadcastSettingsChanged` (~line 2888) for the notification _shape_.
3. **`contracts/files.*.schema.json`** — committed. These are the exact result shapes and they
   are the contract, not a suggestion.
4. `.internal/specs/2026-08-06-file-manager-design.md` **§5.2 and §5.3**, plus D1, D4, D15.

## What you own

- `internal/transport/ws_files.go` (new) — the six handlers and the notification.
- `internal/transport/ws_files_test.go` (new).
- `internal/transport/ws.go` — **minimally**: register the methods in the dispatch table, and
  add an exported `Owns(session.ID) bool` on `connState`.
- `internal/transport/ws_contract_test.go` — add the `files.*` rows.
- `internal/app/app.go` — **minimally**: construct the `filesystem.Registry` and hand it to the
  WS server. Without this the package is unreachable from `main()`, which is the failure this
  repo has shipped twice and now has a `deadcode` ratchet for.

Do not touch `internal/filesystem/**` (another worker is doing a lint pass there),
`internal/ssh/**`, or anything under `frontend/`.

## Build it

### The two guards, and they are the point of the task

**1. `files.open` is authorised by `connState`, not by the global session registry.**

`connState` exists for exactly this and says so in its own comment: it "gates
data-frame/resize/close so a connection cannot touch a session it has not opened or reattached
to". `handleResize` already does `if !state.has(sid)` before `registry.Get`. Resolving a
`sessionId` through the global `session.Registry` instead would let **any** authenticated
WebSocket that learned another connection's session id open that session's filesystem — the
panel showing another machine's files, which is the one rule this whole feature is built around.

**2. Every later call re-checks, and there is exactly one place that does it.**

`bindingId` is minted from `crypto/rand`, so it cannot be guessed. It is still not a bearer
token: every call goes through `Registry.Acquire(bindingId, caller)`, which re-checks that the
binding's session belongs to the **requesting** connection. One map lookup, and it is what holds
if an id ever reaches a log or a crash report.

`filesystem.Caller` is `Owns(sessionID) bool`. **`connState` does not satisfy it as it stands** —
Go matches interface methods by name and its method is `has`. Add an exported `Owns` that
forwards to `has`: one line, no new state, and the authorisation answer still comes from the one
place that already owns it.

`filesystem` must NOT import `transport`: `connState` and `wsConn` are unexported there and the
dependency would run backwards. The interface is declared in `filesystem` and satisfied here —
the direction `internal/discovery/discovery.go:113` already established.

### `files.changed` — the notification, and its addressing is the interesting half

Shape follows `broadcastSettingsChanged`: a `jsonrpc` frame with `method` and `params`, no `id`.
**Addressing does not.** That function writes to every connection; this must reach exactly one.

**Resolve the destination at emit time, never store it.** A binding records the `sessionId` it
belongs to; when it has something to announce, ask that session for its **current** subscriber
(`sessionRx.subscriber`, ws.go ~line 43) and write only there. That is what survives an AD-9
reconnect: the old `*wsConn` is destroyed on a WebSocket drop and `attach` installs a new one, so
a binding that stored its originating connection would spend the rest of its life writing to a
closed socket — while the lifecycle table promises the drop is invisible.

With no subscriber, accumulate a **set** of dirty paths — bounded, because a path can only be
dirty if it is in the watch set — and emit it once on re-attach, then clear. Not a queue: a burst
that meant one change would replay as many.

`rev` is **optional**. Present when the backend already knows it, absent for a local watch event
where nothing has been re-listed. Do not make it required: that would force a listing in order to
announce that a listing is needed.

### Lifetime

`Reg.Get` returns a session pointer `Reg.Close` can invalidate immediately (`session.go:240`), so
a handler that resolved a binding and then called it can hit a closing provider. `Acquire`'s
use-guard is what covers this — hold it for the call, and let the release func run on defer.

Closing a terminal closes its bindings. The lease exists to protect an in-flight read from a
concurrent close, not to keep an SSH connection alive because a viewer is open.

`files.reveal` is **local bindings only** and **errors** on a remote one. The UI will not offer
it there; the backend refuses anyway, because a UI-only guard is one bug away from being no guard.

## Verify — scoped, and note the third command

```
go build ./internal/transport/... ./internal/app/...
go vet ./internal/transport/...
go test -race ./internal/transport/ -run 'Files'
golangci-lint run ./internal/transport/... ./internal/app/...
```

**That last one is not optional and it is not a repo-wide gate** — it is scoped to the packages
you touched. Two earlier workers on this epic skipped it because an earlier brief did not list
it, and both left a pile of `errcheck`, `gosec` and `shadow` findings for the coordinator. Match
the repo's existing suppression conventions (`_ = x.Close()`, `//nolint:errcheck` over a test
block, both already in the tree) rather than inventing a third.

Do **not** run `go test ./...`: `internal/shellintegration` has nine pre-existing failures on
this host because `dash` and `zsh` are absent and its tests deliberately fail rather than skip.
They are not yours.

## Tests

- **`files.open` is refused for a session the requesting connection does not own.** Two live
  WebSocket clients, B knows A's valid `sessionId`, B's `files.open` fails. This is §0 enforced
  on the wire and it is the most important test you will write.
- **A `bindingId` from connection A is refused on connection B.**
- Drop and re-attach the WebSocket with a watch active; assert `files.changed` reaches the NEW
  connection. This is the assertion that fails if a binding stored its `*wsConn`.
- With no subscriber, several directories change; on re-attach one delivery names each dirty path
  once.
- Contract conformance for all six methods **and the notification**: the DTO case, and the
  **over-the-wire** case that drives the real method through the real socket. The second is the
  one that catches a field the server never sends, which is why this directory exists.
- Every external call has a failure test: unknown binding, unknown session, closed session
  between lookup and use, `files.reveal` on a remote binding.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.**
- Report **numbers**: test count, the exact `golangci-lint` result, the exact
  `contracts:check`-equivalent result for your Go conformance tests, and anything you could not
  verify. If you skipped something the brief asked for, say which — silence reads as "nothing to
  report".

## Lifecycle

`heartbeat` with `--phase` per phase (registry wiring, handlers, notification, contract tests).
One `worker_done`, `--outcome succeeded` or `--outcome failed`.
