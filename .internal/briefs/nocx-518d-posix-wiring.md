# Brief — nocx-518d: the POSIX script must reach a real session

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`,
  `go vet ./internal/shellintegration/...` and
  `golangci-lint run ./internal/shellintegration/...` — the last is not optional.
- You own `internal/shellintegration/` and its tests. **Other workers are live
  in `internal/app`, `internal/tunnel` and `frontend/` — stay out.**
- Numbers, not adjectives. Heartbeat each phase.

## Baseline

`go test ./internal/shellintegration/...` is green, ~4s — **but** run it as
`nix shell nixpkgs#zsh nixpkgs#dash --command go test ./internal/shellintegration/... -count=1`
(~10s), because several tests drive real shells and **silently skip** without
them. A green run that skipped them tells you nothing.

## The problem

`nocx-q6xj` built `scripts/nocx.posix` — OSC 133 A/B/D with a real exit status
plus OSC 7, entirely from a single-quoted `PS1`, verified against real dash and
busybox ash. It is embedded as `posixScript` in `scripts.go` and **referenced
nowhere else**. An embedded variable with no caller is precisely the shape
`AGENTS.md` rule 2 names, and golangci-lint does not flag it — which is why this
is a bead and not a TODO.

Three things block the wiring, and each is a decision rather than a typo.

**1. `TestScriptContent_ContainsMarkers` asserts every script in the `scripts`
map emits a C marker.** `nocx.posix` structurally cannot: POSIX `sh` has no
preexec hook, and the absence is asserted deliberately elsewhere. So adding it
to the map turns a green suite red. The invariant "every script emits C" is now
**false** — make it per-script rather than weakening it for all. Do not delete
the assertion; a bash script that stopped emitting C would be a real defect.

**2. The `version` const must be bumped**, or existing installs keep their old
script set and never receive the new file. `nocx-6b3x` is the bead that bought
that lesson.

**3. Selection.** The gate line and the install path must choose the posix
script for a shell that is neither bash nor zsh. Note the launcher
(`internal/shellintegration/launcher*.go`) already has `ShellKind` with
`ShellUnknown` and currently **refuses** it with `ReasonUnsupportedShell`.
Decide deliberately whether `ShellUnknown` becomes the posix tier here or stays
refused, and **write the reason down** — the spec
(`.internal/specs/2026-08-03-nocxify-design.md` §6) says `minimal` is a real
tier, so refusing it forever would contradict the design.

## Prove it

```bash
deadcode -filter 'nocx/internal/shellintegration' ./...
```

`posixScript` must not appear. Put the actual output in your report; if
`deadcode` is not installed, say so rather than skipping quietly.

## Test first

Red before green. Assert the script reaches a session for a shell that is
neither bash nor zsh, that an existing install with the old version is
rewritten, and that the per-script marker expectation still fails a bash script
which stopped emitting C.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, the deadcode output verbatim, test counts, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
