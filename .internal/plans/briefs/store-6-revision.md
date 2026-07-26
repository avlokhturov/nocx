# Worker brief — STORE-6 revision / bead `nocx-208`: give the ContentDB seam a real shape

`internal/content` already exists and most of it is **accepted, do not touch**:

- The package doc comment recording the five SQLite conditions — correct and complete. Leave it.
- `ErrNotImplemented`, the `ContentDB` interface (`Conversations()`, `CommandHistory()`,
  `Close()`), and the `Stub` pattern — correct. Leave the shape.
- `go.mod` / `go.sum` unchanged — this must stay true. Re-verify at the end.

## The one problem you are fixing

The two repository interfaces are placeholders that cannot carry data:

```go
type ConversationRepository interface {
	Save(ctx context.Context, id string) error
}
type CommandHistoryRepository interface {
	Add(ctx context.Context, id string) error
}
```

`Save(ctx, id string)` cannot save a conversation. A seam that cannot carry its payload is not a
seam — and bead `nocx-de7` (P1, "Authoritative command output capture") is **blocked on this
package**, so the next worker hits this wall immediately.

## What to replace them with

Give each repository the record type its consumer already implies. **This is not speculation** —
the shapes below are taken from code and beads that already exist, so YAGNI is satisfied:

**Command history.** `frontend/src/command-ledger.ts:12-25` already defines `CommandRecord`, and
bead `nocx-de7` calls that metadata "the right metadata and is genuinely ready". Read it, then
mirror it in Go: id, command, cwd, host, status, exit code, startedAt/endedAt, trusted. Mind the
nullability that is real in the TS type (`exitCode: number | null`, `startedAt: number | null`,
`endedAt: number | null`) and mirror it deliberately with pointers or a documented sentinel —
state which you chose and why. `CommandStatus` is a closed set in TS
(`running | success | failure | interrupted | unknown`); make it a typed Go string constant set,
not a bare `string`.

Note ADR-0008's line in that same file: "Output bytes are never retained" in the ledger. Command
**output** capture is `nocx-de7`'s job and is explicitly **not** part of your record. Do not add
an output field.

**Conversations.** Bead `nocx-dw3` is agent mode driving the pi/omp loop. The minimum honest
record is a conversation with an id and a title/created timestamp, plus messages carrying role,
content and a timestamp. Keep it to what a conversation demonstrably is; do not invent token
accounting, model metadata, or tool-call structures — those are `nocx-dw3`'s design to make.

Both repositories need the read side, not only the write side: a history repository that cannot
list is useless to the completion feature (`nocx-4ff.6`: "Up/down and Ctrl-R browse app
history"). Include the query methods those two features plainly need, and no more.

Keep every method `context.Context`-first, keep `ErrNotImplemented` as the stub's return, and
keep the "no generic `Repository[T]`" rule (ADR-0011 §1).

## Ground rules

- **Greenfield.** No migrations, no back-compat shims. Still **no SQLite** and still no `go.mod`
  change — the implementation stays deferred; only the interface shape changes.
- **TDD**: update `stub_test.go` first so it fails against the new interfaces, then make it pass.
- **You own `internal/content/**` only.** Other workers are live in `internal/storage`,
  `internal/profile`, `internal/credential`, `internal/connection`, `internal/transport`,
  `internal/ssh` and `internal/app/app.go`. Do not touch any of them, and do not wire this
  package into the composition root — the coordinator does that later.
- **No commit, no push, no branch, no `git stash`.** No repo-wide gates: scope every run to
  `go test ./internal/content/...`. No `gofumpt`/`prettier`. No `bd` commands.

## Report in `worker_done`

- The full method set you settled on for both repositories, so it can be checked without opening
  files.
- How you mirrored the three nullable TS fields, and why you chose that representation.
- Test count and the exact command.
- The literal output of `git diff --stat go.mod go.sum` (expected: empty).
- **Anything you could not verify, stated explicitly**, and anything you deliberately left alone.
