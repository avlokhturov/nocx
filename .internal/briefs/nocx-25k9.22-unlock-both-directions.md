# nocx-25k9.22 — the backend cannot ask for an unlock, so work off the renderer path fails quietly

**Bead:** `nocx-25k9.22` (P1 bug). Read it first — `bd show nocx-25k9.22`. Its root-cause
paragraph is the design; this brief adds the boundaries, the seams and what must not move.

## The defect a user sees

Start with the vault sealed and history enabled. The content key is read in `app.New()`,
in Go, at startup — no renderer call, no window necessarily attached. Nothing is ever
shown. History does not record, Settings goes on offering a toggle, a retention age and a
budget that govern nothing, and the only trace is a `slog.Warn`.

That is the exact failure AGENTS.md names: **a soft degrade must be visible in the product,
not only in a log.** A silent degrade the UI contradicts is how a feature that does not
exist survives a release.

## Why the existing prompt cannot cover it

The prompt is raised in exactly one place — `dispatcher.onVaultSealed` in
`frontend/src/dispatcher.ts` — and it fires when a JSON-RPC **response** reports the vault
sealed, deferring the caller's promise and retrying once. That design is right for anything
the renderer initiates, and it is why no call site wraps its own vault calls. **Do not
change it.** Its blind spot is everything that did not begin as a renderer RPC, and a patch
on the response path cannot reach that, because there is no response to patch.

## The shape

A **second direction**, not a patch on the first: the backend must be able to *request* an
unlock — a server-to-client notification naming **why** it needs one — which the renderer
turns into the **same dialog through the same code**. One dialog, one code path, two ways
in. Then history at startup, and anything like it later, is covered by construction rather
than by remembering.

## The boundaries — what they already decided

- **AD-1** — one WebSocket: raw binary data plane, JSON-RPC 2.0 control plane. The request
  is a JSON-RPC **notification** on the control plane. Nothing goes near the byte stream.
- **AD-8 / Interface-first + DI** — whatever raises the request is behind an interface,
  wired at the one composition root (`internal/app/app.go`). `app.New()` must not reach
  into the transport directly.
- **ADR-0011** (storage capabilities and secret references), **ADR-0016** (a secret owns
  its name), **ADR-0017** (a connection references a secret) — read them before you shape
  the payload. The notification names *why* the unlock is needed; it does not carry secret
  material, a secret's value, or anything that would put one in a log.
- **ADR-0021** — secrets in the prompt. Nothing in this path gets logged.
- **The wire is a party to the contract** (AGENTS.md testing rule 5). A new server→client
  shape gets a JSON Schema in `contracts/` **in the same commit**, with
  `additionalProperties: false` **and** an explicit `required`; the renderer's type is
  generated and committed (`npm run contracts:check`), and there is an
  `…_OverTheWireConformsToContract` test — the real notification off the real socket, not
  a payload the test built.

## The hard part: the cases where it cannot ask

The acceptance criterion is not "the prompt appears". It is that **no path returns success,
an empty result, or silence.** Enumerate and handle, each with a test:

- No UI attached at all — the request is raised before a window exists, or the renderer has
  not connected yet. What does `app.New()` do? Blocking startup forever is not an answer,
  and neither is proceeding as though the key were readable.
- A prompt is already open — the second requester must not stack a second dialog, and must
  not be told "granted" when the first is still pending.
- The user cancels, or the passphrase is wrong.
- The keychain provider is unavailable on this machine (`internal/contentkey` has the
  per-OS story; there is a paired "and on a normal machine it succeeds" test there and this
  needs the same).
- The connection drops between request and answer.

For each: what is true on disk, in the keychain and in memory afterwards, and how does the
next start recover? State the invariants as **intervals** with both ends named, not as
moments (AGENTS.md testing rule 3).

And the visible half: when the vault could not be unlocked, **the surface says so**.
Settings must not go on advertising a history budget that governs nothing.

## Acceptance — as assertions

- With the vault sealed and history enabled, starting the app raises the unlock prompt, and
  after unlocking, a command is recorded and survives a restart. This is one automated
  end-to-end check, run through `cmd/devharness` (real backend, headless, no display).
- With the vault sealed and the prompt **refused**, Settings visibly reports that history is
  not running — not only a `slog.Warn`.
- A second backend request while a prompt is open does not open a second dialog and does not
  receive a false success.
- Every failure branch above has a test, and the paired positive exists: on an ordinary
  machine, it succeeds.
- The existing `dispatcher.onVaultSealed` response path still works, unchanged — one test
  proves it.

## Out of scope

Touch ID (`nocx-25k9.23`), the vault contents viewer (`nocx-25k9.14`), the repeated-keychain-
probe bug (`nocx-25k9.17`), the settings-page gate (`nocx-25k9.15`). If your work makes one
of them trivially adjacent, file a comment on that bead — do not widen.

## Working rules

TDD, failing test first. Full local gate before you report: `gofumpt -l .`,
`golangci-lint run`, `go test -race ./...`, and in `frontend/`: `npx prettier --check .`,
`npx eslint .`, `npm run typecheck`, `npm test`. Commit messages carry `(nocx-25k9.22)`.
Report a blocker as an `orca orchestration ask` the same minute you hit it — a blocker that
lives only in a final report evaporates between rounds.
